use crate::index::Meta;
use crate::names::{NoteFile, parse_note_file, title_to_stem};
use crate::text::fold;
use serde::Serialize;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// Hex of std `DefaultHasher`; stable only within one process.
pub fn hash(bytes: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    h.write(bytes);
    format!("{:016x}", h.finish())
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SaveResult {
    /// `front_matter` (the stamped block) and `meta` are filled in by the vault.
    Saved { hash: String, front_matter: Option<String>, meta: crate::vault::NoteMeta },
    Conflict { conflict_path: String, disk_hash: String },
}

/// Epoch-ms modification and birth times (0 when the platform has none) and size.
pub fn meta_of(md: &std::fs::Metadata) -> Meta {
    let ms = |t: io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
    Meta { mtime: ms(md.modified()), size: md.len(), birth: ms(md.created()) }
}

pub struct Store {
    pub dir: PathBuf,
    self_writes: Mutex<HashMap<PathBuf, String>>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        Store { dir, self_writes: Mutex::new(HashMap::new()) }
    }

    pub fn list(&self) -> io::Result<Vec<(PathBuf, NoteFile, Meta)>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let Some(note) = parse_note_file(&path) else { continue };
            let Ok(md) = entry.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            out.push((path, note, meta_of(&md)));
        }
        Ok(out)
    }

    /// Files a crash left behind: `.X.md.tmp` from `write_atomic` (it can hold plaintext a later lock would leave in
    /// the folder) is deleted once a minute old; `.X.md.rename` from a case-only rename (the note is hidden under it) goes back to
    /// `X.md` unless that exists. Only names of notes are touched.
    pub fn clean_leftovers(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix('.') else { continue };
            if rest.strip_suffix(".tmp").is_some_and(|n| parse_note_file(Path::new(n)).is_some()) {
                // a recent one may be another process's write in flight (`velo --mcp` headless, or the app)
                if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|a| a.as_secs() >= 60)) {
                    std::fs::remove_file(e.path()).ok();
                }
            } else if let Some(note) = rest.strip_suffix(".rename").filter(|n| parse_note_file(Path::new(n)).is_some()) {
                let to = self.dir.join(note);
                if to.symlink_metadata().is_err() {
                    std::fs::rename(e.path(), to).ok();
                }
            }
        }
    }

    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    pub fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<String> {
        let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let tmp = path.with_file_name(format!(".{name}.tmp"));
        // sync before the rename: after a power cut the note is either the old or the new version, never empty
        let res = std::fs::File::create(&tmp)
            .and_then(|mut f| io::Write::write_all(&mut f, bytes).and_then(|_| f.sync_all()))
            .and_then(|_| std::fs::rename(&tmp, path));
        if let Err(e) = res {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        let h = hash(bytes);
        self.self_writes.lock().unwrap().insert(path.to_path_buf(), h.clone());
        Ok(h)
    }

    pub fn save(&self, path: &Path, bytes: &[u8], base_hash: &str) -> io::Result<SaveResult> {
        match std::fs::read(path) {
            Ok(disk) if hash(&disk) != base_hash => {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                let stem = parse_note_file(path).map_or_else(|| name.to_string(), |n| n.title);
                let ext = if name.ends_with(".age") { "md.age" } else { "md" };
                let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
                let mut conflict = path.with_file_name(format!("{stem} (conflict {stamp}).{ext}"));
                let mut n = 2;
                while conflict.symlink_metadata().is_ok() {
                    conflict = path.with_file_name(format!("{stem} (conflict {stamp}) {n}.{ext}"));
                    n += 1;
                }
                self.write_atomic(&conflict, bytes)?;
                Ok(SaveResult::Conflict {
                    conflict_path: conflict.to_string_lossy().into_owned(),
                    disk_hash: hash(&disk),
                })
            }
            Ok(_) => Ok(SaveResult::Saved { hash: self.write_atomic(path, bytes)?, front_matter: None, meta: Default::default() }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Ok(SaveResult::Saved { hash: self.write_atomic(path, bytes)?, front_matter: None, meta: Default::default() })
            }
            Err(e) => Err(e),
        }
    }

    pub fn rename(&self, from: &Path, new_title: &str) -> io::Result<PathBuf> {
        let name = from.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let old = parse_note_file(from).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let ext = &name[old.title.len()..];
        let stem = title_to_stem(new_title);
        let to = from.with_file_name(format!("{stem}{ext}"));
        if to == from {
            return Ok(to);
        }
        let wanted = fold(&stem);
        if self.list()?.iter().any(|(p, n, _)| p != from && fold(&n.title) == wanted) {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        if fold(&old.title) == wanted {
            // case-only: hop via a temp name so case-insensitive filesystems accept it
            let tmp = from.with_file_name(format!(".{name}.rename"));
            std::fs::rename(from, &tmp)?;
            if let Err(e) = std::fs::rename(&tmp, &to) {
                let _ = std::fs::rename(&tmp, from);
                return Err(e);
            }
        } else {
            // rename() replaces silently on Unix; residual race between this check and the rename is accepted
            if to.symlink_metadata().is_ok() {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            std::fs::rename(from, &to)?;
        }
        Ok(to)
    }

    pub fn take_self_write(&self, path: &Path, bytes: &[u8]) -> bool {
        let mut m = self.self_writes.lock().unwrap();
        if m.get(path).is_some_and(|h| *h == hash(bytes)) {
            m.remove(path);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sorted_titles(v: &[(PathBuf, NoteFile, Meta)]) -> Vec<String> {
        let mut t: Vec<String> = v.iter().map(|(_, n, _)| n.title.clone()).collect();
        t.sort();
        t
    }

    #[test] fn list_flat_filters() {
        let d = tempfile::tempdir().unwrap();
        for f in ["a.md", "b.txt", "c.md.age", ".h.md", "e.png"] { fs::write(d.path().join(f), "x").unwrap(); }
        fs::create_dir(d.path().join("sub")).unwrap();
        fs::write(d.path().join("sub/d.md"), "x").unwrap();
        let store = Store::new(d.path().to_path_buf());
        assert_eq!(sorted_titles(&store.list().unwrap()), vec!["a", "b", "c"]);
    }
    #[test] fn atomic_write_and_self_write() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        let p = d.path().join("a.md");
        let h = s.write_atomic(&p, b"hi").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"hi");
        assert!(s.take_self_write(&p, b"hi")); assert!(!s.take_self_write(&p, b"hi")); assert_eq!(h, hash(b"hi"));
        assert_eq!(fs::read_dir(d.path()).unwrap().count(), 1);
    }
    #[test] fn save_detects_conflict() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        let p = d.path().join("a.md");
        s.write_atomic(&p, b"v1").unwrap(); std::fs::write(&p, b"external").unwrap();
        match s.save(&p, b"mine", &hash(b"v1")).unwrap() { SaveResult::Conflict { conflict_path, disk_hash } => {
            assert!(conflict_path.contains("(conflict ")); assert_eq!(std::fs::read(&conflict_path).unwrap(), b"mine");
            assert_eq!(std::fs::read(&p).unwrap(), b"external"); assert_eq!(disk_hash, hash(b"external")); } _ => panic!() }
    }
    #[test] fn save_conflict_age_suffix() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        let p = d.path().join("a.md.age");
        fs::write(&p, b"external").unwrap();
        match s.save(&p, b"mine", "stale").unwrap() {
            SaveResult::Conflict { conflict_path, .. } => assert!(conflict_path.ends_with(".md.age")),
            _ => panic!(),
        }
    }
    #[test] fn save_missing_file_writes() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        assert!(matches!(s.save(&d.path().join("gone.md"), b"x", "stale").unwrap(), SaveResult::Saved { .. }));
    }
    #[test] fn rename_collision_and_case_only() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        let a = d.path().join("a.md"); fs::write(&a, "a").unwrap(); fs::write(d.path().join("b.md"), "b").unwrap();
        assert_eq!(s.rename(&a, "B").unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        let p = s.rename(&a, "A").unwrap(); assert_eq!(p.file_name().unwrap(), "A.md");
        assert_eq!(fs::read(&p).unwrap(), b"a");
        assert_eq!(sorted_titles(&s.list().unwrap()), vec!["A", "b"]);
    }
    #[test] fn save_conflicts_do_not_clobber() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        let p = d.path().join("a.md");
        fs::write(&p, b"external").unwrap();
        let mut paths = Vec::new();
        for c in [&b"mine1"[..], b"mine2"] {
            match s.save(&p, c, "stale").unwrap() { SaveResult::Conflict { conflict_path, .. } => paths.push(conflict_path), _ => panic!() }
        }
        assert_ne!(paths[0], paths[1]);
        assert_eq!(fs::read(&paths[0]).unwrap(), b"mine1");
        assert_eq!(fs::read(&paths[1]).unwrap(), b"mine2");
    }
    #[test] fn clean_leftovers_removes_tmp_and_restores_rename() {
        let d = tempfile::tempdir().unwrap();
        let st = Store::new(d.path().to_path_buf());
        fs::write(d.path().join(".Secret.md.tmp"), "plain").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        fs::File::options().write(true).open(d.path().join(".Secret.md.tmp")).unwrap().set_modified(old).unwrap();
        fs::write(d.path().join(".Busy.md.tmp"), "in flight").unwrap();
        fs::write(d.path().join(".Foo.md.rename"), "foo").unwrap();
        fs::write(d.path().join(".Bar.md.rename"), "old").unwrap();
        fs::write(d.path().join("Bar.md"), "kept").unwrap();
        fs::write(d.path().join(".other.tmp"), "not a note's").unwrap();
        st.clean_leftovers();
        assert!(!d.path().join(".Secret.md.tmp").exists());
        assert!(d.path().join(".Busy.md.tmp").exists(), "a fresh tmp may be another process's write");
        assert_eq!(fs::read_to_string(d.path().join("Foo.md")).unwrap(), "foo");
        assert_eq!(fs::read_to_string(d.path().join("Bar.md")).unwrap(), "kept");
        assert!(d.path().join(".Bar.md.rename").exists(), "never replaces a note");
        assert!(d.path().join(".other.tmp").exists());
    }
    #[test] fn rename_onto_existing_non_note_refused() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().to_path_buf());
        let a = d.path().join("a.md"); fs::write(&a, "a").unwrap();
        fs::create_dir(d.path().join("B.md")).unwrap();
        assert_eq!(s.rename(&a, "B").unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&a).unwrap(), b"a");
        assert!(d.path().join("B.md").is_dir());
    }
}
