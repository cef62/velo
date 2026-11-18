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
    /// How long a change waits for the history lock (`LOCK_WAIT`; shorter in tests).
    wait: std::time::Duration,
    /// Set while a waiter that timed out still blocks on the lock (a stuck holder): later changes then fail at once
    /// instead of each waiting and leaving a thread and a file handle behind, so a stuck holder costs one of each.
    stale: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Test seam: runs inside `claim`, with the lock held, between the snapshot and its sidecar.
    #[cfg(test)]
    pause: Option<Pause>,
}

#[cfg(test)]
type Pause = Box<dyn Fn(&std::path::Path) + Send + Sync>;

fn ts_of(name: &str) -> Option<i64> {
    name.split('.').next()?.parse().ok()
}

/// Writes `b` to a new file at `p`, replacing whatever is at that name (`create_tmp`): a FIFO would block the write, a
/// link would send it elsewhere. Only for names that are not fresh snapshot ids (`claim` never replaces).
fn write_new(p: &std::path::Path, b: &[u8]) -> io::Result<()> {
    io::Write::write_all(&mut crate::store::create_tmp(p)?, b)
}

/// A new file at `p` holding `b`: an exclusive create (`O_EXCL`), so it fails with `AlreadyExists` on anything at `p`
/// (file, FIFO, link, dangling link). A failed write removes the file this call created.
fn put(p: &std::path::Path, b: &[u8]) -> io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(p)?;
    io::Write::write_all(&mut f, b).inspect_err(|_| drop(std::fs::remove_file(p)))
}

/// First snapshot id at or after `ms` with nothing at either spelling or at `<ms>.json` (a file, a FIFO, a link, a
/// dangling link, or an orphan sidecar that a new snapshot would inherit). Same-ms ids bump by 1 ms. Stable only
/// under the history lock.
fn free_id(dir: &std::path::Path, mut ms: i64, encrypted: bool) -> (i64, String) {
    while ["md", "md.age", "json"].iter().any(|e| dir.join(format!("{ms}.{e}")).symlink_metadata().is_ok()) {
        ms += 1;
    }
    (ms, format!("{ms}.{}", if encrypted { "md.age" } else { "md" }))
}

/// How long a history change waits for another to finish. Changes take milliseconds, so only a stuck holder (another
/// process) makes this run out; the change then fails instead of blocking a save.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// The history lock, released on drop (explicitly: Windows may free a closed handle's lock late).
struct Held(std::fs::File);
impl Drop for Held {
    fn drop(&mut self) {
        self.0.unlock().ok();
    }
}

