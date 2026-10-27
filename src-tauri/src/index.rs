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

pub struct Index {
    db: Connection,
}

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
        db.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON;")?;
        // Older indexes lack tags, dates, aliases or tasks: drop them so the vault's reconcile reindexes every note.
        // DROP, not DELETE: deleting every FTS5 row one by one took ~1 min at 10k notes.
        if db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? < 4 {
            db.execute_batch("DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS aliases; PRAGMA user_version=4;")?;
        }
        db.execute_batch(SCHEMA)?;
        // FTS5 deletes otherwise leave old segments (all trigrams) in notes_fts_data.
        db.execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1);")?;
        Ok(Index { db })
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

    pub fn upsert(&mut self, path: &str, nf: &NoteFile, meta: &Meta, body: Option<&str>) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
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
        Ok(tx.commit()?)
    }

    pub fn remove(&mut self, path: &str) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        for sql in DELETES {
            tx.execute(sql, [path])?;
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
        let mut st = self.db.prepare("SELECT path FROM notes WHERE title_folded=?1 UNION ALL SELECT path FROM aliases WHERE alias_folded=?1 LIMIT 1")?;
        Ok(st.query_map([fold(title)], |r| r.get(0))?.next().transpose()?)
    }

    pub fn titles(&self) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT title FROM notes UNION ALL SELECT alias_display FROM aliases")?;
        Ok(st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    pub fn backlinks(&self, title: &str) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT DISTINCT src FROM links WHERE dst_folded=? ORDER BY src")?;
        Ok(st.query_map([fold(title)], |r| r.get(0))?.collect::<Result<_, _>>()?)
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
    #[test] fn schema_v3_db_is_rebuilt_as_v4() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("- [ ] t")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=3").unwrap();
        let mut i = Index::open(&db).unwrap(); assert!(i.known().unwrap().is_empty()); assert!(i.task_rows(&[]).unwrap().is_empty());
        assert_eq!(i.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("- [ ] t")).unwrap();
        assert_eq!(i.task_rows(&[]).unwrap().len(), 1);
    }
    #[test] fn schema_upgrade_reindexes() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1, birth: 0 }, Some("#x")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=2").unwrap();
        let i = Index::open(&db).unwrap(); assert!(i.known().unwrap().is_empty()); assert!(i.tags().unwrap().is_empty());
        assert_eq!(i.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
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
}
