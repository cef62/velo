use crate::crypto;
use crate::frontmatter;
use crate::index::{Index, Meta, Page, Sort, TagCount, all_tags, effective_dates};

const PAGE: usize = 200;
use crate::revisions::{RevisionInfo, Revisions, fnv64};
use crate::names::{NoteFile, note_path, parse_note_file};
use crate::store::{SaveResult, Store, hash};
use crate::text::rewrite_links;
use anyhow::{Context, anyhow};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
pub struct NoteDoc {
    pub path: String,
    pub title: String,
    pub text: String,
    /// hash of the on-disk bytes (ciphertext for encrypted notes)
    pub hash: String,
    pub encrypted: bool,
    pub meta: NoteMeta,
}

/// Dates are epoch ms; `*_src` is "frontmatter" or "file".
#[derive(Serialize, Default)]
pub struct NoteMeta {
    pub created: i64,
    pub created_src: String,
    pub modified: i64,
    pub modified_src: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
}

#[derive(Serialize)]
pub struct RenameResult {
    pub path: String,
    pub rewritten: usize,
}

pub struct Vault {
    pub store: Store,
    pub index: Index,
    /// plaintext of unlocked encrypted notes, memory only
    unlocked: HashMap<String, String>,
    revisions: Revisions,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn stat(p: &Path) -> anyhow::Result<Meta> {
    let md = std::fs::metadata(p)?;
    let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    let birth = md.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    Ok(Meta { mtime, size: md.len(), birth })
}

/// From the plaintext in memory, so unlocked notes show their real front-matter dates.
fn note_meta(text: &str, m: &Meta) -> NoteMeta {
    let fm = frontmatter::parse(text);
    let (created, cs, modified, ms) = effective_dates(fm.as_ref(), m);
    let tags = all_tags(frontmatter::body(text), fm.as_ref()).into_iter().map(|(_, d)| d).collect();
    NoteMeta { created, created_src: cs.into(), modified, modified_src: ms.into(), tags, aliases: fm.map(|f| f.aliases).unwrap_or_default() }
}

fn parse(p: &Path) -> anyhow::Result<NoteFile> {
    parse_note_file(p).ok_or_else(|| anyhow!("not a note file: {}", p.display()))
}

/// macOS uses NSFileManager instead of the crate's Finder default, which drives Finder over AppleScript
/// (Automation permission prompt; denying it would break every later delete).
fn move_to_trash(p: &Path) -> std::io::Result<()> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(p).map_err(|e| std::io::Error::other(e.to_string()))
}

impl Vault {
    pub fn open(dir: PathBuf, db_path: &Path, identity: Option<&str>) -> anyhow::Result<Vault> {
        Self::open_with_progress(dir, db_path, identity, &mut |_, _| {})
    }

    /// `progress(done, total)` counts files needing (re)indexing; every 250 files and at the end, never when none.
    pub fn open_with_progress(dir: PathBuf, db_path: &Path, identity: Option<&str>, progress: &mut dyn FnMut(usize, usize)) -> anyhow::Result<Vault> {
        // revisions live next to the index db (the app data dir), keyed by vault dir
        let root = db_path.parent().unwrap_or(Path::new(".")).join("revisions").join(fnv64(&s(&dir)));
        let mut v = Vault { store: Store::new(dir), index: Index::open(db_path)?, unlocked: HashMap::new(), revisions: Revisions::new(root) };
        v.revisions.maybe_prune(now_ms());
        let known = v.index.known()?;
        let files = v.store.list()?;
        let stale: Vec<_> = files
            .iter()
            .filter(|(path, _, meta)| !known.get(&s(path)).is_some_and(|k| k.mtime == meta.mtime && k.size == meta.size))
            .collect();
        let total = stale.len();
        for (i, (path, nf, meta)) in stale.into_iter().enumerate() {
            if let Ok(bytes) = v.store.read(path) {
                let body = (!nf.encrypted).then(|| lossy(&bytes));
                v.index.upsert(&s(path), nf, meta, body.as_deref())?;
            }
            if (i + 1) % 250 == 0 || i + 1 == total {
                progress(i + 1, total);
            }
        }
        let present: std::collections::HashSet<String> = files.iter().map(|(p, ..)| s(p)).collect();
        for gone in known.keys().filter(|k| !present.contains(*k)) {
            v.index.remove(gone)?;
        }
        if let Some(id) = identity {
            for (path, nf, _) in &files {
                if nf.encrypted {
                    v.try_unlock(path, id);
                }
            }
        }
        Ok(v)
    }

