use crate::names::NoteFile;
use crate::frontmatter::{self, FrontMatter};
use crate::tasks::parse_tasks;
use crate::text::{extract_links, extract_tags, fold};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub mtime: i64,
    pub encrypted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    Modified,
    Title,
}

#[derive(Serialize)]
pub struct Page {
    pub hits: Vec<Hit>,
    pub has_more: bool,
    /// Notes the list shows across all pages; only computed for offset 0, else 0.
    pub total: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

pub struct Meta {
    /// milliseconds
    pub mtime: i64,
    pub size: u64,
    /// File birth time in ms; 0 when the platform has none.
    pub birth: i64,
}

/// Effective `(created, created_src, modified, modified_src)`: front matter wins, else file times
/// (created = min(birth, mtime)).
pub fn effective_dates(fm: Option<&FrontMatter>, m: &Meta) -> (i64, &'static str, i64, &'static str) {
    let file_created = if m.birth > 0 { m.birth.min(m.mtime) } else { m.mtime };
    let (c, cs) = fm.and_then(|f| f.created).map_or((file_created, "file"), |d| (d.timestamp_millis(), "frontmatter"));
    let (md, ms) = fm.and_then(|f| f.modified).map_or((m.mtime, "file"), |d| (d.timestamp_millis(), "frontmatter"));
    (c, cs, md, ms)
}

/// Body `#tags` plus front-matter `tags:` (one leading `#` stripped, invalid text ignored), same fold/display rules.
pub fn all_tags(body: &str, fm: Option<&FrontMatter>) -> Vec<(String, String)> {
    let mut out = extract_tags(body);
    let mut seen: HashSet<String> = out.iter().map(|(f, _)| f.clone()).collect();
    for raw in fm.map_or(&[][..], |f| &f.tags[..]) {
        let t = raw.trim();
        let t = t.strip_prefix('#').unwrap_or(t);
        let valid = t.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/')) && t.chars().any(char::is_alphabetic);
        if valid && seen.insert(fold(t)) {
            out.push((fold(t), t.to_string()));
        }
    }
    out
}

/// Bump to rebuild every index once (5: `Tags:` / `tags :` / `Aliases:` front-matter keys are read; 6: task code fences
/// close only on a matching fence, and a due/done date needs a boundary).
const SCHEMA_VERSION: i64 = 6;

pub struct Index {
    db: Connection,
}

/// After a bulk: FTS5 secure-delete back on, and FTS5's default merge settings, as before `begin_bulk`.
const SECURE_AGAIN: &str = "INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1); INSERT INTO notes_fts(notes_fts, rank) VALUES('automerge', 4); INSERT INTO notes_fts(notes_fts, rank) VALUES('crisismerge', 16);";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, title TEXT NOT NULL, title_folded TEXT NOT NULL,
  mtime INTEGER NOT NULL, size INTEGER NOT NULL, encrypted INTEGER NOT NULL, preview TEXT NOT NULL,
  created INTEGER NOT NULL, created_src TEXT NOT NULL, modified INTEGER NOT NULL, modified_src TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, body, tokenize="trigram remove_diacritics 1");
