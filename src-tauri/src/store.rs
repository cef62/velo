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
    Saved { hash: String },
    Conflict { conflict_path: String, disk_hash: String },
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
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            out.push((path, note, Meta { mtime, size: md.len() }));
        }
        Ok(out)
    }

    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    pub fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<String> {
        let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let tmp = path.with_file_name(format!(".{name}.tmp"));
        let res = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path));
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
                let conflict = path.with_file_name(format!("{stem} (conflict {stamp}).{ext}"));
                self.write_atomic(&conflict, bytes)?;
                Ok(SaveResult::Conflict {
                    conflict_path: conflict.to_string_lossy().into_owned(),
                    disk_hash: hash(&disk),
                })
            }
            Ok(_) => Ok(SaveResult::Saved { hash: self.write_atomic(path, bytes)? }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Ok(SaveResult::Saved { hash: self.write_atomic(path, bytes)? })
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
}
