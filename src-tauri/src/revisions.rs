use crate::text::fold;
use serde::Serialize;
use std::io;
use std::path::PathBuf;

const THROTTLE_MS: i64 = 600_000;
const RETAIN_MS: i64 = 30 * 86_400_000;
const PRUNE_EVERY_MS: i64 = 86_400_000;
/// Subfolder of a note's history for snapshots held back for a locked note (`hold`).
const HELD: &str = "held";

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

/// Writes `b` to a new file at `p`, replacing whatever is at that name (`create_tmp`): a FIFO would block the write, a
/// link (`free_id` sees a dangling one as free) would send it elsewhere.
fn write_new(p: &std::path::Path, b: &[u8]) -> io::Result<()> {
    io::Write::write_all(&mut crate::store::create_tmp(p)?, b)
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
                // a regular snapshot only (from its directory entry, never opened): a FIFO would block the save that
                // reads the newest one; a non-regular sidecar counts as none
                let size = e.metadata().ok().filter(|m| m.is_file())?.len();
                let side = crate::store::read_regular(&self.dir(title).join(format!("{ts}.json"))).ok().and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok());
                Some(RevisionInfo { ts, id, size, agent: side.is_some(), summary: side.map(|s| s.summary) })
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
            if fnv64_bytes(&crate::store::read_regular(&self.dir(title).join(&newest.id))?) == fnv64_bytes(bytes) {
                return Ok(false);
            }
        }
        let dir = self.dir(title);
        std::fs::create_dir_all(&dir)?;
        let (_, id) = free_id(&dir, now_ms, encrypted);
        write_new(&dir.join(id), bytes)?;
        Ok(true)
    }

    /// An agent's pre-write snapshot: never throttled or skipped, with its summary in a `<ms>.json` sidecar.
    /// Same-ms ids bump by 1 ms. Returns the snapshot id.
    pub fn snapshot_agent(&self, title: &str, bytes: &[u8], encrypted: bool, now_ms: i64, summary: &str) -> io::Result<String> {
        let dir = self.dir(title);
        std::fs::create_dir_all(&dir)?;
        let (ms, id) = free_id(&dir, now_ms, encrypted);
        write_new(&dir.join(&id), bytes)?;
        write_new(&dir.join(format!("{ms}.json")), &serde_json::to_vec(&Sidecar { summary: summary.into(), agent: true })?)?;
        Ok(id)
    }

    pub fn read(&self, title: &str, id: &str) -> io::Result<(Vec<u8>, bool)> {
        if id.contains(['/', '\\']) || id.contains("..") {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        Ok((crate::store::read_regular(&self.dir(title).join(id))?, id.ends_with(".age")))
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
        // each snapshot moves with its sidecar, to a free id when the target already uses its own; oldest first, so
        // bumped ids keep the moved history in order
        for info in self.list(old_title).into_iter().rev() {
            let (ms, id) = free_id(&to, info.ts, info.id.ends_with(".age"));
            if std::fs::rename(from.join(&info.id), to.join(id)).is_ok() {
                std::fs::rename(from.join(format!("{}.json", info.ts)), to.join(format!("{ms}.json"))).ok();
            }
        }
        // orphan sidecars (no snapshot left beside them) go; a snapshot that failed to move keeps its own
        if let Ok(rd) = std::fs::read_dir(&from) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(ts) = name.strip_suffix(".json") else { continue };
                if !from.join(format!("{ts}.md")).exists() && !from.join(format!("{ts}.md.age")).exists() {
                    std::fs::remove_file(e.path()).ok();
                }
            }
        }
        std::fs::remove_dir(&from).ok();
    }

    /// Replace every plaintext snapshot of the note by its encrypted twin; plaintext is removed only after the twin is written.
    /// An entry that is not a regular file (a FIFO, a folder, a link; from its directory entry, never opened) is
    /// skipped and kept. A regular one: a snapshot that can't be read is an error (`lock_note` then fails before
    /// anything else changes), and a sidecar that can't be read or parsed is scrubbed. Reads go through `read_regular`,
    /// so a file swapped for a FIFO after that check fails instead of blocking; writes replace what is at their name
    /// (`create_tmp`). Any error stops the rest of the folder: snapshots already encrypted stay so, the others stay
    /// plaintext.
    pub fn encrypt_all(&self, title: &str, encrypt: impl Fn(&[u8]) -> anyhow::Result<Vec<u8>>) -> anyhow::Result<()> {
        let dir = self.dir(title);
        let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(()) };
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| !t.is_file()) {
                continue;
            }
            let p = e.path();
            if p.extension().is_some_and(|x| x == "md") {
                write_new(&p.with_extension("md.age"), &encrypt(&crate::store::read_regular(&p)?)?)?;
                std::fs::remove_file(&p)?;
            } else if p.extension().is_some_and(|x| x == "json")
                && crate::store::read_regular(&p).ok().and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok()).is_none_or(|s| !s.summary.is_empty())
            {
                // an agent summary is plaintext about the note: drop it, keep the agent mark
                write_new(&p, &serde_json::to_vec(&Sidecar { summary: String::new(), agent: true })?)?;
            }
        }
        Ok(())
    }

    /// Whether the note has a plaintext snapshot (what `encrypt_all` would encrypt).
    pub fn has_plain(&self, title: &str) -> bool {
        std::fs::read_dir(self.dir(title)).is_ok_and(|rd| rd.flatten().any(|e| e.path().extension().is_some_and(|x| x == "md")))
    }

    /// The note's `held/` folder when it is a real folder (never through a link).
    fn held_dir(&self, title: &str) -> Option<PathBuf> {
        let h = self.dir(title).join(HELD);
        h.symlink_metadata().is_ok_and(|m| m.is_dir()).then_some(h)
    }

    pub fn has_held(&self, title: &str) -> bool {
        self.held_dir(title).is_some()
    }

    /// Hold back every plaintext snapshot of the note, with its sidecar (a summary is plaintext too): moved into
    /// `held/`, which no reader lists or reads (`list` takes regular files only, `read` refuses a `/`), so no note
    /// ever shows it, whatever happens to the locked note. Only `release_held` (a key that opens the locked note) or
    /// `prune` takes it out. Each move is one rename, snapshot first: a crash in between leaves an orphan sidecar,
    /// never listed. Only regular entries move. Fails closed: a snapshot that can't be moved (a file, link or FIFO at
    /// `held`, never moved through; a full disk; a read-only folder) is deleted with its sidecar, as before `held/`.
    /// Errs only when that delete fails too: the snapshot then stays listable by a plain note with this title.
    pub fn hold(&self, title: &str) -> io::Result<()> {
        let dir = self.dir(title);
        let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(()) };
        let held = dir.join(HELD);
        let blocked = held.symlink_metadata().is_ok_and(|m| !m.is_dir());
        let mut r = Ok(());
        for e in rd.flatten() {
            let (p, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
            let Some(ts) = ts_of(&name).filter(|_| name.ends_with(".md") && e.file_type().is_ok_and(|t| t.is_file())) else { continue };
            let side = dir.join(format!("{ts}.json"));
            let moved = if blocked { Err(io::ErrorKind::AlreadyExists.into()) } else {
                std::fs::create_dir_all(&held).and_then(|()| {
                    let (ms, id) = free_id(&held, ts, false);
                    std::fs::rename(&p, held.join(id)).map(|()| ms)
                })
            };
            match moved {
                Ok(ms) => std::fs::rename(&side, held.join(format!("{ms}.json"))).ok(),
                Err(_) => {
                    r = r.and(std::fs::remove_file(&p));
                    std::fs::remove_file(&side).ok()
                }
            };
        }
        r
    }

    /// A locked note's rename takes its held-back set along, still held (a plain note's rename never does: the set is
    /// the locked note's). shortcut: when the target already holds a set, this one stays (hidden, pruned); merge them
    /// if renames onto such a title turn out to matter.
    pub fn rename_held(&self, old_title: &str, new_title: &str) {
        let to = self.dir(new_title);
        if let Some(held) = self.held_dir(old_title) && to.join(HELD).symlink_metadata().is_err() && std::fs::create_dir_all(&to).is_ok() {
            std::fs::rename(held, to.join(HELD)).ok();
            std::fs::remove_dir(self.dir(old_title)).ok(); // only when empty
        }
    }

    /// Encrypt the held-back snapshots back into the note's history (sidecars scrubbed, as in `encrypt_all`). Per
    /// snapshot: ciphertext and sidecar first, then the plaintext, then its held sidecar; a crash before the plaintext
    /// goes leaves it held (hidden) and a second encrypted copy at the next release. Reads go through `read_regular`; non-regular entries
    /// stay. Any error stops the rest, which stays held.
    pub fn release_held(&self, title: &str, encrypt: impl Fn(&[u8]) -> anyhow::Result<Vec<u8>>) -> anyhow::Result<()> {
        let (dir, Some(held)) = (self.dir(title), self.held_dir(title)) else { return Ok(()) };
        for e in std::fs::read_dir(&held)?.flatten() {
            let (p, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
            let Some(ts) = ts_of(&name).filter(|_| name.ends_with(".md") && e.file_type().is_ok_and(|t| t.is_file())) else { continue };
            let (ms, id) = free_id(&dir, ts, true);
            write_new(&dir.join(id), &encrypt(&crate::store::read_regular(&p)?)?)?;
            let side = held.join(format!("{ts}.json"));
            if side.symlink_metadata().is_ok() {
                write_new(&dir.join(format!("{ms}.json")), &serde_json::to_vec(&Sidecar { summary: String::new(), agent: true })?)?;
            }
            std::fs::remove_file(&p)?;
            std::fs::remove_file(&side).ok(); // after the plaintext: one that can't go (a folder) never repeats the release
        }
        std::fs::remove_dir(&held).ok(); // only when empty
        Ok(())
    }

    pub fn prune(&self, now_ms: i64) {
        let Ok(rd) = std::fs::read_dir(&self.root) else { return };
        let prune_dir = |dir: &std::path::Path| {
            if let Ok(files) = std::fs::read_dir(dir) {
                for f in files.flatten() {
                    if ts_of(&f.file_name().to_string_lossy()).is_some_and(|t| now_ms - t > RETAIN_MS) {
                        std::fs::remove_file(f.path()).ok();
                    }
                }
            }
            std::fs::remove_dir(dir).ok(); // only succeeds when empty
        };
        for d in rd.flatten() {
            let held = d.path().join(HELD);
            if held.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                prune_dir(&held);
            }
            prune_dir(&d.path());
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
    /// Clashes are resolved oldest first, so the moved history keeps its order.
    #[test] fn rename_merge_keeps_source_order() {
        let r = rev();
        r.snapshot_bytes("old", b"older", false, 10, false).unwrap();
        r.snapshot_bytes("old", b"newer", false, 11, false).unwrap();
        r.snapshot_bytes("new", b"target", false, 10, false).unwrap();
        r.rename("old", "new");
        let l = r.list("new");
        let texts: Vec<Vec<u8>> = l.iter().map(|x| r.read("new", &x.id).unwrap().0).collect();
        let pos = |t: &[u8]| texts.iter().position(|x| x == t).unwrap();
        assert!(pos(b"newer") < pos(b"older"), "newest first: {:?}", l.iter().map(|x| &x.id).collect::<Vec<_>>());
    }
    /// A snapshot that could not move keeps its sidecar (its agent label and summary).
    #[cfg(unix)]
    #[test] fn failed_merge_move_keeps_the_sidecar() {
        use std::os::unix::fs::PermissionsExt;
        let r = rev();
        r.snapshot_agent("old", b"a", false, 10, "why").unwrap();
        r.snapshot_bytes("new", b"b", false, 20, false).unwrap();
        std::fs::set_permissions(r.dir("new"), std::fs::Permissions::from_mode(0o555)).unwrap();
        r.rename("old", "new");
        std::fs::set_permissions(r.dir("new"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(r.list("old").first().and_then(|x| x.summary.clone()).as_deref(), Some("why"));
    }
    /// #170 Copilot: a regular sidecar that can't be read is scrubbed, as on `main` (its summary may be plaintext
    /// about the note); only a non-regular entry is skipped.
    #[cfg(unix)]
    #[test] fn encrypt_all_scrubs_an_unreadable_sidecar() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root reads a mode-000 file
        }
        let r = rev();
        r.snapshot_agent("n", b"a", false, 10, "secret why").unwrap();
        let side = r.dir("n").join("10.json");
        std::fs::set_permissions(&side, std::fs::Permissions::from_mode(0o000)).unwrap();
        r.encrypt_all("n", |b| Ok(b.to_vec())).unwrap();
        let b = std::fs::read(&side).expect("replaced by a readable sidecar");
        assert!(!String::from_utf8_lossy(&b).contains("secret"), "no plaintext summary left");
        assert_eq!(r.list("n")[0].id, "10.md.age");
    }
    /// #158: a FIFO named like a snapshot is never listed, so a save never reads it as the newest; reading it by id
    /// fails instead of blocking.
    #[cfg(unix)]
    #[test] fn a_fifo_snapshot_is_never_listed_or_read() {
        let r = rev();
        r.snapshot_bytes("n", b"a", false, 10, false).unwrap();
        crate::store::fifo::make(&r.dir("n").join("20.md"));
        let (listed, read_fails, saved) = crate::store::fifo::within("FIFO snapshot", move || {
            let listed: Vec<String> = r.list("n").into_iter().map(|x| x.id).collect();
            (listed, r.read("n", "20.md").is_err(), r.snapshot_bytes("n", b"b", false, 30, false).unwrap())
        });
        assert_eq!((listed, read_fails, saved), (vec!["10.md".to_string()], true, true));
    }
    /// #158: a snapshot and its sidecar replace a link at their names (`free_id` sees a dangling one as free), never
    /// writing through it to a file outside the history folder.
    #[cfg(unix)]
    #[test] fn a_snapshot_never_writes_through_a_link_at_its_name() {
        let r = rev();
        std::fs::create_dir_all(r.dir("n")).unwrap();
        let outside = tempfile::tempdir().unwrap().keep();
        for n in ["5.md", "5.json"] {
            std::os::unix::fs::symlink(outside.join(n), r.dir("n").join(n)).unwrap();
        }
        assert_eq!(r.snapshot_agent("n", b"a", false, 5, "why").unwrap(), "5.md");
        assert!(!outside.join("5.md").exists() && !outside.join("5.json").exists(), "nothing written through");
        assert_eq!((r.read("n", "5.md").unwrap().0, r.list("n")[0].summary.as_deref()), (b"a".to_vec(), Some("why")));
    }
    #[test] fn sidecar_follows_rename_prune_encrypt() {
        let r = rev();
        let now = 100 * 86_400_000;
        r.snapshot_agent("old", b"a", false, 10, "why").unwrap();
        r.rename("old", "new");
        assert_eq!(r.list("new")[0].summary.as_deref(), Some("why"));
        r.encrypt_all("new", |b| Ok(b.to_vec())).unwrap();
        let l = r.list("new");
        // a locked note's summary is plaintext about it: gone, the agent mark stays
        assert_eq!((l.len(), l[0].id.as_str(), l[0].summary.as_deref(), l[0].agent), (1, "10.md.age", Some(""), true));
        assert!(!std::fs::read_to_string(r.dir("new").join("10.json")).unwrap().contains("why"));
        r.prune(now);
        assert!(!r.dir("new").exists(), "pair pruned, dir gone");
    }
    /// #158: a held-back snapshot and its sidecar are listed and read by no one; the release encrypts them back with
    /// the summary scrubbed, beside a later plaintext snapshot it leaves alone; the prune removes a held set.
    #[test] fn hold_hides_release_encrypts_prune_removes() {
        let r = rev();
        r.snapshot_agent("n", b"secret", false, 10, "why").unwrap();
        r.hold("n").unwrap();
        assert!(r.list("n").is_empty() && r.read("n", "10.md").is_err() && r.read("n", "held/10.md").is_err());
        assert!(r.has_held("n") && !r.has_plain("n") && !r.dir("n").join("10.json").exists(), "the sidecar is held too");
        r.snapshot_bytes("n", b"later", false, 20, false).unwrap(); // a later note's own
        r.release_held("n", |b| Ok(b.iter().rev().cloned().collect())).unwrap();
        let l = r.list("n");
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["20.md", "10.md.age"]);
        assert_eq!((r.read("n", "10.md.age").unwrap().0, l[1].summary.as_deref()), (b"terces".to_vec(), Some("")));
        assert_eq!(r.read("n", "20.md").unwrap().0, b"later", "left as it is");
        assert!(!r.has_held("n"));
        r.hold("n").unwrap();
        r.prune(100 * 86_400_000);
        assert!(!r.dir("n").exists(), "the held set is pruned");
    }
    /// #180 Copilot: a held sidecar that can't be removed (a folder) never makes a later release encrypt the snapshot
    /// again.
    #[test] fn a_stuck_held_sidecar_never_repeats_the_release() {
        let r = rev();
        r.snapshot_bytes("n", b"a", false, 10, false).unwrap();
        r.hold("n").unwrap();
        std::fs::create_dir(r.dir("n").join(HELD).join("10.json")).unwrap();
        for _ in 0..2 {
            r.release_held("n", |b| Ok(b.to_vec())).unwrap();
        }
        assert_eq!(r.list("n").len(), 1);
    }
    /// #158 (#180 review m2): `hold` never moves snapshots through a link, file or FIFO at `held`, and fails closed:
    /// what it can't move is deleted with its sidecar, never left listable.
    #[cfg(unix)]
    #[test] fn hold_never_moves_through_a_link_and_fails_closed() {
        for kind in ["link", "file", "fifo"] {
            let r = rev();
            r.snapshot_agent("n", b"a", false, 10, "why").unwrap();
            let outside = tempfile::tempdir().unwrap();
            let held = r.dir("n").join(HELD);
            match kind {
                "link" => std::os::unix::fs::symlink(outside.path(), &held).unwrap(),
                "file" => std::fs::write(&held, "x").unwrap(),
                _ => crate::store::fifo::make(&held),
            }
            r.hold("n").unwrap();
            assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none(), "{kind}: nothing moved out");
            assert!(r.list("n").is_empty() && !r.has_plain("n") && !r.dir("n").join("10.json").exists(), "{kind}: deleted");
        }
    }
}