CREATE TABLE IF NOT EXISTS links(src TEXT NOT NULL, dst_folded TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags(path TEXT NOT NULL, tag_folded TEXT NOT NULL, tag_display TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aliases(path TEXT NOT NULL, alias_folded TEXT NOT NULL, alias_display TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS aliases_alias ON aliases(alias_folded);
CREATE INDEX IF NOT EXISTS aliases_path ON aliases(path);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag_folded);
CREATE INDEX IF NOT EXISTS tags_path ON tags(path);
CREATE INDEX IF NOT EXISTS notes_modified ON notes(modified);
CREATE INDEX IF NOT EXISTS notes_title ON notes(title_folded);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_folded);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
CREATE TABLE IF NOT EXISTS tasks(path TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL, due TEXT, done_on TEXT, line_text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_path ON tasks(path);
CREATE TABLE IF NOT EXISTS tasks_stale(path TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS notes_written AFTER INSERT ON notes BEGIN INSERT INTO tasks_stale(path) VALUES(new.path); END;
"#;

const DELETES: [&str; 6] = [
    "DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE path=?1)",
    "DELETE FROM notes WHERE path=?1",
    "DELETE FROM links WHERE src=?1",
    "DELETE FROM tags WHERE path=?1",
    "DELETE FROM aliases WHERE path=?1",
    "DELETE FROM tasks WHERE path=?1",
];

#[derive(Debug, Clone)]
pub struct TaskRow {
    pub path: String,
    pub title: String,
    pub modified: i64,
    pub line: usize,
    pub text: String,
    pub done: bool,
    pub due: Option<String>,
    pub done_on: Option<String>,
    pub line_text: String,
}

fn preview(title: &str, body: &str) -> String {
    let rest = match body.split_once('\n') {
        Some((first, rest)) if first.trim_end() == format!("# {title}") => rest,
        None if body.trim_end() == format!("# {title}") => "",
        _ => body,
    };
    rest.chars().take(120).collect()
}

/// ~12-word window around the first word containing `term` (folded); `fallback` when none does.
fn snippet(body: &str, term: &str, fallback: String) -> String {
    let words: Vec<&str> = body.split_whitespace().collect();
    let Some(i) = words.iter().position(|w| fold(w).contains(term)) else { return fallback };
    let start = i.saturating_sub(3);
    let end = (start + 12).min(words.len());
    format!("{}{}{}", if start > 0 { "…" } else { "" }, words[start..end].join(" "), if end < words.len() { "…" } else { "" })
}

fn like_escape(t: &str) -> String {
    t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn hit(r: &rusqlite::Row) -> rusqlite::Result<Hit> {
    Ok(Hit { path: r.get(0)?, title: r.get(1)?, snippet: r.get(2)?, mtime: r.get(3)?, encrypted: r.get(4)? })
}

impl Index {
    pub fn open(db_path: &Path) -> anyhow::Result<Index> {
        let db = Connection::open(db_path)?;
        // journal_mode returns a row, so read it instead of executing.
        let _: String = db.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        // rusqlite already sets busy_timeout to 5 s: a second connection (`velo --mcp` direct mode, a reopen) waits
        // out a batch chunk. journal_size_limit: an FTS merge can grow the WAL to ~76 MB; shrink it back when the WAL
        // restarts.
        db.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON; PRAGMA journal_size_limit=8388608;")?;
        // Older indexes lack tags, dates, aliases or tasks, or parsed front matter differently: drop them so the
        // vault's reconcile reindexes every note.
        // DROP, not DELETE: deleting every FTS5 row one by one took ~1 min at 10k notes.
        // A build without tasks (pre-0.7, after a downgrade) keeps this index but never updates `tasks`; the trigger in
        // SCHEMA marks its note writes in `tasks_stale` (this build's upsert clears its own marks), so rebuild then too.
        let old = db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? < SCHEMA_VERSION;
        db.execute_batch("CREATE TABLE IF NOT EXISTS tasks_stale(path TEXT NOT NULL);")?;
        if old || db.query_row("SELECT EXISTS(SELECT 1 FROM tasks_stale)", [], |r| r.get::<_, bool>(0))? {
            db.execute_batch(&format!("DROP TABLE IF EXISTS tasks_stale; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS aliases; PRAGMA user_version={SCHEMA_VERSION};"))?;
        }
        db.execute_batch(SCHEMA)?;
        let index = Index { db };
        if index.bulk_off() {
            // a bulk re-index was interrupted (crash, kill), or runs in another process: deleted text may sit in the
            // FTS segments. A failure (disk full) must not keep the vault closed: the next lock retries.
            index.finish_bulk();
        } else {
            index.end_bulk()?; // turns secure-delete on in a new index
        }
        Ok(index)
    }

    /// Before a bulk re-index: FTS5 'secure-delete' made replacing a note's row cost ~13 ms (it rewrites the leaves of
    /// every trigram of the old body: 135 s for 10k notes). Stored in the index, so a crash leaves it off for `end_bulk`.
    /// Writes are cut too (10k notes, chunks of 100: 2.2-3 GB; main 0.65 GB): FTS merging is off (the closing rebuild
    /// throws merged segments away), and this connection's WAL autocheckpoint waits for 16000 pages instead of 1000
    /// (each checkpoint copies pages that later chunks rewrite again). 64 MB caps the WAL: unbounded it reached ~300 MB,
    /// enough to fill a nearly full disk; the cap costs ~0.1 GB per 10k-note bulk.
    pub fn begin_bulk(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.room_for_bulk(), "too little free disk space for a bulk re-index");
        self.autocheckpoint(16000)?;
        Ok(self.db.execute_batch(
            "BEGIN IMMEDIATE; INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 0); INSERT INTO notes_fts(notes_fts, rank) VALUES('automerge', 0); INSERT INTO notes_fts(notes_fts, rank) VALUES('crisismerge', 1000); COMMIT;",
        ).inspect_err(|_| {
            _ = self.db.execute_batch("ROLLBACK");
            _ = self.autocheckpoint(1000);
        })?)
    }

    /// Turn FTS5 'secure-delete' on (FTS5 deletes otherwise leave old segments, all trigrams, in notes_fts_data). If it
    /// was off, anything deleted meanwhile (a bulk, or a lock or save during it, on any connection) is still in the
    /// segments: 'rebuild' the FTS index from the live rows (secure_delete zeroes the freed pages) and truncate the WAL.
    /// One write transaction, so a failed rebuild (disk full) leaves it off for the next open, and no other connection
    /// can turn it off between the read and the write.
    pub fn end_bulk(&self) -> anyhow::Result<()> {
        self.autocheckpoint(1000)?; // SQLite's default
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let off = (|| -> anyhow::Result<bool> {
            let off = self.db.query_row("SELECT v FROM notes_fts_config WHERE k='secure-delete'", [], |r| r.get::<_, i64>(0)).optional()? == Some(0);
            self.db.execute_batch(SECURE_AGAIN)?;
            if off {
                self.db.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');")?;
            }
            Ok(off)
        })()
        .inspect_err(|_| _ = self.db.execute_batch("ROLLBACK"))?;
        self.commit()?;
        if off {
            // shortcut: a reader (`velo --mcp`) makes this checkpoint a no-op, as on main; the next one copies the zeroed pages
            self.checkpoint()?;
        }
        Ok(())
    }

    /// `end_bulk` if a bulk left secure-delete off (interrupted, failed, or still running in another process); a
    /// failure is logged and retried by the next lock or open.
    pub fn finish_bulk(&self) {
        self.autocheckpoint(1000).ok(); // another connection may have ended this connection's bulk
        if self.bulk_off() && let Err(e) = self.end_bulk() {
            let msg = format!("velo: erasing deleted text from the search index failed, retried at the next lock: {e}");
            crate::log::line(&msg);
            eprintln!("{msg}"); // `velo --mcp` direct mode has no velo.log
        }
    }

    /// Space for a whole bulk: its WAL (64 MB cap, ~80 MB peak), then at its end the rebuild's WAL (about the index)
    /// and the checkpoint growing the file. Without it, a bulk could fill the disk, and its finish and a lock's
    /// checkpoint would fail and keep plaintext until there is room.
    fn room_for_bulk(&self) -> bool {
        let Some(path) = self.db.path().map(Path::new) else { return true };
        let need = (128 << 20) + 2 * std::fs::metadata(path).map_or(0, |m| m.len());
        free_space(path.parent().unwrap_or(path)).is_none_or(|free| free >= need)
    }

    fn autocheckpoint(&self, pages: i64) -> anyhow::Result<()> {
        self.db.query_row(&format!("PRAGMA wal_autocheckpoint={pages}"), [], |_| Ok(()))?;
        Ok(())
    }

    /// FTS secure-delete is stored off: a bulk runs (here or in another process) or was cut short.
    pub fn bulk_off(&self) -> bool {
        self.db.query_row("SELECT v = 0 FROM notes_fts_config WHERE k='secure-delete'", [], |r| r.get(0)).unwrap_or(false)
    }

    /// Fold the WAL into the main file and truncate it (no-op outside WAL mode).
    pub fn checkpoint(&self) -> anyhow::Result<()> {
        self.db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn known(&self) -> anyhow::Result<HashMap<String, Meta>> {
        let mut st = self.db.prepare("SELECT path, mtime, size FROM notes")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, Meta { mtime: r.get(1)?, size: r.get::<_, i64>(2)? as u64, birth: 0 })))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Group the following upserts/removes into one transaction until `commit`: one WAL append per batch, not
    /// per note. Each note keeps its own savepoint, so a note's SQL error rolls back that note alone; an error that
    /// aborts the transaction (disk full, I/O) loses the whole batch, and `in_batch` turns false.
    pub fn begin(&self) -> anyhow::Result<()> {
        Ok(self.db.execute_batch("BEGIN")?)
    }

    #[cfg(test)]
    pub(crate) fn raw(&self) -> &Connection {
        &self.db
    }

    /// A `begin` batch is open (false after an error aborted it).
    pub fn in_batch(&self) -> bool {
        !self.db.is_autocommit()
    }

    /// Commit a `begin` batch; on failure roll it back so the connection is usable (the next diff reindexes it).
    pub fn commit(&self) -> anyhow::Result<()> {
        self.db.execute_batch("COMMIT").inspect_err(|_| _ = self.db.execute_batch("ROLLBACK"))?;
        Ok(())
    }

    pub fn upsert(&mut self, path: &str, nf: &NoteFile, meta: &Meta, body: Option<&str>) -> anyhow::Result<()> {
        // A savepoint is its own transaction outside `begin`, and nests inside one.
        let tx = self.db.savepoint()?;
        for sql in DELETES {
            tx.execute(sql, [path])?;
        }
        // Locked notes: plaintext (and so front matter) never reaches SQLite; file dates only.
        let body = if nf.encrypted { None } else { body };
        let fm = body.and_then(frontmatter::parse);
        let text = body.map(frontmatter::body);
        let (created, created_src, modified, modified_src) = effective_dates(fm.as_ref(), meta);
        tx.execute(
            "INSERT INTO notes(path,title,title_folded,mtime,size,encrypted,preview,created,created_src,modified,modified_src) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![path, nf.title, fold(&nf.title), meta.mtime, meta.size as i64, nf.encrypted, text.map(|b| preview(&nf.title, b)).unwrap_or_default(), created, created_src, modified, modified_src],
        )?;
        if let Some(b) = text {
            // FTS rowid == notes.rowid so deletes and joins are rowid lookups, not scans.
            let rowid = tx.last_insert_rowid();
            tx.execute("INSERT INTO notes_fts(rowid, path, body) VALUES(?,?,?)", params![rowid, path, b])?;
            let dsts: HashSet<String> = extract_links(b).iter().map(|l| fold(l)).collect();
            for d in dsts {
                tx.execute("INSERT INTO links(src,dst_folded) VALUES(?,?)", params![path, d])?;
            }
            for (f, d) in all_tags(b, fm.as_ref()) {
                tx.execute("INSERT INTO tags(path,tag_folded,tag_display) VALUES(?,?,?)", params![path, f, d])?;
            }
            // Full text, not `b`: task line numbers must match the editor's.
            for t in parse_tasks(body.unwrap_or_default()) {
                tx.execute("INSERT INTO tasks(path,line,text,done,due,done_on,line_text) VALUES(?,?,?,?,?,?,?)", params![path, t.line as i64, t.text, t.done, t.due, t.done_on, t.line_text])?;
            }
            let mut seen = HashSet::new();
            for a in fm.iter().flat_map(|f| &f.aliases) {
                if seen.insert(fold(a)) {
                    tx.execute("INSERT INTO aliases(path,alias_folded,alias_display) VALUES(?,?,?)", params![path, fold(a), a])?;
                }
            }
        }
        tx.execute("DELETE FROM tasks_stale WHERE path=?1", [path])?; // our own insert: tasks are current
        Ok(tx.commit()?)
    }

    pub fn remove(&mut self, path: &str) -> anyhow::Result<()> {
        self.remove_with(path, false)
    }

    /// `remove` of text that must be erased now (a note being locked): FTS secure-delete is on for this delete even
    /// mid-bulk, and goes back off in the same transaction, so the bulk's own leftovers stay marked for `end_bulk`.
    pub fn remove_erasing(&mut self, path: &str) -> anyhow::Result<()> {
        self.remove_with(path, true)
    }

    fn remove_with(&mut self, path: &str, erase: bool) -> anyhow::Result<()> {
        // A secure delete against a bulk's unmerged segments took ~0.7 s per note at 10k (15 notes locked elsewhere: a
        // 10 s chunk), so end the bulk first (one rebuild, ~1 s) and the deletes are cheap. If that fails (disk full),
        // delete securely anyway and leave the bulk marked; unless the error lost the caller's batch, which redoes it.
        let batch = self.in_batch();
        let r = self.delete_rows(path, erase, erase);
        if r.is_err() && erase && self.in_batch() == batch {
            return self.delete_rows(path, true, false);
        }
        r
    }

    /// DELETES for `path`. `erase`: with FTS secure-delete on even mid-bulk, by `end` (ending the bulk) or by turning
    /// it on for this delete only, so the bulk stays marked for `end_bulk`.
    fn delete_rows(&mut self, path: &str, erase: bool, end: bool) -> anyhow::Result<()> {
        let tx = self.db.savepoint()?;
        // Read in the delete's own transaction: if another connection changes it first, the write below fails (busy
        // snapshot) instead of deleting with secure-delete off.
        let off = erase && tx.query_row("SELECT v = 0 FROM notes_fts_config WHERE k='secure-delete'", [], |r| r.get(0)).optional()?.unwrap_or(false);
        let toggle = off && !end;
        if off && end {
            tx.execute_batch(&format!("{SECURE_AGAIN} INSERT INTO notes_fts(notes_fts) VALUES('rebuild');"))?;
        }
        if toggle {
            tx.execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1);")?;
        }
        for sql in DELETES {
            tx.execute(sql, [path])?;
        }
        if toggle {
            tx.execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 0);")?;
        }
        Ok(tx.commit()?)
    }

    pub fn search_page(&self, query: &str, sort: Sort, offset: usize, limit: usize, tags: &[String], unlocked: &HashMap<String, String>) -> anyhow::Result<Page> {
        let folded = fold(query);
        let terms: Vec<&str> = folded.split_whitespace().collect();
        let order = match sort {
            Sort::Modified => "modified DESC, path ASC",
            Sort::Title => "title_folded ASC, path ASC",
        };
        let tags: Vec<String> = tags.iter().map(|t| fold(t)).collect();
        let tag_cond = |p: &str| tags.iter().map(|_| format!(" AND EXISTS (SELECT 1 FROM tags t WHERE t.path = {p}path AND t.tag_folded = ?)")).collect::<String>();
        let cols = "path, title, preview, modified, encrypted, title_folded, rowid";
        let esc: Vec<String> = terms.iter().map(|t| like_escape(t)).collect();
        let (union, args, long): (String, Vec<String>, Vec<usize>) = if terms.is_empty() {
            (format!("SELECT {cols}, 0 AS grp FROM notes WHERE 1{}", tag_cond("notes.")), tags.clone(), vec![])
        } else {
            // Title or any alias matches every term in `ts`; takes the terms' args twice (title, then alias).
            let cond = |p: &str, ts: &[usize]| {
                let like = |c: &str| ts.iter().map(|_| format!("{c} LIKE '%' || ? || '%' ESCAPE '\\'")).collect::<Vec<_>>().join(" AND ");
                format!("(({}) OR EXISTS (SELECT 1 FROM aliases a WHERE a.path = {p}path AND {}))", like(&format!("{p}title_folded")), like("a.alias_folded"))
            };
            let all: Vec<usize> = (0..terms.len()).collect();
            // Group 0: title matches.
            let mut sql = format!("SELECT {cols}, 0 AS grp FROM notes WHERE {}{}", cond("notes.", &all), tag_cond("notes."));
            let mut args = esc.clone();
            args.extend(esc.iter().cloned());
            args.extend(tags.iter().cloned());
            let (long, short): (Vec<usize>, Vec<usize>) = all.iter().partition(|&&i| terms[i].chars().count() >= 3);
            if !long.is_empty() {
                // Group 1: FTS matches that are not title matches.
                let m = long.iter().map(|&i| format!("\"{}\"", terms[i].replace('"', "\"\""))).collect::<Vec<_>>().join(" ");
                let short_cond: String = short.iter().map(|&i| format!(" AND {}", cond("n.", &[i]))).collect();
                sql += &format!(
                    " UNION ALL SELECT n.path, n.title, n.preview, n.modified, n.encrypted, n.title_folded, n.rowid, 1 AS grp \
                     FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?{short_cond} AND NOT ({}){}",
                    cond("n.", &all),
                    tag_cond("n.")
                );
                args.push(m);
                args.extend(short.iter().flat_map(|&i| [esc[i].clone(), esc[i].clone()]));
                args.extend(esc.iter().cloned());
                args.extend(esc.iter().cloned());
                args.extend(tags.iter().cloned());
            }
            (sql, args, long)
        };
        // Group 2: unlocked encrypted bodies (memory only, not in FTS), after every SQL row.
        let unlocked_hits = || -> Vec<(String, String, i64, Hit)> {
            let mut g2 = vec![];
            if !terms.is_empty() || !tags.is_empty() {
            let wanted: Vec<&str> = tags.iter().map(String::as_str).collect();
            for (path, plain) in unlocked {
                let row = self.db.query_row("SELECT title, title_folded, modified FROM notes WHERE path=?", [path], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
                });
                let Ok((title, tf, mtime)) = row else { continue };
                // Locked notes have no tags rows, so under a tag filter SQL never returned them.
                if tags.is_empty() && terms.iter().all(|t| tf.contains(t)) {
                    continue; // already a group 0 title hit
                }
                let plain_body = frontmatter::body(plain);
                let fm = frontmatter::parse(plain);
                let pf = fold(plain_body);
                let have: Vec<String> = if wanted.is_empty() { vec![] } else { all_tags(plain_body, fm.as_ref()).into_iter().map(|(f, _)| f).collect() }; // only needed under a tag filter
                if wanted.iter().all(|w| have.iter().any(|h| h == w)) && terms.iter().all(|t| tf.contains(t) || pf.contains(t)) {
                    g2.push((tf, path.clone(), mtime, Hit { path: path.clone(), title, snippet: plain_body.chars().take(120).collect(), mtime, encrypted: true }));
                }
            }
        }
            g2
        };
        // Empty query orders straight off the notes_mtime / notes_title indexes.
        let page_sql = format!("SELECT * FROM ({union}) ORDER BY grp, {order} LIMIT {} OFFSET {offset}", limit + 1);
        let mut st = self.db.prepare(&page_sql)?;
        let rows: Vec<(Hit, i64, i64)> = st
            .query_map(params_from_iter(args.iter()), |r| Ok((hit(r)?, r.get(6)?, r.get(7)?)))?
            .collect::<Result<_, _>>()?;
        let mut body_of = self.db.prepare("SELECT body FROM notes_fts WHERE rowid = ?")?;
        let mut hits = Vec::with_capacity(rows.len().min(limit));
        for (mut h, rowid, grp) in rows.into_iter() {
            // No FTS snippet(): it re-runs the MATCH per row. Read the body by rowid and cut the window in Rust.
            if grp == 1 && hits.len() < limit {
                let body: String = body_of.query_row([rowid], |r| r.get(0))?;
                h.snippet = snippet(&body, &terms[long[0]], std::mem::take(&mut h.snippet));
            }
            hits.push(h);
        }
        if hits.len() > limit {
            hits.truncate(limit);
            let total = if offset == 0 { self.sql_count(&union, &args)? + unlocked_hits().len() } else { 0 };
            return Ok(Page { hits, has_more: true, total });
        }

        let mut g2 = unlocked_hits();
        let sql_hits = hits.len();
        // Only offset 0 can be short of the full SQL set here, and then hits is all of it.
        let total = if offset == 0 { sql_hits + g2.len() } else { 0 };
        if g2.is_empty() {
            return Ok(Page { hits, has_more: false, total });
        }
        match sort {
            Sort::Modified => g2.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1))),
            Sort::Title => g2.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1))),
        }
        let sql_total = if hits.is_empty() && offset > 0 { self.sql_count(&union, &args)? } else { offset + hits.len() };
        let rest = g2.into_iter().skip(offset.saturating_sub(sql_total)).map(|g| g.3);
        hits.extend(rest.take(limit + 1 - hits.len()));
        let has_more = hits.len() > limit;
        hits.truncate(limit);
        Ok(Page { hits, has_more, total })
    }

    fn sql_count(&self, union: &str, args: &[String]) -> anyhow::Result<usize> {
        Ok(self.db.query_row(&format!("SELECT COUNT(*) FROM ({union})"), params_from_iter(args.iter()), |r| r.get::<_, i64>(0))? as usize)
    }

    pub fn tags(&self) -> anyhow::Result<Vec<TagCount>> {
        let mut st = self.db.prepare("SELECT MIN(tag_display), COUNT(DISTINCT path) FROM tags GROUP BY tag_folded ORDER BY tag_folded")?;
        Ok(st.query_map([], |r| Ok(TagCount { tag: r.get(0)?, count: r.get::<_, i64>(1)? as usize }))?.collect::<Result<_, _>>()?)
    }

    /// Task rows of notes carrying every tag in `tags` (same rule as `search_page`). Locked notes have none.
    pub fn task_rows(&self, tags: &[String]) -> anyhow::Result<Vec<TaskRow>> {
        let tags: Vec<String> = tags.iter().map(|t| fold(t)).collect();
        let cond: String = tags.iter().map(|_| " AND EXISTS (SELECT 1 FROM tags g WHERE g.path = t.path AND g.tag_folded = ?)").collect();
        let mut st = self.db.prepare(&format!(
            "SELECT t.path, n.title, n.modified, t.line, t.text, t.done, t.due, t.done_on, t.line_text FROM tasks t JOIN notes n ON n.path = t.path WHERE 1{cond}"
        ))?;
        let rows = st.query_map(params_from_iter(tags.iter()), |r| {
            Ok(TaskRow { path: r.get(0)?, title: r.get(1)?, modified: r.get(2)?, line: r.get::<_, i64>(3)? as usize, text: r.get(4)?, done: r.get(5)?, due: r.get(6)?, done_on: r.get(7)?, line_text: r.get(8)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn title_modified(&self, path: &str) -> anyhow::Result<Option<(String, i64)>> {
        Ok(self.db.query_row("SELECT title, modified FROM notes WHERE path=?", [path], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }

    pub fn find_title(&self, title: &str) -> anyhow::Result<Option<String>> {
        Ok(self.find_titles(title)?.into_iter().next())
    }

    /// Every note `title` names: title matches first, then aliases.
    pub fn find_titles(&self, title: &str) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT path FROM notes WHERE title_folded=?1 UNION ALL SELECT path FROM aliases WHERE alias_folded=?1")?;
        Ok(st.query_map([fold(title)], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    pub fn titles(&self) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT title FROM notes UNION ALL SELECT alias_display FROM aliases")?;
        Ok(st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    /// Display spellings of one note's tags (front matter and inline).
    pub fn tags_of(&self, path: &str) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT tag_display FROM tags WHERE path=?")?;
        Ok(st.query_map([path], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    pub fn backlinks(&self, title: &str) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT DISTINCT src FROM links WHERE dst_folded=? ORDER BY src")?;
        Ok(st.query_map([fold(title)], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }
}

#[cfg(unix)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize as u64)
}

// shortcut: no free-space check on Windows (bulks always run), add GetDiskFreeSpaceExW if full disks show up there
#[cfg(not(unix))]
fn free_space(_: &Path) -> Option<u64> {
    None
}

/// A bulk cut short (the app switched vaults mid-rescan) ends here, not at this index's next open, which may never come.
impl Drop for Index {
    fn drop(&mut self) {
        self.finish_bulk();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::names::NoteFile;
    use std::collections::HashMap;

    fn idx(notes: &[(&str, &str, i64)]) -> Index {
        let mut i = Index::open(std::path::Path::new(":memory:")).unwrap();
        for (p, body, m) in notes {
            let title = p.strip_suffix(".md").unwrap_or(p).to_string();
            let nf = NoteFile { title, encrypted: false };
            i.upsert(p, &nf, &Meta { mtime: *m, size: body.len() as u64, birth: 0 }, Some(body)).unwrap();
        }
        i
    }

    fn idx_owned(notes: &[(String, String, i64)]) -> Index {
        let v: Vec<(&str, &str, i64)> = notes.iter().map(|(p, b, m)| (p.as_str(), b.as_str(), *m)).collect();
        idx(&v)
    }
    fn paths(i: &Index, q: &str, sort: Sort, off: usize, lim: usize, u: &HashMap<String, String>) -> Vec<String> {
        i.search_page(q, sort, off, lim, &[], u).unwrap().hits.into_iter().map(|h| h.path).collect()
    }

    #[test] fn title_sort_orders_groups_az() {
        let i = idx(&[("b garden.md", "", 3), ("a garden.md", "", 1), ("zz.md", "garden plan", 5), ("yy.md", "garden", 9)]);
        assert_eq!(paths(&i, "garden", Sort::Title, 0, 10, &HashMap::new()), vec!["a garden.md", "b garden.md", "yy.md", "zz.md"]);
    }
    #[test] fn paging_covers_all_without_dupes() {
        let notes: Vec<(String, String, i64)> = (0..450).map(|n| (format!("n{n:03}.md"), String::new(), n)).collect();
        let i = idx_owned(&notes);
        for sort in [Sort::Modified, Sort::Title] {
            let mut all = vec![]; let mut off = 0;
            loop { let pg = i.search_page("", sort, off, 200, &[], &HashMap::new()).unwrap(); off += pg.hits.len(); all.extend(pg.hits.into_iter().map(|h| h.path)); if !pg.has_more { break } }
            assert_eq!(all.len(), 450); let set: HashSet<_> = all.iter().collect(); assert_eq!(set.len(), 450);
        }
    }
    #[test] fn paging_across_groups_matches_single_page() {
        let mut notes: Vec<(String, String, i64)> = (0..7).map(|n| (format!("g{n} cat.md"), String::new(), n)).collect();
        notes.extend((0..7).map(|n| (format!("b{n}.md"), "a cat naps".into(), 10 + n)));
        let i = idx_owned(&notes);
        for sort in [Sort::Modified, Sort::Title] {
            let full = paths(&i, "cat", sort, 0, 50, &HashMap::new());
            assert_eq!(full.len(), 14);
            let mut got = vec![]; let mut off = 0;
            loop { let pg = i.search_page("cat", sort, off, 3, &[], &HashMap::new()).unwrap(); off += pg.hits.len(); got.extend(pg.hits.into_iter().map(|h| h.path)); if !pg.has_more { break } }
            assert_eq!(got, full);
        }
    }
    #[test] fn title_sort_is_fold_insensitive() { let i = idx(&[("Zeta.md", "", 3), ("éclair.md", "", 2), ("apple.md", "", 1)]);
        let p: Vec<_> = i.search_page("", Sort::Title, 0, 10, &[], &HashMap::new()).unwrap().hits.into_iter().map(|h| h.title).collect();
        assert_eq!(p, vec!["apple", "éclair", "Zeta"]); }
    #[test] fn unlocked_body_matches_appended_last() {
        let mut i = idx(&[("secret a.md", "", 1), ("secret b.md", "", 2)]);
        i.upsert("e.md.age", &NoteFile { title: "e".into(), encrypted: true }, &Meta { mtime: 99, size: 1, birth: 0 }, None).unwrap();
        let u = HashMap::from([("e.md.age".to_string(), "my secret".to_string())]);
        for sort in [Sort::Modified, Sort::Title] {
            assert_eq!(paths(&i, "secret", sort, 0, 10, &u).last().unwrap(), "e.md.age");
            let p0 = i.search_page("secret", sort, 0, 2, &[], &u).unwrap();
            assert_eq!(p0.hits.len(), 2); assert!(p0.has_more); assert!(p0.hits.iter().all(|h| h.path != "e.md.age"));
            let p1 = i.search_page("secret", sort, 2, 2, &[], &u).unwrap();
            assert_eq!(p1.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), vec!["e.md.age"]); assert!(!p1.has_more);
            assert_eq!(paths(&i, "secret", sort, 3, 2, &u), Vec::<String>::new());
        }
    }
    #[test] fn title_hits_before_body_hits_then_mtime() {
        let i = idx(&[("a.md", "nothing", 1), ("garden.md", "x", 2), ("b.md", "my garden plan", 3), ("garden2.md", "y", 4)]);
        let p: Vec<_> = i.search_page("garden", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.into_iter().map(|h| h.path).collect();
        assert_eq!(p, vec!["garden2.md", "garden.md", "b.md"]);
    }
    #[test] fn substring_and_diacritics() { let i = idx(&[("Résumé.md", "", 1), ("x.md", "café crème", 2)]);
        assert_eq!(i.search_page("sum", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits[0].path, "Résumé.md");
        assert_eq!(i.search_page("cafe", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits[0].path, "x.md"); }
    #[test] fn short_query_titles_only() { let i = idx(&[("ab.md", "", 1), ("x.md", "ab ab ab", 2)]);
        assert_eq!(i.search_page("ab", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.len(), 1); }
    #[test] fn multi_word_all_terms() { let i = idx(&[("x.md", "red apple", 1), ("y.md", "red car", 2)]);
        assert_eq!(i.search_page("apple red", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.iter().map(|h| &h.path).collect::<Vec<_>>(), vec!["x.md"]); }
    #[test] fn search_metacharacters_literal() { let i = idx(&[("100%.md", "a \"quoted\" NEAR (x) -y *z", 1)]);
        for q in ["\"", "%", "_", "*", "-y", "NEAR", "(x)", "\"quoted\"", "100%"] { assert!(i.search_page(q, Sort::Modified, 0, 10, &[], &HashMap::new()).is_ok(), "{q}"); }
        assert_eq!(i.search_page("100%", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.len(), 1);
        assert_eq!(i.search_page("_", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.len(), 0); }
    #[test] fn encrypted_body_not_indexed_unless_unlocked() {
        let mut i = idx(&[]); i.upsert("s.md.age", &NoteFile { title: "s".into(), encrypted: true }, &Meta { mtime: 1, size: 1, birth: 0 }, None).unwrap();
        assert!(i.search_page("secretword", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.is_empty());
        let u = HashMap::from([("s.md.age".to_string(), "the secretword".to_string())]);
        assert_eq!(i.search_page("secretword", Sort::Modified, 0, 10, &[], &u).unwrap().hits[0].path, "s.md.age"); }
    #[test] fn backlinks_and_find_title() { let i = idx(&[("a.md", "see [[Target Note]]", 1), ("Target Note.md", "", 2)]);
        assert_eq!(i.backlinks("target note").unwrap(), vec!["a.md"]);
        assert_eq!(i.find_title("TARGET NOTE").unwrap().as_deref(), Some("Target Note.md")); }
    #[test] fn titles_lists_all_incl_encrypted() { let mut i = idx(&[("a.md", "", 1), ("B c.md", "", 2)]);
        i.upsert("s.md.age", &NoteFile { title: "s".into(), encrypted: true }, &Meta { mtime: 1, size: 1, birth: 0 }, None).unwrap();
        let mut t = i.titles().unwrap(); t.sort();
        assert_eq!(t, vec!["B c", "a", "s"]); }
    #[test] fn tags_listed_with_counts_and_filter_is_and() {
        let i = idx(&[("a.md", "#work #idea", 1), ("b.md", "#work", 2), ("c.md", "nothing", 3)]);
        assert_eq!(i.tags().unwrap(), vec![TagCount { tag: "idea".into(), count: 1 }, TagCount { tag: "work".into(), count: 2 }]);
        let p = |tags: &[&str]| i.search_page("", Sort::Title, 0, 10, &tags.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &HashMap::new()).unwrap().hits.into_iter().map(|h| h.path).collect::<Vec<_>>();
        assert_eq!(p(&["work"]), vec!["a.md", "b.md"]); assert_eq!(p(&["work", "IDEA"]), vec!["a.md"]); assert_eq!(p(&[]).len(), 3);
    }
    #[test] fn tag_filter_combines_with_query_groups() {
        let i = idx(&[("t1 plan.md", "#t", 1), ("t2 plan.md", "no tag", 2), ("b1.md", "my plan #t", 3), ("b2.md", "my plan", 4), ("b3.md", "plan #T", 5)]);
        let got: Vec<_> = i.search_page("plan", Sort::Title, 0, 10, &["t".to_string()], &HashMap::new()).unwrap().hits.into_iter().map(|h| h.path).collect();
        assert_eq!(got, vec!["t1 plan.md", "b1.md", "b3.md"]);
    }
    #[test] fn unlocked_note_matches_tag_filter_in_memory() {
        let mut i = idx(&[]);
        i.upsert("e.md.age", &NoteFile { title: "e".into(), encrypted: true }, &Meta { mtime: 1, size: 1, birth: 0 }, None).unwrap();
        let u = HashMap::from([("e.md.age".to_string(), "x #Sec".to_string())]);
        assert!(i.tags().unwrap().is_empty());
        for q in ["", "x"] {
            assert_eq!(i.search_page(q, Sort::Title, 0, 10, &["sec".to_string()], &u).unwrap().hits.len(), 1, "{q}");
            assert!(i.search_page(q, Sort::Title, 0, 10, &["other".to_string()], &u).unwrap().hits.is_empty());
        }
    }
    #[test] fn total_counts_all_pages() {
        let notes: Vec<(String, String, i64)> = (0..120).map(|n| (format!("n{n:03}.md"), "x".into(), n)).collect();
        let i = idx_owned(&notes);
        let pg = |off| i.search_page("", Sort::Title, off, 50, &[], &HashMap::new()).unwrap();
        assert_eq!(pg(0).total, 120); assert_eq!(pg(50).total, 0); assert_eq!(pg(100).total, 0);
        assert_eq!(i.search_page("", Sort::Title, 0, 200, &[], &HashMap::new()).unwrap().total, 120);
    }
    #[test] fn total_respects_tags_and_query() {
        let i = idx(&[("plan a.md", "#t plan", 1), ("b.md", "my plan #t", 2), ("c.md", "my plan", 3), ("d.md", "#t", 4)]);
        let tot = |q: &str, tags: &[&str], lim| i.search_page(q, Sort::Title, 0, lim, &tags.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &HashMap::new()).unwrap().total;
        // "plan a" matches title and body: counted once
        for lim in [1, 10] { assert_eq!(tot("plan", &[], lim), 3); assert_eq!(tot("plan", &["t"], lim), 2); assert_eq!(tot("", &["t"], lim), 3); assert_eq!(tot("zzzz", &[], lim), 0); }
    }
    #[test] fn total_includes_unlocked_locked_notes() {
        let mut i = idx(&[("secret a.md", "", 1), ("secret b.md", "", 2)]);
        i.upsert("e.md.age", &NoteFile { title: "secret e".into(), encrypted: true }, &Meta { mtime: 99, size: 1, birth: 0 }, None).unwrap();
        i.upsert("f.md.age", &NoteFile { title: "f".into(), encrypted: true }, &Meta { mtime: 98, size: 1, birth: 0 }, None).unwrap();
        let u = HashMap::from([("e.md.age".to_string(), "my secret".to_string()), ("f.md.age".to_string(), "my secret".to_string())]);
        for lim in [1, 2, 10] { assert_eq!(i.search_page("secret", Sort::Title, 0, lim, &[], &u).unwrap().total, 4, "{lim}"); }
        assert_eq!(i.search_page("secret", Sort::Title, 0, 10, &[], &HashMap::new()).unwrap().total, 3);
    }
    #[test] fn upsert_fills_tasks_and_remove_clears() {
        let mut i = idx(&[("a.md", "# a\n- [ ] one\n- [x] two ✅ 2026-10-20\n", 1)]);
        let r = i.task_rows(&[]).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].line, r[0].text.as_str(), r[0].line_text.as_str()), (1, "one", "- [ ] one"));
        i.remove("a.md").unwrap();
        assert!(i.task_rows(&[]).unwrap().is_empty());
    }
    #[test] fn task_rows_filter_by_tags() {
        let i = idx(&[("a.md", "#work\n- [ ] one", 1), ("b.md", "- [ ] two", 2)]);
        assert_eq!(i.task_rows(&["Work".into()]).unwrap().len(), 1);
        assert_eq!(i.task_rows(&[]).unwrap().len(), 2);
    }
    #[test] fn schema_v3_db_is_rebuilt() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("- [ ] t")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=3").unwrap();
        let mut i = Index::open(&db).unwrap(); assert!(i.known().unwrap().is_empty()); assert!(i.task_rows(&[]).unwrap().is_empty());
        assert_eq!(i.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("- [ ] t")).unwrap();
        assert_eq!(i.task_rows(&[]).unwrap().len(), 1);
    }
    /// v5: `Tags:` / `tags :` / `Aliases:` are read now, so notes indexed by v4 must be parsed again once.
    #[test] fn schema_v4_db_is_rebuilt() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("x")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=4").unwrap();
        assert!(Index::open(&db).unwrap().known().unwrap().is_empty());
    }
    /// v6: task rows parsed by v5 used the old fence and date rules.
    #[test] fn schema_v5_db_is_rebuilt() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("- [ ] t")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=5").unwrap();
        let i = Index::open(&db).unwrap(); assert!(i.known().unwrap().is_empty(), "reconcile reparses every note");
        assert_eq!(i.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
    }
    #[test] fn a_write_by_a_build_without_tasks_rebuilds_the_index() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let nf = NoteFile { title: "a".into(), encrypted: false };
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &nf, &Meta { mtime: 1, size: 1, birth: 0 }, Some("- [ ] t")).unwrap(); drop(i);
        assert_eq!(Index::open(&db).unwrap().known().unwrap().len(), 1, "this build's own writes keep the index");
        // a pre-0.7 build edits the note: same deletes and insert as its upsert, tasks untouched
        Connection::open(&db).unwrap().execute_batch("DELETE FROM notes WHERE path='a.md'; INSERT INTO notes(path,title,title_folded,mtime,size,encrypted,preview,created,created_src,modified,modified_src) VALUES('a.md','a','a',2,1,0,'',2,'file',2,'file');").unwrap();
        let i = Index::open(&db).unwrap();
        assert!(i.known().unwrap().is_empty() && i.task_rows(&[]).unwrap().is_empty(), "rebuilt: reconcile reindexes every note");
    }
    #[test] fn schema_upgrade_reindexes() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("#x")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=2").unwrap();
        let i = Index::open(&db).unwrap(); assert!(i.known().unwrap().is_empty()); assert!(i.tags().unwrap().is_empty());
        assert_eq!(i.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        let mut i = i; i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("#x")).unwrap(); drop(i);
        assert_eq!(Index::open(&db).unwrap().known().unwrap().len(), 1);
    }
    #[test] fn remove_clears_all_tables() { let mut i = idx(&[("a.md", "see [[B]] zebra", 1)]); i.remove("a.md").unwrap();
        assert!(i.search_page("zebra", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.is_empty()); assert!(i.backlinks("b").unwrap().is_empty()); }
    #[test] fn upsert_replaces_and_remove_drops_tags() { let mut i = idx(&[("a.md", "#one", 1)]);
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 2, size: 1, birth: 0 }, Some("#two")).unwrap();
        assert_eq!(i.tags().unwrap()[0].tag, "two"); assert_eq!(i.tags().unwrap().len(), 1);
        i.remove("a.md").unwrap(); assert!(i.tags().unwrap().is_empty()); }
    const FM: &str = "---\ncreated: 2020-01-02T03:04:05+00:00\nmodified: 2021-06-07T08:09:10+00:00\ntags: [Work, \"#Idea\"]\naliases: [Nick, Other]\n---\nbody zebra\n";
    fn row(i: &Index, p: &str) -> (i64, String, i64, String) {
        i.db.query_row("SELECT created, created_src, modified, modified_src FROM notes WHERE path=?", [p], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
    }
    #[test] fn frontmatter_dates_win_and_file_fallback() {
        let mut i = idx(&[("a.md", FM, 5000), ("b.md", "plain", 7000)]);
        assert_eq!(row(&i, "a.md"), (1577934245000, "frontmatter".into(), 1623053350000, "frontmatter".into()));
        assert_eq!(row(&i, "b.md"), (7000, "file".into(), 7000, "file".into()));
        // birth earlier than mtime wins; later birth is ignored
        let nf = NoteFile { title: "b".into(), encrypted: false };
        i.upsert("b.md", &nf, &Meta { mtime: 7000, size: 1, birth: 100 }, Some("x")).unwrap(); assert_eq!(row(&i, "b.md").0, 100);
        i.upsert("b.md", &nf, &Meta { mtime: 7000, size: 1, birth: 9000 }, Some("x")).unwrap(); assert_eq!(row(&i, "b.md").0, 7000);
    }
    #[test] fn frontmatter_not_searchable_and_not_in_snippet() {
        let i = idx(&[("a.md", FM, 1)]);
        assert!(i.search_page("2020-01-02", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.is_empty());
        let h = &i.search_page("", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits[0];
        assert_eq!(h.snippet, "body zebra\n"); assert_eq!(h.mtime, 1623053350000);
        let h = &i.search_page("zebra", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits[0];
        assert_eq!(h.snippet, "body zebra");
    }
    #[test] fn frontmatter_tags_merge() {
        let i = idx(&[("a.md", &format!("{FM}#work #more"), 1)]);
        assert_eq!(i.tags().unwrap().iter().map(|t| t.tag.as_str()).collect::<Vec<_>>(), vec!["Idea", "more", "work"]);
    }
    #[test] fn aliases_count_as_titles() {
        let i = idx(&[("a.md", FM, 1), ("b.md", "x", 2)]);
        assert_eq!(i.find_title("NICK").unwrap().as_deref(), Some("a.md"));
        assert!(i.titles().unwrap().contains(&"Nick".to_string()));
        let h = i.search_page("nic", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap();
        assert_eq!(h.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), vec!["a.md"]);
        let j = idx(&[("c.md", "nick nick", 9), ("a.md", FM, 1)]);
        assert_eq!(paths(&j, "nick", Sort::Modified, 0, 10, &HashMap::new()), vec!["a.md", "c.md"]);
    }
    #[test] fn recent_sort_uses_effective_modified() {
        let i = idx(&[("old.md", FM, 99999999999999), ("new.md", "x", 1623053350001)]);
        assert_eq!(paths(&i, "", Sort::Modified, 0, 10, &HashMap::new()), vec!["new.md", "old.md"]);
    }
    #[test] fn locked_note_gets_file_dates_only() {
        let mut i = idx(&[]);
        i.upsert("e.md.age", &NoteFile { title: "e".into(), encrypted: true }, &Meta { mtime: 5, size: 1, birth: 0 }, Some(FM)).unwrap();
        assert_eq!(row(&i, "e.md.age"), (5, "file".into(), 5, "file".into()));
        assert!(i.titles().unwrap().iter().all(|t| t != "Nick"));
    }
    fn dump(i: &Index) -> Vec<String> {
        let q = ["SELECT rowid,* FROM notes", "SELECT rowid,path,body FROM notes_fts", "SELECT * FROM links", "SELECT * FROM tags", "SELECT * FROM aliases", "SELECT * FROM tasks"];
        q.iter().flat_map(|sql| {
            let mut st = i.db.prepare(&format!("{sql} ORDER BY 1,2")).unwrap();
            let n = st.column_count();
            st.query_map([], |r| Ok((0..n).map(|c| format!("{:?}", r.get_ref(c).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(|r| r.unwrap()).collect::<Vec<_>>()
        }).collect()
    }
    const NOTES: [(&str, &str, i64); 4] = [("a.md", "see [[B]] #t\n- [ ] do @due(2026-01-02)", 1), ("B.md", FM, 2), ("c.md", "zebra [[a]]", 3), ("gone.md", "x", 4)];
    #[test] fn batched_build_matches_per_note() {
        let mut one = idx(&NOTES);
        one.remove("gone.md").unwrap();
        let mut batch = idx(&[]);
        batch.begin().unwrap();
        for (p, body, m) in NOTES {
            let nf = NoteFile { title: p.trim_end_matches(".md").into(), encrypted: false };
            batch.upsert(p, &nf, &Meta { mtime: m, size: body.len() as u64, birth: 0 }, Some(body)).unwrap();
        }
        batch.remove("gone.md").unwrap();
        batch.commit().unwrap();
        assert_eq!(stale_marks(&batch), 0);
        assert!(dump(&one).len() > 8);
        assert_eq!(dump(&one), dump(&batch));
    }
    fn stale_marks(i: &Index) -> i64 { i.db.query_row("SELECT COUNT(*) FROM tasks_stale", [], |r| r.get(0)).unwrap() }
    #[test] fn failing_note_in_batch_rolls_back_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("index.db");
        let mut i = Index::open(&db).unwrap();
        let nf = |t: &str| NoteFile { title: t.into(), encrypted: false };
        i.upsert("bad.md", &nf("bad"), &Meta { mtime: 1, size: 1, birth: 0 }, Some("old zebra")).unwrap();
        // Fails after the notes insert, so the stale-mark trigger has already fired for bad.md.
        i.db.execute_batch("CREATE TEMP TRIGGER boom BEFORE INSERT ON links WHEN NEW.src='bad.md' BEGIN SELECT RAISE(ABORT,'boom'); END;").unwrap();
        i.begin().unwrap();
        i.upsert("a.md", &nf("a"), &Meta { mtime: 1, size: 1, birth: 0 }, Some("alpha")).unwrap();
        assert!(i.upsert("bad.md", &nf("bad"), &Meta { mtime: 2, size: 1, birth: 0 }, Some("new [[x]]")).is_err());
        i.upsert("c.md", &nf("c"), &Meta { mtime: 3, size: 1, birth: 0 }, Some("gamma")).unwrap();
        i.commit().unwrap();
        let k = i.known().unwrap();
        assert_eq!((k.len(), k["bad.md"].mtime), (3, 1)); // bad.md keeps its old row
        assert_eq!(paths(&i, "zebra", Sort::Title, 0, 10, &HashMap::new()), vec!["bad.md"]);
        assert_eq!(stale_marks(&i), 0); // the rolled-back mark is gone too
        drop(i);
        assert_eq!(Index::open(&db).unwrap().known().unwrap().len(), 3); // reopen keeps the index: no rebuild
    }
    /// Re-indexing runs every DELETE once per note: a scan instead of an index search is O(notes²) over a rescan.
    #[test] fn note_deletes_search_an_index() {
        let i = idx(&[]);
        for sql in DELETES {
            let mut st = i.db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let plan: Vec<String> = st.query_map(["x"], |r| r.get(3)).unwrap().map(Result::unwrap).collect();
            // FTS5 by rowid shows as a virtual-table scan with an equality constraint on the rowid.
            assert!(plan.iter().all(|p| !p.starts_with("SCAN ") || p.contains("VIRTUAL TABLE INDEX 0:=")), "{sql}: {plan:?}");
        }
    }
    #[test] fn second_connection_waits_for_a_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("index.db");
        let (mut a, mut b) = (Index::open(&db).unwrap(), Index::open(&db).unwrap());
        let nf = |t: &str| NoteFile { title: t.into(), encrypted: false };
        let meta = Meta { mtime: 1, size: 1, birth: 0 };
        a.begin().unwrap();
        a.upsert("a.md", &nf("a"), &meta, Some("alpha")).unwrap();
        let t = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            a.commit().unwrap();
        });
        b.upsert("b.md", &nf("b"), &meta, Some("beta")).unwrap(); // "database is locked" with busy_timeout 0
        t.join().unwrap();
        assert_eq!(b.known().unwrap().len(), 2);
    }
}
