use crate::names::NoteFile;
use crate::text::{extract_links, fold};
use rusqlite::{Connection, params, params_from_iter};
use serde::Serialize;
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
        Ok(Index { db })
    }

    pub fn known(&self) -> anyhow::Result<HashMap<String, Meta>> {
        let mut st = self.db.prepare("SELECT path, mtime, size FROM notes")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, Meta { mtime: r.get(1)?, size: r.get::<_, i64>(2)? as u64 })))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn upsert(&mut self, path: &str, nf: &NoteFile, meta: &Meta, body: Option<&str>) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        for sql in ["DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE path=?1)", "DELETE FROM notes WHERE path=?1", "DELETE FROM links WHERE src=?1"] {
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
        }
        Ok(tx.commit()?)
    }

    pub fn remove(&mut self, path: &str) -> anyhow::Result<()> {
        let tx = self.db.transaction()?;
        for sql in ["DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE path=?1)", "DELETE FROM notes WHERE path=?1", "DELETE FROM links WHERE src=?1"] {
            tx.execute(sql, [path])?;
        }
        Ok(tx.commit()?)
    }

    pub fn search(&self, query: &str, limit: usize, unlocked: &HashMap<String, String>) -> anyhow::Result<Vec<Hit>> {
        let folded = fold(query);
        let terms: Vec<&str> = folded.split_whitespace().collect();
        let cols = "path, title, preview, mtime, encrypted";
        if terms.is_empty() {
            let mut st = self.db.prepare(&format!("SELECT {cols} FROM notes ORDER BY mtime DESC LIMIT {limit}"))?;
            return Ok(st.query_map([], hit)?.collect::<Result<_, _>>()?);
        }

        let title_cond = vec!["title_folded LIKE '%' || ? || '%' ESCAPE '\\'"; terms.len()].join(" AND ");
        let esc: Vec<String> = terms.iter().map(|t| like_escape(t)).collect();
        let mut st = self.db.prepare(&format!("SELECT {cols} FROM notes WHERE {title_cond} ORDER BY mtime DESC LIMIT {limit}"))?;
        let args = esc.iter().cloned();
        let mut out: Vec<Hit> = st.query_map(params_from_iter(args), hit)?.collect::<Result<_, _>>()?;
        let mut seen: HashSet<String> = out.iter().map(|h| h.path.clone()).collect();
        let n_title = out.len();

        let (long, short): (Vec<usize>, Vec<usize>) = (0..terms.len()).partition(|&i| terms[i].chars().count() >= 3);
        if !long.is_empty() && out.len() < limit {
            let m = long.iter().map(|&i| format!("\"{}\"", terms[i].replace('"', "\"\""))).collect::<Vec<_>>().join(" ");
            let short_cond: String = short.iter().map(|_| " AND n.title_folded LIKE '%' || ? || '%' ESCAPE '\\'").collect();
            // No FTS snippet(): it re-runs the MATCH per row. Read the body by rowid and cut the window in Rust.
            let mut st = self.db.prepare(&format!(
                "SELECT n.path, n.title, n.mtime, n.encrypted, n.preview, n.rowid \
                 FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid \
                 WHERE notes_fts MATCH ?{short_cond} ORDER BY n.mtime DESC LIMIT {}",
                limit + n_title
            ))?;
            let args = [m].into_iter().chain(short.iter().map(|&i| esc[i].clone()));
            let rows: Vec<(String, String, i64, bool, String, i64)> = st
                .query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
                .collect::<Result<_, _>>()?;
            let mut body_of = self.db.prepare("SELECT body FROM notes_fts WHERE rowid = ?")?;
            for (path, title, mtime, encrypted, prev, rowid) in rows {
                if out.len() >= limit {
                    break;
                }
                if seen.insert(path.clone()) {
                    let body: String = body_of.query_row([rowid], |r| r.get(0))?;
                    let snippet = snippet(&body, &terms[long[0]], prev);
                    out.push(Hit { path, title, snippet, mtime, encrypted });
                }
            }
        }

        for (path, plain) in unlocked {
            if seen.contains(path) {
                continue;
            }
            let row = self.db.query_row("SELECT title, title_folded, mtime FROM notes WHERE path=?", [path], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            });
            let Ok((title, tf, mtime)) = row else { continue };
            let pf = fold(plain);
            if terms.iter().all(|t| tf.contains(t) || pf.contains(t)) {
                out.push(Hit { path: path.clone(), title, snippet: plain.chars().take(120).collect(), mtime, encrypted: true });
            }
        }
        out[n_title..].sort_by(|a, b| b.mtime.cmp(&a.mtime));
        out.truncate(limit);
        Ok(out)
    }

    pub fn find_title(&self, title: &str) -> anyhow::Result<Option<String>> {
        let mut st = self.db.prepare("SELECT path FROM notes WHERE title_folded=? LIMIT 1")?;
        Ok(st.query_map([fold(title)], |r| r.get(0))?.next().transpose()?)
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

    #[test] fn title_hits_before_body_hits_then_mtime() {
        let i = idx(&[("a.md", "nothing", 1), ("garden.md", "x", 2), ("b.md", "my garden plan", 3), ("garden2.md", "y", 4)]);
        let p: Vec<_> = i.search("garden", 10, &HashMap::new()).unwrap().into_iter().map(|h| h.path).collect();
        assert_eq!(p, vec!["garden2.md", "garden.md", "b.md"]);
    }
    #[test] fn substring_and_diacritics() { let i = idx(&[("Résumé.md", "", 1), ("x.md", "café crème", 2)]);
        assert_eq!(i.search("sum", 10, &HashMap::new()).unwrap()[0].path, "Résumé.md");
        assert_eq!(i.search("cafe", 10, &HashMap::new()).unwrap()[0].path, "x.md"); }
    #[test] fn short_query_titles_only() { let i = idx(&[("ab.md", "", 1), ("x.md", "ab ab ab", 2)]);
        assert_eq!(i.search("ab", 10, &HashMap::new()).unwrap().len(), 1); }
    #[test] fn multi_word_all_terms() { let i = idx(&[("x.md", "red apple", 1), ("y.md", "red car", 2)]);
        assert_eq!(i.search("apple red", 10, &HashMap::new()).unwrap().iter().map(|h| &h.path).collect::<Vec<_>>(), vec!["x.md"]); }
    #[test] fn search_metacharacters_literal() { let i = idx(&[("100%.md", "a \"quoted\" NEAR (x) -y *z", 1)]);
        for q in ["\"", "%", "_", "*", "-y", "NEAR", "(x)", "\"quoted\"", "100%"] { assert!(i.search(q, 10, &HashMap::new()).is_ok(), "{q}"); }
        assert_eq!(i.search("100%", 10, &HashMap::new()).unwrap().len(), 1);
        assert_eq!(i.search("_", 10, &HashMap::new()).unwrap().len(), 0); }
    #[test] fn encrypted_body_not_indexed_unless_unlocked() {
        let mut i = idx(&[]); i.upsert("s.md.age", &NoteFile { title: "s".into(), encrypted: true }, &Meta { mtime: 1, size: 1 }, None).unwrap();
        assert!(i.search("secretword", 10, &HashMap::new()).unwrap().is_empty());
        let u = HashMap::from([("s.md.age".to_string(), "the secretword".to_string())]);
        assert_eq!(i.search("secretword", 10, &u).unwrap()[0].path, "s.md.age"); }
    #[test] fn backlinks_and_find_title() { let i = idx(&[("a.md", "see [[Target Note]]", 1), ("Target Note.md", "", 2)]);
        assert_eq!(i.backlinks("target note").unwrap(), vec!["a.md"]);
        assert_eq!(i.find_title("TARGET NOTE").unwrap().as_deref(), Some("Target Note.md")); }
    #[test] fn remove_clears_all_tables() { let mut i = idx(&[("a.md", "see [[B]] zebra", 1)]); i.remove("a.md").unwrap();
        assert!(i.search("zebra", 10, &HashMap::new()).unwrap().is_empty()); assert!(i.backlinks("b").unwrap().is_empty()); }
}