    fn try_unlock(&mut self, path: &Path, identity: &str) {
        if let Ok(plain) = self.store.read(path).and_then(|b| crypto::decrypt(identity, &b).map_err(std::io::Error::other)) {
            self.unlocked.insert(s(path), lossy(&plain));
        }
    }

    /// Index a file already on disk; plaintext `body` is dropped for encrypted notes.
    fn reindex(&mut self, path: &Path, body: Option<&str>) -> anyhow::Result<()> {
        let nf = parse(path)?;
        self.index.upsert(&s(path), &nf, &stat(path)?, body)
    }

    pub fn search(&self, query: &str, sort: Sort, offset: usize, tags: &[String]) -> anyhow::Result<Page> {
        self.index.search_page(query, sort, offset, PAGE, tags, &self.unlocked)
    }

    /// Tags of plain notes only: unlocked notes' tags stay in memory and out of this list.
    pub fn tags(&self) -> anyhow::Result<Vec<TagCount>> {
        self.index.tags()
    }

    pub fn titles(&self) -> anyhow::Result<Vec<String>> {
        self.index.titles()
    }

    pub fn open_note(&mut self, path: &str, identity: Option<&str>) -> anyhow::Result<NoteDoc> {
        let p = Path::new(path);
        let nf = parse(p)?;
        let bytes = self.store.read(p)?;
        let text = if nf.encrypted {
            let id = identity.ok_or_else(|| anyhow!("locked"))?;
            let plain = lossy(&crypto::decrypt(id, &bytes)?);
            self.unlocked.insert(path.to_string(), plain.clone());
            plain
        } else {
            lossy(&bytes)
        };
        let meta = note_meta(&text, &stat(p)?);
        Ok(NoteDoc { path: path.into(), title: nf.title, text, hash: hash(&bytes), encrypted: nf.encrypted, meta })
    }

