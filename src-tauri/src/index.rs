use crate::names::NoteFile;
use crate::text::{extract_links, extract_tags, fold};
use rusqlite::{Connection, params, params_from_iter};
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
}

pub struct Index {
    db: Connection,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, title TEXT NOT NULL, title_folded TEXT NOT NULL,
  mtime INTEGER NOT NULL, size INTEGER NOT NULL, encrypted INTEGER NOT NULL, preview TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, body, tokenize="trigram remove_diacritics 1");
CREATE TABLE IF NOT EXISTS links(src TEXT NOT NULL, dst_folded TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tags(path TEXT NOT NULL, tag_folded TEXT NOT NULL, tag_display TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag_folded);
CREATE INDEX IF NOT EXISTS tags_path ON tags(path);
CREATE INDEX IF NOT EXISTS notes_mtime ON notes(mtime);
CREATE INDEX IF NOT EXISTS notes_title ON notes(title_folded);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_folded);
CREATE INDEX IF NOT EXISTS links_src ON links(src);
"#;

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
        db.execute_batch(SCHEMA)?;
        // FTS5 deletes otherwise leave old segments (all trigrams) in notes_fts_data.
        db.execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1);")?;
        // Older indexes lack tags: clear them so the vault's reconcile reindexes every note.
        if db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? < 2 {
            db.execute_batch("DELETE FROM notes_fts; DELETE FROM notes; DELETE FROM links; DELETE FROM tags; PRAGMA user_version=2;")?;
        }
        Ok(Index { db })
    }

    /// Fold the WAL into the main file and truncate it (no-op outside WAL mode).
    pub fn checkpoint(&self) -> anyhow::Result<()> {
        self.db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn known(&self) -> anyhow::Result<HashMap<String, Meta>> {
        let mut st = self.db.prepare("SELECT path, mtime, size FROM notes")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, Meta { mtime: r.get(1)?, size: r.get::<_, i64>(2)? as u64 })))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn upsert(&mut self, path: &str, nf: &NoteFile, meta: &Meta, body: Option<&str>) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        for sql in ["DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE path=?1)", "DELETE FROM notes WHERE path=?1", "DELETE FROM links WHERE src=?1", "DELETE FROM tags WHERE path=?1"] {
            tx.execute(sql, [path])?;
        }
        let body = if nf.encrypted { None } else { body };
        tx.execute(
            "INSERT INTO notes(path,title,title_folded,mtime,size,encrypted,preview) VALUES(?,?,?,?,?,?,?)",
            params![path, nf.title, fold(&nf.title), meta.mtime, meta.size as i64, nf.encrypted, body.map(|b| preview(&nf.title, b)).unwrap_or_default()],
        )?;
        if let Some(b) = body {
            // FTS rowid == notes.rowid so deletes and joins are rowid lookups, not scans.
            let rowid = tx.last_insert_rowid();
            tx.execute("INSERT INTO notes_fts(rowid, path, body) VALUES(?,?,?)", params![rowid, path, b])?;
            let dsts: HashSet<String> = extract_links(b).iter().map(|l| fold(l)).collect();
            for d in dsts {
                tx.execute("INSERT INTO links(src,dst_folded) VALUES(?,?)", params![path, d])?;
            }
            for (f, d) in extract_tags(b) {
                tx.execute("INSERT INTO tags(path,tag_folded,tag_display) VALUES(?,?,?)", params![path, f, d])?;
            }
        }
        Ok(tx.commit()?)
    }

    pub fn remove(&mut self, path: &str) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        for sql in ["DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE path=?1)", "DELETE FROM notes WHERE path=?1", "DELETE FROM links WHERE src=?1", "DELETE FROM tags WHERE path=?1"] {
            tx.execute(sql, [path])?;
        }
        Ok(tx.commit()?)
    }

    pub fn search_page(&self, query: &str, sort: Sort, offset: usize, limit: usize, tags: &[String], unlocked: &HashMap<String, String>) -> anyhow::Result<Page> {
        let folded = fold(query);
        let terms: Vec<&str> = folded.split_whitespace().collect();
        let order = match sort {
            Sort::Modified => "mtime DESC, path ASC",
            Sort::Title => "title_folded ASC, path ASC",
        };
        let tags: Vec<String> = tags.iter().map(|t| fold(t)).collect();
        let tag_cond = |p: &str| tags.iter().map(|_| format!(" AND EXISTS (SELECT 1 FROM tags t WHERE t.path = {p}path AND t.tag_folded = ?)")).collect::<String>();
        let cols = "path, title, preview, mtime, encrypted, title_folded, rowid";
        let esc: Vec<String> = terms.iter().map(|t| like_escape(t)).collect();
        let (union, args, long): (String, Vec<String>, Vec<usize>) = if terms.is_empty() {
            (format!("SELECT {cols}, 0 AS grp FROM notes WHERE 1{}", tag_cond("notes.")), tags.clone(), vec![])
        } else {
            let cond = |p: &str, ts: &[usize]| ts.iter().map(|_| format!("{p}title_folded LIKE '%' || ? || '%' ESCAPE '\\'")).collect::<Vec<_>>().join(" AND ");
            let all: Vec<usize> = (0..terms.len()).collect();
            // Group 0: title matches.
            let mut sql = format!("SELECT {cols}, 0 AS grp FROM notes WHERE {}{}", cond("", &all), tag_cond("notes."));
            let mut args = esc.clone();
            args.extend(tags.iter().cloned());
            let (long, short): (Vec<usize>, Vec<usize>) = all.iter().partition(|&&i| terms[i].chars().count() >= 3);
            if !long.is_empty() {
                // Group 1: FTS matches that are not title matches.
                let m = long.iter().map(|&i| format!("\"{}\"", terms[i].replace('"', "\"\""))).collect::<Vec<_>>().join(" ");
                let short_cond: String = short.iter().map(|&i| format!(" AND {}", cond("n.", &[i]))).collect();
                sql += &format!(
                    " UNION ALL SELECT n.path, n.title, n.preview, n.mtime, n.encrypted, n.title_folded, n.rowid, 1 AS grp \
                     FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ?{short_cond} AND NOT ({}){}",
                    cond("n.", &all),
                    tag_cond("n.")
                );
                args.push(m);
                args.extend(short.iter().map(|&i| esc[i].clone()));
                args.extend(esc.iter().cloned());
                args.extend(tags.iter().cloned());
            }
            (sql, args, long)
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
            return Ok(Page { hits, has_more: true });
        }

        // Group 2: unlocked encrypted bodies (memory only, not in FTS), after every SQL row.
        let mut g2: Vec<(String, String, i64, Hit)> = vec![];
        if !terms.is_empty() || !tags.is_empty() {
            let wanted: Vec<&str> = tags.iter().map(String::as_str).collect();
            for (path, plain) in unlocked {
                let row = self.db.query_row("SELECT title, title_folded, mtime FROM notes WHERE path=?", [path], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
                });
                let Ok((title, tf, mtime)) = row else { continue };
                // Locked notes have no tags rows, so under a tag filter SQL never returned them.
                if tags.is_empty() && terms.iter().all(|t| tf.contains(t)) {
                    continue; // already a group 0 title hit
                }
                let pf = fold(plain);
                let have: Vec<String> = if wanted.is_empty() { vec![] } else { extract_tags(plain).into_iter().map(|(f, _)| f).collect() }; // only needed under a tag filter
                if wanted.iter().all(|w| have.iter().any(|h| h == w)) && terms.iter().all(|t| tf.contains(t) || pf.contains(t)) {
                    g2.push((tf, path.clone(), mtime, Hit { path: path.clone(), title, snippet: plain.chars().take(120).collect(), mtime, encrypted: true }));
                }
            }
        }
        if g2.is_empty() {
            return Ok(Page { hits, has_more: false });
        }
        match sort {
            Sort::Modified => g2.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1))),
            Sort::Title => g2.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1))),
        }
        let sql_total = if hits.is_empty() && offset > 0 {
            self.db.query_row(&format!("SELECT COUNT(*) FROM ({union})"), params_from_iter(args.iter()), |r| r.get::<_, i64>(0))? as usize
        } else {
            offset + hits.len()
        };
        let rest = g2.into_iter().skip(offset.saturating_sub(sql_total)).map(|g| g.3);
        hits.extend(rest.take(limit + 1 - hits.len()));
        let has_more = hits.len() > limit;
        hits.truncate(limit);
        Ok(Page { hits, has_more })
    }

    pub fn tags(&self) -> anyhow::Result<Vec<TagCount>> {
        let mut st = self.db.prepare("SELECT MIN(tag_display), COUNT(DISTINCT path) FROM tags GROUP BY tag_folded ORDER BY tag_folded")?;
        Ok(st.query_map([], |r| Ok(TagCount { tag: r.get(0)?, count: r.get::<_, i64>(1)? as usize }))?.collect::<Result<_, _>>()?)
    }

    pub fn find_title(&self, title: &str) -> anyhow::Result<Option<String>> {
        let mut st = self.db.prepare("SELECT path FROM notes WHERE title_folded=? LIMIT 1")?;
        Ok(st.query_map([fold(title)], |r| r.get(0))?.next().transpose()?)
    }

    pub fn titles(&self) -> anyhow::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT title FROM notes")?;
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
            i.upsert(p, &nf, &Meta { mtime: *m, size: body.len() as u64 }, Some(body)).unwrap();
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
        i.upsert("e.md.age", &NoteFile { title: "e".into(), encrypted: true }, &Meta { mtime: 99, size: 1 }, None).unwrap();
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
        let mut i = idx(&[]); i.upsert("s.md.age", &NoteFile { title: "s".into(), encrypted: true }, &Meta { mtime: 1, size: 1 }, None).unwrap();
        assert!(i.search_page("secretword", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.is_empty());
        let u = HashMap::from([("s.md.age".to_string(), "the secretword".to_string())]);
        assert_eq!(i.search_page("secretword", Sort::Modified, 0, 10, &[], &u).unwrap().hits[0].path, "s.md.age"); }
    #[test] fn backlinks_and_find_title() { let i = idx(&[("a.md", "see [[Target Note]]", 1), ("Target Note.md", "", 2)]);
        assert_eq!(i.backlinks("target note").unwrap(), vec!["a.md"]);
        assert_eq!(i.find_title("TARGET NOTE").unwrap().as_deref(), Some("Target Note.md")); }
    #[test] fn titles_lists_all_incl_encrypted() { let mut i = idx(&[("a.md", "", 1), ("B c.md", "", 2)]);
        i.upsert("s.md.age", &NoteFile { title: "s".into(), encrypted: true }, &Meta { mtime: 1, size: 1 }, None).unwrap();
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
        i.upsert("e.md.age", &NoteFile { title: "e".into(), encrypted: true }, &Meta { mtime: 1, size: 1 }, None).unwrap();
        let u = HashMap::from([("e.md.age".to_string(), "x #Sec".to_string())]);
        assert!(i.tags().unwrap().is_empty());
        for q in ["", "x"] {
            assert_eq!(i.search_page(q, Sort::Title, 0, 10, &["sec".to_string()], &u).unwrap().hits.len(), 1, "{q}");
            assert!(i.search_page(q, Sort::Title, 0, 10, &["other".to_string()], &u).unwrap().hits.is_empty());
        }
    }
    #[test] fn schema_upgrade_reindexes() {
        let dir = tempfile::tempdir().unwrap(); let db = dir.path().join("i.db");
        let mut i = Index::open(&db).unwrap();
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1 }, Some("#x")).unwrap(); drop(i);
        Connection::open(&db).unwrap().execute_batch("PRAGMA user_version=1").unwrap();
        let i = Index::open(&db).unwrap(); assert!(i.known().unwrap().is_empty()); assert!(i.tags().unwrap().is_empty());
        assert_eq!(i.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        let mut i = i; i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 1, size: 1 }, Some("#x")).unwrap(); drop(i);
        assert_eq!(Index::open(&db).unwrap().known().unwrap().len(), 1);
    }
    #[test] fn remove_clears_all_tables() { let mut i = idx(&[("a.md", "see [[B]] zebra", 1)]); i.remove("a.md").unwrap();
        assert!(i.search_page("zebra", Sort::Modified, 0, 10, &[], &HashMap::new()).unwrap().hits.is_empty()); assert!(i.backlinks("b").unwrap().is_empty()); }
    #[test] fn upsert_replaces_and_remove_drops_tags() { let mut i = idx(&[("a.md", "#one", 1)]);
        i.upsert("a.md", &NoteFile { title: "a".into(), encrypted: false }, &Meta { mtime: 2, size: 1 }, Some("#two")).unwrap();
        assert_eq!(i.tags().unwrap()[0].tag, "two"); assert_eq!(i.tags().unwrap().len(), 1);
        i.remove("a.md").unwrap(); assert!(i.tags().unwrap().is_empty()); }
}
