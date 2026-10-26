use crate::text::fold;
use serde::Serialize;
use std::io;
use std::path::PathBuf;

const THROTTLE_MS: i64 = 600_000;
const RETAIN_MS: i64 = 30 * 86_400_000;
const PRUNE_EVERY_MS: i64 = 86_400_000;

/// Hand-written FNV-1a 64 (hex) so folder names survive toolchain updates, unlike `DefaultHasher`.
pub fn fnv64(s: &str) -> String {
    fnv64_bytes(s.as_bytes())
}

fn fnv64_bytes(b: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &x in b {
        h = (h ^ x as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// One folder per note, keyed by folded title so lock/unlock (`.md` <-> `.md.age`) keeps one history.
pub fn key_for(title: &str) -> String {
    fnv64(&fold(title))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RevisionInfo {
    /// file name
    pub id: String,
    /// epoch ms
    pub ts: i64,
    pub size: u64,
}

pub struct Revisions {
    root: PathBuf,
    last_prune: i64,
}

fn ts_of(name: &str) -> Option<i64> {
    name.split('.').next()?.parse().ok()
}

impl Revisions {
    pub fn new(root: PathBuf) -> Revisions {
        Revisions { root, last_prune: 0 }
    }

    fn dir(&self, title: &str) -> PathBuf {
        self.root.join(key_for(title))
    }

    pub fn list(&self, title: &str) -> Vec<RevisionInfo> {
        let Ok(rd) = std::fs::read_dir(self.dir(title)) else { return vec![] };
        let mut v: Vec<_> = rd
            .flatten()
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().into_owned();
                Some(RevisionInfo { ts: ts_of(&id)?, id, size: e.metadata().ok()?.len() })
            })
            .collect();
        v.sort_by(|a, b| b.ts.cmp(&a.ts));
        v
    }

    /// Skips identical-to-newest bytes, and (when `throttle`) a newest snapshot under 10 minutes old.
    /// Ciphertext differs on every encryption, so the identical check only helps plain notes.
    pub fn snapshot_bytes(&self, title: &str, bytes: &[u8], encrypted: bool, now_ms: i64, throttle: bool) -> io::Result<bool> {
        if let Some(newest) = self.list(title).first() {
            if throttle && now_ms - newest.ts < THROTTLE_MS {
                return Ok(false);
            }
            if fnv64_bytes(&std::fs::read(self.dir(title).join(&newest.id))?) == fnv64_bytes(bytes) {
                return Ok(false);
            }
        }
        let dir = self.dir(title);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(format!("{now_ms}.{}", if encrypted { "md.age" } else { "md" })), bytes)?;
        Ok(true)
    }

    pub fn read(&self, title: &str, id: &str) -> io::Result<(Vec<u8>, bool)> {
        if id.contains(['/', '\\']) || id.contains("..") {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        Ok((std::fs::read(self.dir(title).join(id))?, id.ends_with(".age")))
    }

    pub fn rename(&self, old_title: &str, new_title: &str) {
        let (from, to) = (self.dir(old_title), self.dir(new_title));
        if from == to || !from.exists() {
            return;
        }
        if std::fs::create_dir_all(&to).is_err() {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(&from) {
            for e in rd.flatten() {
                if !to.join(e.file_name()).exists() {
                    std::fs::rename(e.path(), to.join(e.file_name())).ok();
                }
            }
        }
        std::fs::remove_dir(&from).ok();
    }

    /// Replace every plaintext snapshot of the note by its encrypted twin; plaintext is removed only after the twin is written.
    pub fn encrypt_all(&self, title: &str, encrypt: impl Fn(&[u8]) -> anyhow::Result<Vec<u8>>) -> anyhow::Result<()> {
        let dir = self.dir(title);
        let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(()) };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "md") {
                std::fs::write(p.with_extension("md.age"), encrypt(&std::fs::read(&p)?)?)?;
                std::fs::remove_file(&p)?;
            }
        }
        Ok(())
    }

    pub fn prune(&self, now_ms: i64) {
        let Ok(rd) = std::fs::read_dir(&self.root) else { return };
        for d in rd.flatten() {
            if let Ok(files) = std::fs::read_dir(d.path()) {
                for f in files.flatten() {
                    if ts_of(&f.file_name().to_string_lossy()).is_some_and(|t| now_ms - t > RETAIN_MS) {
                        std::fs::remove_file(f.path()).ok();
                    }
                }
            }
            std::fs::remove_dir(d.path()).ok(); // only succeeds when empty
        }
    }

    /// Prune at most once a day; `last_prune` starts at 0 so the first call (vault open) always runs.
    pub fn maybe_prune(&mut self, now_ms: i64) {
        if now_ms - self.last_prune >= PRUNE_EVERY_MS {
            self.last_prune = now_ms;
            self.prune(now_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rev() -> Revisions {
        Revisions::new(tempfile::tempdir().unwrap().keep())
    }

    #[test] fn fnv_vector() { assert_eq!(fnv64(""), "cbf29ce484222325"); assert_eq!(fnv64("a"), "af63dc4c8601ec8c"); }
    #[test] fn key_ignores_case_and_accents() { assert_eq!(key_for("Café"), key_for("cafe")); }
    #[test] fn throttle_and_identical() {
        let r = rev();
        assert!(r.snapshot_bytes("n", b"a", false, 1000, true).unwrap());
        assert!(!r.snapshot_bytes("n", b"b", false, 1000 + 599_999, true).unwrap());
        assert!(r.snapshot_bytes("n", b"b", false, 1000 + 600_000, true).unwrap());
        assert!(!r.snapshot_bytes("n", b"b", false, 9_000_000, false).unwrap()); // identical
        assert!(r.snapshot_bytes("n", b"c", false, 1001 + 600_000, false).unwrap()); // unthrottled
    }
    #[test] fn list_newest_first() {
        let r = rev();
        r.snapshot_bytes("n", b"a", false, 10, false).unwrap();
        r.snapshot_bytes("n", b"b", true, 20, false).unwrap();
        let l = r.list("n");
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["20.md.age", "10.md"]);
        assert_eq!(r.read("n", "10.md").unwrap(), (b"a".to_vec(), false));
        assert!(r.read("n", "../x").is_err());
    }
    #[test] fn prune_old() {
        let r = rev();
        let now = 100 * 86_400_000;
        r.snapshot_bytes("n", b"a", false, now - RETAIN_MS - 1, false).unwrap();
        r.snapshot_bytes("m", b"a", false, now - 1000, false).unwrap();
        r.prune(now);
        assert!(r.list("n").is_empty() && !r.dir("n").exists());
        assert_eq!(r.list("m").len(), 1);
    }
    #[test] fn rename_moves_history() {
        let r = rev();
        r.snapshot_bytes("old", b"a", false, 10, false).unwrap();
        r.rename("old", "new");
        assert!(r.list("old").is_empty());
        assert_eq!(r.list("new").len(), 1);
    }
    #[test] fn encrypt_all_removes_plaintext() {
        let r = rev();
        r.snapshot_bytes("n", b"secret", false, 10, false).unwrap();
        r.encrypt_all("n", |b| Ok(b.iter().rev().cloned().collect())).unwrap();
        assert_eq!(r.list("n")[0].id, "10.md.age");
        assert_eq!(r.read("n", "10.md.age").unwrap().0, b"terces");
    }
}