    pub fn open_or_create(&mut self, title: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<NoteDoc> {
        if let Some(path) = self.index.find_title(title)? {
            return self.open_note(&path, identity);
        }
        let p = note_path(&self.store.dir, title, false);
        if !p.exists() {
            let now = chrono::Local::now().fixed_offset();
            let init = if write_fm { frontmatter::stamp("", now, now) } else { String::new() };
            self.store.write_atomic(&p, init.as_bytes())?;
        }
        let body = lossy(&self.store.read(&p)?);
        self.reindex(&p, Some(&body))?;
        self.open_note(&s(&p), identity)
    }

    pub fn save_note(&mut self, path: &str, text: &str, base_hash: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<SaveResult> {
        let p = Path::new(path);
        let nf = parse(p)?;
        let encrypted = nf.encrypted;
        // A stale editor bound to the pre-lock path must not resurrect the plaintext next to Title.md.age.
        if !encrypted && note_path(&self.store.dir, &nf.title, true).exists() {
            return Err(anyhow!("locked-sibling"));
        }
        let orig = text;
        let now = chrono::Local::now().fixed_offset();
        let stamped = write_fm.then(|| {
            // created fallback: the file's earliest time before this write (now if missing)
            let ms = stat(p).map_or(now.timestamp_millis(), |m| effective_dates(None, &m).0);
            let created = chrono::DateTime::from_timestamp_millis(ms).map_or(now, |d| d.with_timezone(&chrono::Local).fixed_offset());
            frontmatter::stamp(text, now, created)
        });
        let text = stamped.as_deref().unwrap_or(text);
        let bytes = if encrypted {
            crypto::encrypt(identity.ok_or_else(|| anyhow!("locked"))?, text.as_bytes())?
        } else {
            text.as_bytes().to_vec()
        };
        let mut res = self.store.save(p, &bytes, base_hash)?;
        let target = match &res {
            SaveResult::Saved { .. } => p.to_path_buf(),
            SaveResult::Conflict { conflict_path, .. } => PathBuf::from(conflict_path),
        };
        self.reindex(&target, (!encrypted).then_some(text))?;
        // a failed snapshot must never fail a save that already hit the disk; conflicts snapshot the conflict copy
        if let Some(nt) = parse_note_file(&target) {
            self.revisions.maybe_prune(now_ms());
            self.revisions.snapshot_bytes(&nt.title, &bytes, encrypted, now_ms(), true).ok();
        }
        if encrypted {
            self.unlocked.insert(s(&target), text.to_string());
        }
        if let SaveResult::Saved { front_matter, meta, .. } = &mut res {
            *meta = note_meta(text, &stat(&target)?);
            *front_matter = stamped.as_deref().filter(|t| *t != orig).and_then(|t| frontmatter::parse(t).map(|f| t[..f.end].to_string()));
        }
        Ok(res)
    }

    pub fn rename_note(&mut self, path: &str, new_title: &str, rewrite_links_too: bool) -> anyhow::Result<RenameResult> {
        let from = Path::new(path);
        let old = parse(from)?;
        let to = self.store.rename(from, new_title)?; // keeps io::ErrorKind::AlreadyExists
        let (from_s, to_s) = (path.to_string(), s(&to));
        if to_s != from_s {
            self.index.remove(&from_s)?;
            if let Some(plain) = self.unlocked.remove(&from_s) {
                self.unlocked.insert(to_s.clone(), plain);
            }
        }
        let nf = parse(&to)?;
        self.revisions.rename(&old.title, &nf.title);
        let body = (!nf.encrypted).then(|| lossy(&self.store.read(&to).unwrap_or_default()));
        self.reindex(&to, body.as_deref())?;

        let mut rewritten = 0;
        if rewrite_links_too {
            for src in self.index.backlinks(&old.title)? {
                let sp = Path::new(&src);
                if parse_note_file(sp).is_none_or(|n| n.encrypted) {
                    continue;
                }
                let text = lossy(&self.store.read(sp)?);
                let (new_text, n) = rewrite_links(&text, &old.title, new_title);
                if n > 0 {
                    self.store.write_atomic(sp, new_text.as_bytes())?;
                    self.reindex(sp, Some(&new_text))?;
                    rewritten += n;
                }
            }
        }
        Ok(RenameResult { path: to_s, rewritten })
    }

    pub fn backlink_count(&self, title: &str) -> anyhow::Result<usize> {
        Ok(self.index.backlinks(title)?.len())
    }

    pub fn lock_note(&mut self, path: &str, identity: &str) -> anyhow::Result<String> {
        let from = Path::new(path);
        let nf = parse(from)?;
        if nf.encrypted {
            return Err(anyhow!("already encrypted"));
        }
        let to = note_path(&self.store.dir, &nf.title, true);
        if to.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
        }
        // first: on failure nothing else has changed, and no plaintext snapshot survives a lock
        self.revisions.encrypt_all(&nf.title, |b| crypto::encrypt(identity, b))?;
        let plain = self.store.read(from)?;
        self.store.write_atomic(&to, &crypto::encrypt(identity, &plain)?)?;
        std::fs::remove_file(from).context("removing plaintext note")?;
        self.index.remove(path)?;
        self.reindex(&to, None)?;
        self.index.checkpoint()?; // drop pre-lock WAL frames holding plaintext
        self.unlocked.insert(s(&to), lossy(&plain));
        Ok(s(&to))
    }

    pub fn unlock_note(&mut self, path: &str, identity: &str) -> anyhow::Result<String> {
        let from = Path::new(path);
        let nf = parse(from)?;
        if !nf.encrypted {
            return Err(anyhow!("not encrypted"));
        }
        let to = note_path(&self.store.dir, &nf.title, false);
        if to.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
        }
        let plain = crypto::decrypt(identity, &self.store.read(from)?)?;
        self.store.write_atomic(&to, &plain)?;
        std::fs::remove_file(from).context("removing encrypted note")?;
        self.index.remove(path)?;
        self.unlocked.remove(path);
        self.reindex(&to, Some(&lossy(&plain)))?;
        Ok(s(&to))
    }