impl Revisions {
    pub fn new(root: PathBuf) -> Revisions {
        Revisions { root, last_prune: 0, wait: LOCK_WAIT, stale: Default::default(), #[cfg(test)] pause: None }
    }

    fn dir(&self, title: &str) -> PathBuf {
        self.root.join(key_for(title))
    }

    /// The lock every change to the history holds (one per root, so `rename` takes it once and nothing nests): no
    /// change starts while another, in this process or another one (`velo --mcp`), is between choosing a name and
    /// filling, moving or removing it. A holder busy for over `LOCK_WAIT` gives `TimedOut`, before anything is written
    /// or removed; while that waiter still waits, later changes give `TimedOut` at once. `None`: the filesystem refuses
    /// locks (or `.lock` can't be opened for writing, or is not a regular file), and the change runs unlocked, as
    /// before the lock.
    fn lock(&self) -> io::Result<Option<Held>> {
        std::fs::create_dir_all(&self.root)?;
        let mut o = std::fs::OpenOptions::new();
        o.create(true).truncate(false).write(true);
        // a FIFO at the name must not block the open, a link must not be followed
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::custom_flags(&mut o, libc::O_NONBLOCK | libc::O_NOFOLLOW);
        let unlocked = |e: &dyn std::fmt::Display| {
            crate::log::line(&format!("revision history not locked: {e}"));
            Ok(None)
        };
        let f = match o.open(self.root.join(".lock")) {
            Ok(f) if f.metadata().is_ok_and(|m| m.is_file()) => f,
            Ok(_) => return unlocked(&"not a regular file"),
            Err(e) => return unlocked(&e),
        };
        match f.try_lock() {
            Ok(()) => return Ok(Some(Held(f))),
            Err(std::fs::TryLockError::Error(e)) => return unlocked(&e),
            Err(std::fs::TryLockError::WouldBlock) => {}
        }
        use std::sync::atomic::Ordering::SeqCst;
        let busy = || io::Error::new(io::ErrorKind::TimedOut, "revision history busy");
        if self.stale.load(SeqCst) {
            return Err(busy()); // an earlier waiter timed out and still waits: the holder is stuck
        }
        // busy: a blocking wait, woken as soon as the holder lets go (polling loses to a holder that locks again at
        // once), on a helper thread so it can time out; a lock it gets after the timeout is released at once
        let (tx, rx) = std::sync::mpsc::channel();
        let stale = self.stale.clone();
        std::thread::spawn(move || {
            if let Err(std::sync::mpsc::SendError(Ok(f))) = tx.send(f.lock().map(|()| f)) {
                drop(Held(f));
            }
            stale.store(false, SeqCst); // after the send: a waiter that timed out has set it already, or takes the lock
        });
        match rx.recv_timeout(self.wait) {
            Ok(r) => r.map(|f| Some(Held(f))), // an error while another party holds the lock never runs unlocked
            Err(_) => {
                self.stale.store(true, SeqCst);
                // the helper may have got the lock just now: take it (and clear the mark) rather than leave the mark set
                rx.try_recv().map_or_else(|_| Err(busy()), |r| {
                    self.stale.store(false, SeqCst);
                    r.map(|f| Some(Held(f)))
                })
            }
        }
    }

    /// Writes a snapshot (and, with `side`, its sidecar) at the first free id at or after `now_ms`, and returns the id.
    /// The caller holds the lock, so the id stays free until both files exist, and nothing is removed or replaced
    /// here. Exclusive creates: anything that appeared at a name anyway fails the write instead of blocking it or being
    /// written through. A failed sidecar leaves the snapshot unlabelled.
    fn claim(&self, dir: &std::path::Path, now_ms: i64, encrypted: bool, bytes: &[u8], side: Option<&[u8]>) -> io::Result<String> {
        std::fs::create_dir_all(dir)?;
        let (ms, id) = free_id(dir, now_ms, encrypted);
        put(&dir.join(&id), bytes)?;
        #[cfg(test)]
        if let Some(pause) = &self.pause {
            pause(&dir.join(&id));
        }
        if let Some(s) = side {
            put(&dir.join(format!("{ms}.json")), s)?;
        }
        Ok(id)
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
        // throttled saves (nearly every save) never touch the lock; the check is advisory, so a race only adds or
        // skips one snapshot
        if throttle && self.list(title).first().is_some_and(|n| now_ms - n.ts < THROTTLE_MS) {
            return Ok(false);
        }
        let _held = self.lock()?;
        if let Some(newest) = self.list(title).first() {
            if throttle && now_ms - newest.ts < THROTTLE_MS {
                return Ok(false);
            }
            if fnv64_bytes(&crate::store::read_regular(&self.dir(title).join(&newest.id))?) == fnv64_bytes(bytes) {
                return Ok(false);
            }
        }
        self.claim(&self.dir(title), now_ms, encrypted, bytes, None)?;
        Ok(true)
    }

    /// An agent's pre-write snapshot: never throttled or skipped, with its summary in a `<ms>.json` sidecar.
    /// Same-ms ids bump by 1 ms. Returns the snapshot id.
    pub fn snapshot_agent(&self, title: &str, bytes: &[u8], encrypted: bool, now_ms: i64, summary: &str) -> io::Result<String> {
        let side = serde_json::to_vec(&Sidecar { summary: summary.into(), agent: true })?;
        let _held = self.lock()?;
        self.claim(&self.dir(title), now_ms, encrypted, bytes, Some(&side))
    }

    pub fn read(&self, title: &str, id: &str) -> io::Result<(Vec<u8>, bool)> {
        // snapshots only: a sidecar (an agent summary, maybe orphaned at the top level by a crash mid-`hold`) is no id
        if id.contains(['/', '\\']) || id.contains("..") || !(id.ends_with(".md") || id.ends_with(".md.age")) {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        Ok((crate::store::read_regular(&self.dir(title).join(id))?, id.ends_with(".age")))
    }

    /// Deletes snapshot `id` and its sidecar.
    pub fn remove(&self, title: &str, id: &str) {
        if id.contains(['/', '\\']) || id.contains("..") {
            return;
        }
        let Ok(_held) = self.lock() else { return };
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
        let _held = match self.lock() {
            Ok(h) => h,
            Err(e) => return crate::log::warn(&format!("velo: history not moved to the renamed note: {e}")),
        };
        if std::fs::create_dir_all(&to).is_err() {
            return;
        }
        // each snapshot moves with its sidecar, to a free id when the target already uses its own; oldest first, so
        // bumped ids keep the moved history in order. Under the lock no other change names a file in either folder: the
        // target id stays free, and each source name is still this revision when it moves.
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
    /// plaintext. A busy history lock fails it before anything changes.
    pub fn encrypt_all(&self, title: &str, encrypt: impl Fn(&[u8]) -> anyhow::Result<Vec<u8>>) -> anyhow::Result<()> {
        let dir = self.dir(title);
        let _held = self.lock()?;
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
        let _held = self.lock()?;
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
        let _held = match self.lock() {
            Ok(h) => h,
            Err(e) => return crate::log::warn(&format!("velo: held-back history not moved to the renamed note: {e}")),
        };
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
        let _held = self.lock()?;
        let (dir, Some(held)) = (self.dir(title), self.held_dir(title)) else { return Ok(()) };
        for e in std::fs::read_dir(&held)?.flatten() {
            let (p, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
            let Some(ts) = ts_of(&name).filter(|_| name.ends_with(".md") && e.file_type().is_ok_and(|t| t.is_file())) else { continue };
            let (ms, id) = free_id(&dir, ts, true);
            // exclusive creates, as in `claim`: a name taken anyway (an unlocked release beside this one) fails the
            // release, which leaves the rest held, instead of replacing a revision
            put(&dir.join(id), &encrypt(&crate::store::read_regular(&p)?)?)?;
            let side = held.join(format!("{ts}.json"));
            if side.symlink_metadata().is_ok() {
                put(&dir.join(format!("{ms}.json")), &serde_json::to_vec(&Sidecar { summary: String::new(), agent: true })?)?;
            }
            std::fs::remove_file(&p)?;
            std::fs::remove_file(&side).ok(); // after the plaintext: one that can't go (a folder) never repeats the release
        }
        std::fs::remove_dir(&held).ok(); // only when empty
        Ok(())
    }

    pub fn prune(&self, now_ms: i64) {
        let Ok(_held) = self.lock() else { return };
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

    /// A `Revisions` whose folder is removed when the returned `TempDir` drops (`rev()` keeps its folder).
    fn tmp_rev() -> (tempfile::TempDir, Revisions) {
        let d = tempfile::tempdir().unwrap();
        let r = Revisions::new(d.path().to_path_buf());
        (d, r)
    }

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
    /// #180 Copilot: a sidecar is never read by id (a crash mid-`hold` can leave one with an agent summary).
    #[test] fn a_sidecar_is_never_read_by_id() {
        let r = rev();
        r.snapshot_agent("n", b"a", false, 10, "secret why").unwrap();
        assert!(r.read("n", "10.json").is_err() && r.read("n", "10.md").is_ok());
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
    /// #158: a link (dangling or not) at a snapshot or sidecar name is never written through, replaced or removed: its
    /// id is skipped. Both the agent path and the plain save path.
    #[cfg(unix)]
    #[test] fn a_snapshot_never_writes_through_or_replaces_a_link_at_its_name() {
        let (_d, r) = tmp_rev();
        std::fs::create_dir_all(r.dir("n")).unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let outside = outside_dir.path().to_path_buf();
        for n in ["5.md", "5.json", "7.md"] {
            std::os::unix::fs::symlink(outside.join(n), r.dir("n").join(n)).unwrap();
        }
        assert_eq!(r.snapshot_agent("n", b"a", false, 5, "why").unwrap(), "6.md");
        assert!(r.snapshot_bytes("n", b"b", false, 7, false).unwrap());
        assert!(!outside.join("5.md").exists() && !outside.join("5.json").exists() && !outside.join("7.md").exists(), "nothing written through");
        for n in ["5.md", "5.json", "7.md"] {
            assert!(r.dir("n").join(n).symlink_metadata().unwrap().file_type().is_symlink(), "{n} kept");
        }
        assert_eq!((r.read("n", "6.md").unwrap().0, r.list("n")[1].summary.as_deref()), (b"a".to_vec(), Some("why")));
        assert_eq!(r.read("n", "8.md").unwrap().0, b"b");
    }
    /// #158 m3: writers (threads here, processes in life; each opens the history lock anew, as another process would)
    /// snapshotting one note in the same ms each get their own id: no revision lost, no sidecar on another writer's
    /// snapshot, no error.
    #[test] fn concurrent_writers_lose_nothing_and_pair_sidecars() {
        const WRITERS: usize = 4;
        const EACH: usize = 40;
        let (_d, r) = tmp_rev();
            let r = std::sync::Arc::new(r);
        let hs: Vec<_> = (0..WRITERS)
            .map(|w| {
                let r = r.clone();
                std::thread::spawn(move || {
                    for i in 0..EACH {
                        let tag = format!("w{w}-{i}");
                        if (w + i).is_multiple_of(2) {
                            r.snapshot_agent("n", tag.as_bytes(), w % 2 == 1, 1000, &tag).unwrap();
                        } else {
                            assert!(r.snapshot_bytes("n", tag.as_bytes(), w % 2 == 1, 1000, false).unwrap());
                        }
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let l = r.list("n");
        let mut seen: Vec<String> = l.iter().map(|x| String::from_utf8(r.read("n", &x.id).unwrap().0).unwrap()).collect();
        for x in &l {
            let body = String::from_utf8(r.read("n", &x.id).unwrap().0).unwrap();
            let i: usize = body.rsplit('-').next().unwrap().parse().unwrap();
            let w: usize = body[1..body.find('-').unwrap()].parse().unwrap();
            assert_eq!(x.agent, (w + i).is_multiple_of(2), "{body}");
            assert_eq!(x.summary.as_deref(), x.agent.then_some(body.as_str()), "sidecar of {}", x.id);
        }
        seen.sort();
        let mut want: Vec<String> = (0..WRITERS).flat_map(|w| (0..EACH).map(move |i| format!("w{w}-{i}"))).collect();
        want.sort();
        assert_eq!(seen, want);
    }
    /// #158 m3: `rename` into a folder another writer snapshots at the same ids: nothing lost, no empty revision,
    /// no summary on another revision.
    #[test] fn rename_racing_a_snapshot_loses_nothing_and_pairs_sidecars() {
        const N: usize = 30;
        for _ in 0..40 {
            let (_d, r) = tmp_rev();
            let r = std::sync::Arc::new(r);
            for i in 0..N {
                r.snapshot_agent("old", format!("old-{i}").as_bytes(), i % 2 == 0, 1000 + i as i64, &format!("old-{i}")).unwrap();
            }
            std::fs::create_dir_all(r.dir("new")).unwrap();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let w = {
                let (r, b) = (r.clone(), barrier.clone());
                std::thread::spawn(move || {
                    b.wait();
                    for i in 0..N {
                        r.snapshot_agent("new", format!("new-{i}").as_bytes(), false, 1000 + i as i64, &format!("new-{i}")).unwrap();
                    }
                })
            };
            barrier.wait();
            r.rename("old", "new");
            w.join().unwrap();
            let l = r.list("new");
            let bodies: Vec<String> = l.iter().map(|x| String::from_utf8(r.read("new", &x.id).unwrap().0).unwrap()).collect();
            for p in ["old", "new"] {
                for i in 0..N {
                    assert!(bodies.contains(&format!("{p}-{i}")), "{p}-{i} lost");
                }
            }
            for (x, b) in l.iter().zip(&bodies) {
                assert!(!b.is_empty() && x.summary.as_deref() == Some(b.as_str()), "{}: {b:?} {:?}", x.id, x.summary);
            }
            assert!(!r.dir("old").exists());
        }
    }
    /// A moved revision is whole at once: no empty file, sidecar paired, source gone.
    #[test] fn rename_moves_whole_files_only() {
        let (_d, r) = tmp_rev();
        r.snapshot_agent("old", b"body", true, 10, "why").unwrap();
        r.rename("old", "new");
        let d = r.dir("new");
        assert_eq!(std::fs::read(d.join("10.md.age")).unwrap(), b"body");
        assert!(std::fs::read_to_string(d.join("10.json")).unwrap().contains("why"));
        assert!(!r.dir("old").exists());
    }
    /// #158 (Copilot 4614648902): a writer paused between its snapshot and its sidecar holds the history lock, so a
    /// `rename` and a second writer wait for it, and nothing removes the second writer's revision by name. At 047ea1b
    /// both variants lost the second writer's revision after it got `Ok`: A, rename linked the first writer's file,
    /// the first writer yielded, the second reclaimed id 50 and rename then removed `old/50.md`; B, rename moved the
    /// first writer's file, the second reclaimed id 50 and the first writer's yield removed it. A folder at
    /// `old/50.md.age` (the other spelling; `list` and `rename` ignore folders) is what made the first writer yield.
    #[test] fn a_paused_writer_keeps_rename_and_other_writers_off_its_ids() {
        use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}, mpsc};
        let wait = std::time::Duration::from_millis(300);
        for variant in ['A', 'B'] {
            let (_d, mut r) = tmp_rev();
            let twin = r.dir("old").join("50.md.age");
            let (paused_tx, paused) = mpsc::channel::<std::path::PathBuf>();
            let (go, go_rx) = mpsc::channel::<()>();
            let go_rx = Mutex::new(go_rx);
            // the first claim of id 50 in `old` pauses (the first writer), and in A the first in `new` (rename's, at 047ea1b)
            let seen = [AtomicBool::new(false), AtomicBool::new(variant == 'B')];
            r.pause = Some(Box::new(move |p| {
                let first = p.ends_with("50.md") && !seen[usize::from(p.parent().unwrap().ends_with(key_for("new")))].swap(true, Ordering::SeqCst);
                if first {
                    paused_tx.send(p.to_path_buf()).unwrap();
                    go_rx.lock().unwrap().recv().unwrap();
                }
            }));
            let r = Arc::new(r);
            let snap = |who: &'static str| {
                let r = r.clone();
                std::thread::spawn(move || r.snapshot_agent("old", who.as_bytes(), false, 50, who).unwrap())
            };
            let w1 = snap("w1");
            assert_eq!(paused.recv().unwrap(), r.dir("old").join("50.md"));
            let (done_tx, done) = mpsc::channel();
            let rn = {
                let r = r.clone();
                std::thread::spawn(move || {
                    r.rename("old", "new");
                    done_tx.send(()).unwrap();
                })
            };
            let w2 = if variant == 'A' {
                paused.recv_timeout(wait).ok(); // 047ea1b: rename paused after linking `old/50.md`; now it waits
                std::fs::create_dir(&twin).unwrap();
                go.send(()).unwrap();
                w1.join().unwrap();
                std::fs::remove_dir(&twin).unwrap();
                let w2 = snap("w2");
                std::thread::sleep(wait);
                go.send(()).ok(); // resumes rename at 047ea1b; now nothing waits for it
                w2
            } else {
                done.recv_timeout(wait).ok(); // 047ea1b: rename done; now it waits
                let w2 = snap("w2");
                std::thread::sleep(wait); // 047ea1b: the second writer claimed `old/50.md`; now it waits
                std::fs::create_dir(&twin).unwrap();
                go.send(()).unwrap();
                w1.join().unwrap();
                std::fs::remove_dir(&twin).ok();
                w2
            };
            w2.join().unwrap();
            rn.join().unwrap();
            let mut got: Vec<(String, Option<String>)> = ["old", "new"]
                .iter()
                .flat_map(|t| r.list(t).into_iter().map(|x| (String::from_utf8(r.read(t, &x.id).unwrap().0).unwrap(), x.summary)))
                .collect();
            got.sort();
            let want = |s: &str| (s.to_string(), Some(s.to_string()));
            assert_eq!(got, [want("w1"), want("w2")], "variant {variant}");
        }
    }
    /// A change waits while another (here the test, in life another process) holds the history lock, then runs.
    #[test] fn a_change_waits_for_the_history_lock() {
        let (_d, r) = tmp_rev();
        let r = std::sync::Arc::new(r);
        let held = r.lock().unwrap().expect("this filesystem supports locks");
        let w = {
            let r = r.clone();
            std::thread::spawn(move || r.snapshot_agent("n", b"a", false, 5, "why").unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!r.dir("n").exists(), "nothing written while the lock is held");
        drop(held);
        assert_eq!(w.join().unwrap(), "5.md");
    }
    /// A FIFO or a link at the lock's name never blocks a change and is never followed: the change runs unlocked.
    #[cfg(unix)]
    #[test] fn a_fifo_or_link_at_the_lock_name_never_blocks_a_change() {
        let outside = tempfile::tempdir().unwrap();
        for fifo in [true, false] {
            let (d, r) = tmp_rev();
            if fifo {
                crate::store::fifo::make(&d.path().join(".lock"));
            } else {
                std::os::unix::fs::symlink(outside.path().join("victim"), d.path().join(".lock")).unwrap();
            }
            let id = crate::store::fifo::within("lock", move || r.snapshot_agent("n", b"a", false, 5, "why").unwrap());
            assert_eq!(id, "5.md");
        }
        assert!(!outside.path().join("victim").exists(), "the link is not followed");
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
    /// Holds the history lock of `r` as another process would (a second handle excludes the first in one process too).
    fn hold_lock(r: &Revisions) -> std::fs::File {
        let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(r.root.join(".lock")).unwrap();
        f.lock().unwrap();
        f
    }
    /// #173 review m1/m3: a stuck holder makes a change fail with `TimedOut` and write nothing; while that waiter still
    /// waits, later changes fail at once (no thread or handle per change); once the holder lets go, the waiter releases
    /// the lock and changes run again. Throttled saves never wait.
    #[test] fn a_timed_out_waiter_never_keeps_the_lock_and_changes_recover() {
        assert_eq!(LOCK_WAIT, std::time::Duration::from_secs(5));
        let (_d, mut r) = tmp_rev();
        r.wait = std::time::Duration::from_millis(200);
        assert!(r.snapshot_bytes("n", b"a", false, 1_000, true).unwrap());
        let holder = hold_lock(&r);
        let t = std::time::Instant::now();
        assert_eq!(r.snapshot_agent("n", b"b", false, 5_000, "why").unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(t.elapsed() >= r.wait, "it waited");
        let t = std::time::Instant::now();
        assert_eq!(r.snapshot_agent("n", b"c", false, 6_000, "why").unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(t.elapsed() < r.wait, "a second change fails at once while the first waiter still waits");
        assert!(!r.snapshot_bytes("n", b"d", false, 7_000, true).unwrap(), "a throttled save never takes the lock");
        assert_eq!(r.list("n").len(), 1, "nothing written");
        holder.unlock().unwrap();
        drop(holder);
        let t = std::time::Instant::now();
        let id = loop {
            match r.snapshot_agent("n", b"e", false, 8_000, "why") {
                Ok(id) => break id,
                Err(e) if e.kind() == io::ErrorKind::TimedOut && t.elapsed() < std::time::Duration::from_secs(10) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(e) => panic!("never recovered: {e}"),
            }
        };
        assert_eq!(id, "8000.md");
        assert!(std::fs::File::open(r.root.join(".lock")).unwrap().try_lock().is_ok(), "the lock is free again");
        // and the stuck-holder mark is gone: a change waits for a briefly busy lock again instead of failing at once
        let busy = hold_lock(&r);
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            busy.unlock().unwrap();
        });
        assert_eq!(r.snapshot_agent("n", b"f", false, 9_000, "why").unwrap(), "9000.md");
        release.join().unwrap();
    }
    /// #173 review m4 (#170, #180): `encrypt_all` and `hold` wait for an agent claim paused between its snapshot and
    /// its sidecar, so the sidecar it writes then is scrubbed (lock) or held with its snapshot (keyless lock): no
    /// plaintext summary is left in the note's listable history.
    #[test] fn encrypt_all_and_hold_wait_for_a_paused_agent_claim() {
        for holding in [false, true] {
            let (_d, mut r) = tmp_rev();
            let (paused_tx, paused) = std::sync::mpsc::channel::<()>();
            let (go, go_rx) = std::sync::mpsc::channel::<()>();
            let go_rx = std::sync::Mutex::new(go_rx);
            r.pause = Some(Box::new(move |_| {
                paused_tx.send(()).unwrap();
                go_rx.lock().unwrap().recv().unwrap();
            }));
            let r = std::sync::Arc::new(r);
            let w = {
                let r = r.clone();
                std::thread::spawn(move || r.snapshot_agent("n", b"body", false, 5, "SECRET summary").unwrap())
            };
            paused.recv().unwrap();
            let e = {
                let r = r.clone();
                std::thread::spawn(move || if holding { r.hold("n").unwrap() } else { r.encrypt_all("n", |b| Ok([b"ENC:".as_slice(), b].concat())).unwrap() })
            };
            std::thread::sleep(std::time::Duration::from_millis(300));
            go.send(()).unwrap();
            w.join().unwrap();
            e.join().unwrap();
            assert!(!std::fs::read_to_string(r.dir("n").join("5.json")).unwrap_or_default().contains("SECRET"), "holding={holding}");
            assert!(!r.has_plain("n"));
            if holding {
                assert!(r.list("n").is_empty() && std::fs::read_to_string(r.dir("n").join(HELD).join("5.json")).unwrap().contains("SECRET"), "held together");
            } else {
                assert_eq!(r.read("n", "5.md.age").unwrap().0, b"ENC:body");
            }
        }
    }
    /// #180 Known limit / Copilot r4617774773: two releases of one held set (a keyed open beside the previous vault's
    /// watcher: two `Revisions` on one root) leave every revision exactly once, encrypted, and no plaintext.
    #[test] fn two_releases_of_one_held_set_lose_and_repeat_nothing() {
        for _ in 0..20 {
            let (d, r) = tmp_rev();
            for i in 0..30 {
                r.snapshot_bytes("n", format!("v{i}").as_bytes(), false, 10 + i, false).unwrap();
            }
            r.hold("n").unwrap();
            let r2 = Revisions::new(d.path().to_path_buf());
            let barrier = std::sync::Barrier::new(2);
            let enc = |b: &[u8]| Ok([b"ENC:".as_slice(), b].concat());
            std::thread::scope(|s| {
                for r in [&r, &r2] {
                    let barrier = &barrier;
                    s.spawn(move || {
                        barrier.wait();
                        r.release_held("n", enc).unwrap();
                    });
                }
            });
            let mut got: Vec<Vec<u8>> = r.list("n").iter().map(|x| r.read("n", &x.id).unwrap().0).collect();
            got.sort();
            let mut want: Vec<Vec<u8>> = (0..30).map(|i| format!("ENC:v{i}").into_bytes()).collect();
            want.sort();
            assert_eq!(got, want);
            assert!(!r.has_plain("n") && !r.has_held("n"));
        }
    }
}
