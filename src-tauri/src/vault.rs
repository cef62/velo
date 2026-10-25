use crate::crypto;
use crate::index::{Hit, Index, Meta};
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
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn stat(p: &Path) -> anyhow::Result<Meta> {
    let md = std::fs::metadata(p)?;
    let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    Ok(Meta { mtime, size: md.len() })
}

fn parse(p: &Path) -> anyhow::Result<NoteFile> {
    parse_note_file(p).ok_or_else(|| anyhow!("not a note file: {}", p.display()))
}

impl Vault {
    pub fn open(dir: PathBuf, db_path: &Path, identity: Option<&str>) -> anyhow::Result<Vault> {
        let mut v = Vault { store: Store::new(dir), index: Index::open(db_path)?, unlocked: HashMap::new() };
        let known = v.index.known()?;
        let files = v.store.list()?;
        for (path, nf, meta) in &files {
            let key = s(path);
            if known.get(&key).is_some_and(|k| k.mtime == meta.mtime && k.size == meta.size) {
                continue;
            }
            let Ok(bytes) = v.store.read(path) else { continue };
            let body = (!nf.encrypted).then(|| lossy(&bytes));
            v.index.upsert(&key, nf, meta, body.as_deref())?;
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

    pub fn search(&self, query: &str) -> anyhow::Result<Vec<Hit>> {
        self.index.search(query, 200, &self.unlocked)
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
        Ok(NoteDoc { path: path.into(), title: nf.title, text, hash: hash(&bytes), encrypted: nf.encrypted })
    }

    pub fn open_or_create(&mut self, title: &str, identity: Option<&str>) -> anyhow::Result<NoteDoc> {
        if let Some(path) = self.index.find_title(title)? {
            return self.open_note(&path, identity);
        }
        let p = note_path(&self.store.dir, title, false);
        if !p.exists() {
            self.store.write_atomic(&p, b"")?;
        }
        let body = lossy(&self.store.read(&p)?);
        self.reindex(&p, Some(&body))?;
        self.open_note(&s(&p), identity)
    }

    pub fn save_note(&mut self, path: &str, text: &str, base_hash: &str, identity: Option<&str>) -> anyhow::Result<SaveResult> {
        let p = Path::new(path);
        let encrypted = parse(p)?.encrypted;
        let bytes = if encrypted {
            crypto::encrypt(identity.ok_or_else(|| anyhow!("locked"))?, text.as_bytes())?
        } else {
            text.as_bytes().to_vec()
        };
        let res = self.store.save(p, &bytes, base_hash)?;
        let target = match &res {
            SaveResult::Saved { .. } => p.to_path_buf(),
            SaveResult::Conflict { conflict_path, .. } => PathBuf::from(conflict_path),
        };
        self.reindex(&target, (!encrypted).then_some(text))?;
        if encrypted {
            self.unlocked.insert(s(&target), text.to_string());
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
        let plain = self.store.read(from)?;
        self.store.write_atomic(&to, &crypto::encrypt(identity, &plain)?)?;
        std::fs::remove_file(from).context("removing plaintext note")?;
        self.index.remove(path)?;
        self.reindex(&to, None)?;
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
        assert_eq!(v.search("zebra").unwrap().len(), 1); drop(v); std::fs::remove_file(&db).unwrap();
        assert_eq!(Vault::open(dir, &db, None).unwrap().search("zebra").unwrap().len(), 1);
    }
    #[test] fn reconcile_tolerates_non_utf8() {
        let (dir, db) = setup();
        std::fs::write(dir.join("bin.txt"), [0xff, 0xfe, b'o', b'k', b'a', b'y']).unwrap();
        let before = std::fs::read(dir.join("bin.txt")).unwrap(); let v = Vault::open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.search("bin").unwrap().len(), 1); assert_eq!(std::fs::read(dir.join("bin.txt")).unwrap(), before);
    }
    #[test] fn open_or_create_dedupes_case_insensitive() {
        let mut v = open_empty(); let a = v.open_or_create("Foo", None).unwrap();
        let b = v.open_or_create("FOO", None).unwrap(); assert_eq!(a.path, b.path);
    }
    #[test] fn save_after_external_delete_recreates() {
        let mut v = open_empty(); let d = v.open_or_create("n", None).unwrap();
        std::fs::remove_file(&d.path).unwrap(); assert!(matches!(v.save_note(&d.path, "kept", &d.hash, None).unwrap(), SaveResult::Saved { .. }));
        assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "kept");
    }
    #[test] fn lock_keeps_plaintext_off_disk_and_db() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = Vault::open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None).unwrap();
        let _r = v.save_note(&d.path, "uniqueplain", &d.hash, None).unwrap(); let p = v.lock_note(&d.path, &id).unwrap();
        assert!(p.ends_with(".md.age")); assert!(!Path::new(&d.path).exists());
        assert!(!std::fs::read(&p).unwrap().windows(11).any(|w| w == b"uniqueplain"));
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{}{suffix}", db.display());
            if let Ok(b) = std::fs::read(&f) { assert!(!b.windows(11).any(|w| w == b"uniqueplain"), "{f}"); }
        }
        let mut v = Vault::open(dir.clone(), &db, Some(&id)).unwrap(); assert_eq!(v.search("uniqueplain").unwrap().len(), 1);
        v.lock_all(); assert!(v.search("uniqueplain").unwrap().is_empty());
        assert!(v.open_note(&p, None).is_err()); assert_eq!(v.open_note(&p, Some(&id)).unwrap().text, "uniqueplain");
    }
    #[test] fn rename_rewrites_backlinks() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = Vault::open(dir.clone(), &db, None).unwrap();
        let old = dir.join("Old.md").to_string_lossy().into_owned();
        let r = v.rename_note(&old, "New", true).unwrap();
        assert_eq!(r.rewritten, 1); assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "see [[New]]");
    }
    #[test] fn fs_changes_skip_self_writes() {
        let mut v = open_empty(); let d = v.open_or_create("w", None).unwrap();
        v.save_note(&d.path, "x", &d.hash, None).unwrap(); assert!(v.apply_fs_changes(&[d.path.clone().into()], None).is_empty());
        std::fs::write(&d.path, "external zebra").unwrap(); assert_eq!(v.apply_fs_changes(&[d.path.clone().into()], None), vec![d.path.clone()]);
        assert_eq!(v.search("zebra").unwrap().len(), 1);
    }
}