    /// Move a note to the OS Trash and drop it from the index and the unlocked cache.
    pub fn delete_note(&mut self, path: &str) -> anyhow::Result<()> {
        self.delete_note_with(path, move_to_trash)
    }

    /// `remove` does the actual file removal (Trash in the app, plain remove in tests).
    pub fn delete_note_with(&mut self, path: &str, remove: impl FnOnce(&Path) -> std::io::Result<()>) -> anyhow::Result<()> {
        let p = Path::new(path);
        if p.parent() != Some(self.store.dir.as_path()) || parse_note_file(p).is_none() {
            return Err(anyhow!("not a note in the notes folder"));
        }
        remove(p)?;
        self.index.remove(path)?;
        self.unlocked.remove(path);
        Ok(())
    }

    pub fn list_revisions(&self, path: &str) -> anyhow::Result<Vec<RevisionInfo>> {
        Ok(self.revisions.list(&parse(Path::new(path))?.title))
    }

    pub fn read_revision(&self, path: &str, id: &str, identity: Option<&str>) -> anyhow::Result<String> {
        let (bytes, enc) = self.revisions.read(&parse(Path::new(path))?.title, id)?;
        if !enc {
            return Ok(lossy(&bytes));
        }
        Ok(lossy(&crypto::decrypt(identity.ok_or_else(|| anyhow!("locked"))?, &bytes)?))
    }

    /// Not throttled. Locked notes get ciphertext; their identical-content check decrypts the newest snapshot.
    pub fn snapshot_text(&mut self, path: &str, text: &str, identity: Option<&str>) -> anyhow::Result<()> {
        let nf = parse(Path::new(path))?;
        if !nf.encrypted {
            self.revisions.snapshot_bytes(&nf.title, text.as_bytes(), false, now_ms(), false)?;
            return Ok(());
        }
        let id = identity.ok_or_else(|| anyhow!("locked"))?;
        if let Some(newest) = self.revisions.list(&nf.title).first()
            && self.read_revision(path, &newest.id, Some(id)).is_ok_and(|t| t == text)
        {
            return Ok(());
        }
        self.revisions.snapshot_bytes(&nf.title, &crypto::encrypt(id, text.as_bytes())?, true, now_ms(), false)?;
        Ok(())
    }

    pub fn lock_all(&mut self) {
        self.unlocked.clear();
    }

