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
    /// agent write summary, from the `<ms>.json` sidecar
    pub summary: Option<String>,
    pub agent: bool,
}

#[derive(Serialize, serde::Deserialize)]
struct Sidecar {
    summary: String,
    agent: bool,
}

pub struct Revisions {
    root: PathBuf,
    last_prune: i64,
}

fn ts_of(name: &str) -> Option<i64> {
    name.split('.').next()?.parse().ok()
}

/// First snapshot id at or after `now_ms` that no snapshot uses yet (same-ms ids bump by 1 ms).
fn free_id(dir: &std::path::Path, now_ms: i64, encrypted: bool) -> (i64, String) {
    let mut ms = now_ms;
    // an orphan sidecar (its snapshot gone) counts as taken, or the new snapshot would inherit its summary
    while dir.join(format!("{ms}.md")).exists() || dir.join(format!("{ms}.md.age")).exists() || dir.join(format!("{ms}.json")).exists() {
        ms += 1;
    }
    (ms, format!("{ms}.{}", if encrypted { "md.age" } else { "md" }))
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
                if !(id.ends_with(".md") || id.ends_with(".md.age")) {
                    return None; // sidecars are never snapshots
                }
                let ts = ts_of(&id)?;
                let side = std::fs::read(self.dir(title).join(format!("{ts}.json"))).ok().and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok());
                Some(RevisionInfo { ts, id, size: e.metadata().ok()?.len(), agent: side.is_some(), summary: side.map(|s| s.summary) })
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
        let (_, id) = free_id(&dir, now_ms, encrypted);
        std::fs::write(dir.join(id), bytes)?;
        Ok(true)
    }

    /// An agent's pre-write snapshot: never throttled or skipped, with its summary in a `<ms>.json` sidecar.
    /// Same-ms ids bump by 1 ms. Returns the snapshot id.
    pub fn snapshot_agent(&self, title: &str, bytes: &[u8], encrypted: bool, now_ms: i64, summary: &str) -> io::Result<String> {
        let dir = self.dir(title);
        std::fs::create_dir_all(&dir)?;
        let (ms, id) = free_id(&dir, now_ms, encrypted);
        std::fs::write(dir.join(&id), bytes)?;
        std::fs::write(dir.join(format!("{ms}.json")), serde_json::to_vec(&Sidecar { summary: summary.into(), agent: true })?)?;
        Ok(id)
    }

    pub fn read(&self, title: &str, id: &str) -> io::Result<(Vec<u8>, bool)> {
        if id.contains(['/', '\\']) || id.contains("..") {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        Ok((std::fs::read(self.dir(title).join(id))?, id.ends_with(".age")))
    }

    /// Deletes snapshot `id` and its sidecar.
    pub fn remove(&self, title: &str, id: &str) {
        if id.contains(['/', '\\']) || id.contains("..") {
            return;
        }
        std::fs::remove_file(self.dir(title).join(id)).ok();
        if let Some(ts) = ts_of(id) {
            std::fs::remove_file(self.dir(title).join(format!("{ts}.json"))).ok();
        }
    }

    pub fn rename(&self, old_title: &str, new_title: &str) {
        let (from, to) = (self.dir(old_title), self.dir(new_title));
        if from == to || !from.exists() {
            return;
        }
        if std::fs::create_dir_all(&to).is_err() {
            return;
        }
        // each snapshot moves with its sidecar, to a free id when the target already uses its own
        for info in self.list(old_title) {
            let (ms, id) = free_id(&to, info.ts, info.id.ends_with(".age"));
            if std::fs::rename(from.join(&info.id), to.join(id)).is_ok() {
                std::fs::rename(from.join(format!("{}.json", info.ts)), to.join(format!("{ms}.json"))).ok();
            }
        }
        // what is left are orphan sidecars, whose snapshot is gone
        if let Ok(rd) = std::fs::read_dir(&from) {
            for e in rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")) {
                std::fs::remove_file(e.path()).ok();
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
                std::fs::write(p.with_extension("md.age"), encrypt(&std::fs::read(&p)?)?)?; // the .json sidecar stays plain
                std::fs::remove_file(&p)?;
            }
        }
        Ok(())
    }

    /// Delete every plaintext snapshot of the note (no key to encrypt them with).
    pub fn remove_plain(&self, title: &str) -> io::Result<()> {
        let Ok(rd) = std::fs::read_dir(self.dir(title)) else { return Ok(()) };
        for e in rd.flatten() {
            if e.path().extension().is_some_and(|x| x == "md") {
                std::fs::remove_file(e.path())?;
                std::fs::remove_file(e.path().with_extension("json")).ok();
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
    #[test] fn agent_snapshot_ignores_throttle_and_stores_summary() {
        let r = rev();
        r.snapshot_agent("n", b"a", false, 1000, "first").unwrap();
        r.snapshot_agent("n", b"b", false, 2000, "second").unwrap();
        let l = r.list("n");
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].summary.as_deref(), l[0].agent), (Some("second"), true));
        assert_eq!(l[1].summary.as_deref(), Some("first"));
        r.snapshot_bytes("n", b"c", false, 3000, false).unwrap();
        assert_eq!((r.list("n")[0].summary.clone(), r.list("n")[0].agent), (None, false));
    }
    #[test] fn plain_snapshot_never_overwrites_agent_snapshot() {
        let r = rev();
        r.snapshot_agent("n", b"agent", false, 7, "mine").unwrap();
        r.snapshot_bytes("n", b"user", false, 7, false).unwrap();
        let l = r.list("n");
        assert_eq!(l.len(), 2);
        let a = l.iter().find(|x| x.agent).unwrap();
        assert_eq!((r.read("n", &a.id).unwrap().0, a.summary.as_deref()), (b"agent".to_vec(), Some("mine")));
    }
    #[test] fn same_ms_bumps() {
        let r = rev();
        assert_eq!(r.snapshot_agent("n", b"a", false, 5, "x").unwrap(), "5.md");
        assert_eq!(r.snapshot_agent("n", b"a", false, 5, "y").unwrap(), "6.md");
        assert_eq!(r.list("n").len(), 2);
    }
    #[test] fn orphan_sidecar_is_never_inherited() {
        let r = rev();
        std::fs::create_dir_all(r.dir("n")).unwrap();
        std::fs::write(r.dir("n").join("5.json"), r#"{"summary":"stale","agent":true}"#).unwrap(); // its snapshot is gone
        r.snapshot_bytes("n", b"x", false, 5, false).unwrap();
        assert_eq!(r.list("n").iter().map(|x| (x.id.as_str(), x.agent)).collect::<Vec<_>>(), [("6.md", false)]);
    }
    #[test] fn rename_merge_keeps_snapshot_and_sidecar_together() {
        let r = rev();
        r.snapshot_agent("old", b"agent", false, 10, "why").unwrap();
        std::fs::write(r.dir("old").join("3.json"), r#"{"summary":"orphan","agent":true}"#).unwrap();
        r.snapshot_bytes("new", b"plain", false, 10, false).unwrap(); // same id in the target
        r.rename("old", "new");
        let l = r.list("new");
        assert_eq!(l.len(), 2, "nothing left behind");
        let a = l.iter().find(|x| x.agent).unwrap();
        assert_eq!((r.read("new", &a.id).unwrap().0, a.summary.as_deref()), (b"agent".to_vec(), Some("why")));
        assert_eq!(r.read("new", "10.md").unwrap().0, b"plain");
        assert!(!l.iter().any(|x| x.summary.as_deref() == Some("orphan")) && !r.dir("new").join("3.json").exists());
        assert!(!r.dir("old").exists());
    }
    #[test] fn sidecar_follows_rename_prune_encrypt() {
        let r = rev();
        let now = 100 * 86_400_000;
        r.snapshot_agent("old", b"a", false, 10, "why").unwrap();
        r.rename("old", "new");
        assert_eq!(r.list("new")[0].summary.as_deref(), Some("why"));
        r.encrypt_all("new", |b| Ok(b.to_vec())).unwrap();
        let l = r.list("new");
        assert_eq!((l.len(), l[0].id.as_str(), l[0].summary.as_deref()), (1, "10.md.age", Some("why")));
        assert!(r.dir("new").join("10.json").exists());
        r.prune(now);
        assert!(!r.dir("new").exists(), "pair pruned, dir gone");
        r.snapshot_agent("p", b"a", false, 10, "z").unwrap();
        r.remove_plain("p").unwrap();
        assert!(!r.dir("p").join("10.json").exists());
    }
}