    pub fn apply_fs_changes(&mut self, paths: &[PathBuf], identity: Option<&str>) -> Vec<String> {
        let mut changed = Vec::new();
        for p in paths {
            let Some(nf) = parse_note_file(p) else { continue };
            let key = s(p);
            match self.store.read(p) {
                Ok(bytes) => {
                    if self.store.take_self_write(p, &bytes) {
                        continue;
                    }
                    let body = (!nf.encrypted).then(|| lossy(&bytes));
                    if self.reindex(p, body.as_deref()).is_err() {
                        continue;
                    }
                    if nf.encrypted
                        && let Some(id) = identity
                    {
                        self.try_unlock(p, id);
                    }
                }
                Err(_) => {
                    if self.index.remove(&key).is_err() {
                        continue;
                    }
                    self.unlocked.remove(&key);
                }
            }
            changed.push(key);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;
    use std::path::Path;

    fn open_empty() -> Vault {
        let dir = tempfile::tempdir().unwrap().keep();
        let db = tempfile::tempdir().unwrap().keep().join("i.sqlite");
        Vault::open(dir, &db, None).unwrap()
    }

    fn setup() -> (PathBuf, PathBuf) {
        (tempfile::tempdir().unwrap().keep(), tempfile::tempdir().unwrap().keep().join("i.sqlite"))
    }

    #[test] fn open_reconciles_and_rebuilds() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "zebra").unwrap();
        let v = Vault::open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); drop(v); std::fs::remove_file(&db).unwrap();
        assert_eq!(Vault::open(dir, &db, None).unwrap().search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
    }
    #[test] fn progress_reports_total_and_end() {
        let (dir, db) = setup();
        for i in 0..600 { std::fs::write(dir.join(format!("n{i}.md")), format!("body {i}")).unwrap(); }
        let mut calls = vec![];
        Vault::open_with_progress(dir, &db, None, &mut |d, t| calls.push((d, t))).unwrap();
        assert_eq!(calls.last(), Some(&(600, 600)));
        assert!(calls.iter().all(|c| c.1 == 600) && calls.len() <= 4, "{calls:?}");
    }
    #[test] fn warm_open_reports_nothing() {
        let (dir, db) = setup();
        for i in 0..5 { std::fs::write(dir.join(format!("n{i}.md")), "x").unwrap(); }
        Vault::open(dir.clone(), &db, None).unwrap();
        let mut n = 0;
        Vault::open_with_progress(dir, &db, None, &mut |_, _| n += 1).unwrap();
        assert_eq!(n, 0);
    }
    #[test] fn reconcile_tolerates_non_utf8() {
        let (dir, db) = setup();
        std::fs::write(dir.join("bin.txt"), [0xff, 0xfe, b'o', b'k', b'a', b'y']).unwrap();
        let before = std::fs::read(dir.join("bin.txt")).unwrap(); let v = Vault::open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.search("bin", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); assert_eq!(std::fs::read(dir.join("bin.txt")).unwrap(), before);
    }
    #[test] fn open_or_create_dedupes_case_insensitive() {
        let mut v = open_empty(); let a = v.open_or_create("Foo", None, false).unwrap();
        let b = v.open_or_create("FOO", None, false).unwrap(); assert_eq!(a.path, b.path);
    }
    #[test] fn save_after_external_delete_recreates() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        std::fs::remove_file(&d.path).unwrap(); assert!(matches!(v.save_note(&d.path, "kept", &d.hash, None, false).unwrap(), SaveResult::Saved { .. }));
        assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "kept");
    }
    #[test] fn lock_keeps_plaintext_off_disk_and_db() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "uniqueplain zqxjvkplmwqbyfh", &d.hash, None, false).unwrap(); let p = v.lock_note(&d.path, &id).unwrap();
        assert!(p.ends_with(".md.age")); assert!(!Path::new(&d.path).exists());
        assert!(!std::fs::read(&p).unwrap().windows(11).any(|w| w == b"uniqueplain"));
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{}{suffix}", db.display());
            if let Ok(b) = std::fs::read(&f) { assert!(!b.windows(11).any(|w| w == b"uniqueplain"), "{f}");
                // FTS trigram index keeps overlapping 3-byte terms; none may survive
                let word = b"zqxjvkplmwqbyfh";
                assert!(!word.windows(3).any(|g| b.windows(3).any(|w| w == g)), "trigram leak in {f}"); }
        }
        let mut v = Vault::open(dir.clone(), &db, Some(&id)).unwrap(); assert_eq!(v.search("uniqueplain", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        v.lock_all(); assert!(v.search("uniqueplain", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(v.open_note(&p, None).is_err()); assert_eq!(v.open_note(&p, Some(&id)).unwrap().text, "uniqueplain zqxjvkplmwqbyfh");
    }
    #[test] fn locked_note_tags_stay_out_of_sqlite() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "#zqxjvkplmwqbyfh text", &d.hash, None, false).unwrap();
        assert_eq!(v.tags().unwrap().len(), 1); v.lock_note(&d.path, &id).unwrap();
        assert!(v.tags().unwrap().is_empty());
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{}{suffix}", db.display());
            if let Ok(b) = std::fs::read(&f) {
                let word = b"zqxjvkplmwqbyfh";
                assert!(!word.windows(3).any(|g| b.windows(3).any(|w| w == g)), "trigram leak in {f}"); }
        }
        let v = Vault::open(dir, &db, Some(&id)).unwrap();
        assert!(v.tags().unwrap().is_empty());
        assert_eq!(v.search("", Sort::Title, 0, &["zqxjvkplmwqbyfh".to_string()]).unwrap().hits.len(), 1);
    }
    #[test] fn save_to_plain_path_refused_when_locked_sibling_exists() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir.clone(), &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        let e = v.save_note(&d.path, "stale zqxjvkplmwqbyfh", &d.hash, Some(&id), false).err().unwrap();
        assert_eq!(e.to_string(), "locked-sibling");
        assert!(!Path::new(&d.path).exists());
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            if let Ok(b) = std::fs::read(format!("{}{suffix}", db.display())) {
                let word = b"zqxjvkplmwqbyfh";
                assert!(!word.windows(3).any(|g| b.windows(3).any(|w| w == g)), "trigram leak");
            }
        }
    }
    #[test] fn rename_rewrites_backlinks() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = Vault::open(dir.clone(), &db, None).unwrap();
        let old = dir.join("Old.md").to_string_lossy().into_owned();
        let r = v.rename_note(&old, "New", true).unwrap();
        assert_eq!(r.rewritten, 1); assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "see [[New]]");
    }
    #[test] fn leading_dot_titles_stay_visible_and_indexed() {
        let mut v = open_empty();
        let d = v.open_or_create(".foo", None, false).unwrap();
        assert!(!Path::new(&d.path).file_name().unwrap().to_str().unwrap().starts_with('.'));
        assert_eq!(v.search("", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        let r = v.rename_note(&d.path, ".bar", false).unwrap();
        assert!(!Path::new(&r.path).file_name().unwrap().to_str().unwrap().starts_with('.'));
        assert_eq!(v.search("", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        assert!(v.open_note(&r.path, None).is_ok());
    }
    #[test] fn fs_changes_skip_self_writes() {
        let mut v = open_empty(); let d = v.open_or_create("w", None, false).unwrap();
        v.save_note(&d.path, "x", &d.hash, None, false).unwrap(); assert!(v.apply_fs_changes(&[d.path.clone().into()], None).is_empty());
        std::fs::write(&d.path, "external zebra").unwrap(); assert_eq!(v.apply_fs_changes(&[d.path.clone().into()], None), vec![d.path.clone()]);
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
    }
    #[test] fn delete_moves_file_out_and_drops_it_from_index() {
        let mut v = open_empty(); let d = v.open_or_create("doomed", None, false).unwrap();
        v.save_note(&d.path, "zebra", &d.hash, None, false).unwrap();
        v.delete_note_with(&d.path, |p| std::fs::remove_file(p)).unwrap();
        assert!(!Path::new(&d.path).exists());
        assert!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(v.titles().unwrap().is_empty());
    }
    #[test] fn delete_refuses_paths_outside_the_notes_folder() {
        let mut v = open_empty();
        let outside = tempfile::tempdir().unwrap().keep().join("x.md"); std::fs::write(&outside, "keep").unwrap();
        assert!(v.delete_note_with(&s(&outside), |p| std::fs::remove_file(p)).is_err());
        assert!(outside.exists());
    }
    fn fm_of(r: SaveResult) -> (Option<String>, String) { match r { SaveResult::Saved { front_matter, hash, .. } => (front_matter, hash), _ => panic!("conflict") } }
    #[test] fn save_stamps_plain_note() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let (fm, _) = fm_of(v.save_note(&d.path, "hello", &d.hash, None, true).unwrap());
        let fm = fm.unwrap(); assert!(fm.starts_with("---\ncreated: ") && fm.ends_with("---\n"));
        let disk = std::fs::read_to_string(&d.path).unwrap(); assert!(disk.starts_with(&fm) && disk.ends_with("hello"));
        // created = earliest file time before the write
        let md = std::fs::metadata(&d.path).unwrap(); let _ = md;
        let c = frontmatter::parse(&disk).unwrap().created.unwrap();
        assert!((c.timestamp() - chrono::Local::now().timestamp()).abs() < 5);
    }
    #[test] fn created_comes_from_file_time() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let m = stat(Path::new(&d.path)).unwrap(); let want = effective_dates(None, &m).0 / 1000;
        v.save_note(&d.path, "x", &d.hash, None, true).unwrap();
        assert_eq!(frontmatter::parse(&std::fs::read_to_string(&d.path).unwrap()).unwrap().created.unwrap().timestamp(), want);
    }
    #[test] fn save_setting_off_writes_as_is() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let (fm, _) = fm_of(v.save_note(&d.path, "hello", &d.hash, None, false).unwrap());
        assert!(fm.is_none()); assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "hello");
    }
    #[test] fn current_block_same_second_is_unchanged() {
        // save_note reports front_matter only when stamp() changed the text; same `now` must be a no-op
        let now = chrono::Local::now().fixed_offset();
        let t = frontmatter::stamp("body", now, now);
        assert_eq!(frontmatter::stamp(&t, now, now), t);
    }
    fn stat_hash(p: &str) -> String { hash(&std::fs::read(p).unwrap()) }
    #[test] fn locked_note_encrypts_stamped_text() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir, &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let h = stat_hash(&p);
        v.save_note(&p, "secret", &h, Some(&id), true).unwrap();
        let plain = String::from_utf8(crypto::decrypt(&id, &std::fs::read(&p).unwrap()).unwrap()).unwrap();
        assert!(plain.starts_with("---\ncreated: ") && plain.ends_with("secret"));
    }
    #[test] fn new_note_gets_block() {
        let mut v = open_empty();
        let d = v.open_or_create("a", None, true).unwrap(); assert!(d.text.starts_with("---\ncreated: ") && d.text.ends_with("---\n"));
        assert_eq!(d.meta.created_src, "frontmatter");
        assert_eq!(v.open_or_create("b", None, false).unwrap().text, "");
    }
    #[test] fn second_save_with_returned_hash_is_saved() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let (_, h) = fm_of(v.save_note(&d.path, "one", &d.hash, None, true).unwrap());
        for t in ["one", "onex"] {
            let r = v.save_note(&d.path, t, &h, None, true).unwrap();
            assert!(matches!(r, SaveResult::Saved { .. }));
            let SaveResult::Saved { hash, .. } = r else { unreachable!() };
            assert_eq!(hash, stat_hash(&d.path));
            let r = v.save_note(&d.path, t, &hash, None, true).unwrap(); assert!(matches!(r, SaveResult::Saved { .. }));
        }
    }
    #[test] fn second_save_locked_is_saved() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir, &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let (_, h) = fm_of(v.save_note(&p, "secret", &stat_hash(&p), Some(&id), true).unwrap());
        assert!(matches!(v.save_note(&p, "secretx", &h, Some(&id), true).unwrap(), SaveResult::Saved { .. }));
    }
    #[test] fn stamped_conflict_copy_keeps_both_sides() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        std::fs::write(&d.path, "external").unwrap();
        let r = v.save_note(&d.path, "mine", &d.hash, None, true).unwrap();
        let SaveResult::Conflict { conflict_path, .. } = r else { panic!("expected conflict") };
        assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "external");
        let c = std::fs::read_to_string(&conflict_path).unwrap();
        let f = frontmatter::parse(&c).unwrap();
        assert!(f.created.is_some() && f.modified.is_some() && c.ends_with("mine"), "{c:?}");
    }
    #[test] fn lock_reencrypts_snapshots_and_snapshot_text_encrypts() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir.clone(), &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        v.save_note(&d.path, "plainsecret", &d.hash, None, false).unwrap();
        let root = db.parent().unwrap().join("revisions");
        let files = |root: &Path| -> Vec<String> {
            let mut out = vec![];
            for k in std::fs::read_dir(root).unwrap().flatten() { for f in std::fs::read_dir(k.path()).unwrap().flatten() { out.push(f.file_name().to_string_lossy().into_owned()); } }
            out
        };
        let vdir = std::fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
        assert!(files(&vdir).iter().all(|f| f.ends_with(".md")));
        let locked = v.lock_note(&d.path, &id).unwrap();
        assert!(files(&vdir).iter().all(|f| f.ends_with(".md.age")));
        let r = v.list_revisions(&locked).unwrap();
        assert_eq!(v.read_revision(&locked, &r[0].id, Some(&id)).unwrap(), "plainsecret");
        assert_eq!(v.read_revision(&locked, &r[0].id, None).err().unwrap().to_string(), "locked");
        v.snapshot_text(&locked, "newer", Some(&id)).unwrap();
        v.snapshot_text(&locked, "newer", Some(&id)).unwrap(); // identical: skipped
        assert_eq!(v.list_revisions(&locked).unwrap().len(), 2);
        assert!(files(&vdir).iter().all(|f| f.ends_with(".md.age")));
        assert_eq!(v.snapshot_text(&locked, "x", None).err().unwrap().to_string(), "locked");
    }
}
