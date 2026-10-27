//! `NoteOps` for the running app: the app's vault (which holds unlocked notes in memory) behind the same locked-note
//! filtering as direct mode, never with the app's identity. A write to a note the editor may have open is first offered
//! to the webview (`agent-write`), which applies it as a user edit or answers `not-open`.
use super::ops::{NoteOps, VaultOps, locked, plain};
use crate::names::parse_note_file;
use crate::commands::AppState;
use crate::index::{Page, TagCount};
use crate::settings::Settings;
use crate::tasks::TaskView;
use crate::vault::{NoteDoc, Toggled, Vault, fm_lines, toggled_text};
use anyhow::anyhow;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

/// How long a write waits for the webview before failing with "velo is busy, retry".
pub const EDITOR_TIMEOUT: Duration = Duration::from_secs(5);
/// Once the webview has claimed a request (it is applying it), the wait for its answer goes on this long instead.
pub const CLAIMED_TIMEOUT: Duration = Duration::from_secs(60);
const BUSY: &str = "velo is busy, retry";

/// Requests awaiting the webview's `agent_write_done`; the flag is set once it claimed one (`agent_write_claim`).
#[derive(Default)]
pub struct Editors {
    next: AtomicU64,
    pub(crate) pending: Mutex<HashMap<u64, (mpsc::Sender<Value>, bool)>>,
}

impl Editors {
    /// Hands `req` (with an `id` added) to `emit`, then waits up to `timeout` for `done(id, ..)`, or up to
    /// `CLAIMED_TIMEOUT` if the webview claimed it in time.
    pub fn ask(&self, req: Value, emit: impl FnOnce(Value), timeout: Duration) -> anyhow::Result<Value> {
        self.ask_within(req, emit, timeout, CLAIMED_TIMEOUT)
    }

    fn ask_within(&self, mut req: Value, emit: impl FnOnce(Value), timeout: Duration, claimed_timeout: Duration) -> anyhow::Result<Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, (tx, false));
        req["id"] = id.into();
        emit(req);
        let r = rx.recv_timeout(timeout).or_else(|e| {
            // decided under the lock, so a claim either lands before this (and is waited for) or is refused after it
            let claimed = {
                let mut p = self.pending.lock().unwrap();
                let c = p.get(&id).is_some_and(|e| e.1);
                if !c {
                    p.remove(&id);
                }
                c
            };
            if claimed { rx.recv_timeout(claimed_timeout) } else { rx.try_recv().map_err(|_| e) }
        });
        self.pending.lock().unwrap().remove(&id);
        r.map_err(|_| anyhow!(BUSY))
    }

    /// The webview is about to apply request `id`: true while the backend still waits for it, false once it gave up
    /// (the webview must then leave everything as it is).
    pub fn claim(&self, id: u64) -> bool {
        self.pending.lock().unwrap().get_mut(&id).map(|e| e.1 = true).is_some()
    }

    pub fn done(&self, id: u64, result: Value) {
        if let Some((tx, _)) = self.pending.lock().unwrap().remove(&id) {
            tx.send(result).ok();
        }
    }
}

pub struct AppOps<'a> {
    st: &'a AppState,
    /// The `agent-write` round trip: `{path, kind, insert, base?, summary}` in, the webview's reply out.
    route: &'a dyn Fn(Value) -> anyhow::Result<Value>,
    /// Real OS Trash; tests swap it for a plain remove.
    pub(crate) remove: fn(&Path) -> std::io::Result<()>,
}

impl<'a> AppOps<'a> {
    pub fn new(st: &'a AppState, route: &'a dyn Fn(Value) -> anyhow::Result<Value>) -> Self {
        AppOps { st, route, remove: crate::vault::move_to_trash }
    }

    /// Runs `f` on the app's vault, locked for this one operation only (the editor round trip needs it free).
    fn with<T>(&self, f: impl FnOnce(&mut VaultOps<&mut Vault>) -> anyhow::Result<T>) -> anyhow::Result<T> {
        if self.st.indexing.lock().unwrap().is_some() {
            return Err(anyhow!(BUSY));
        }
        let mut g = self.st.vault.lock().unwrap();
        let v = g.as_mut().ok_or_else(|| anyhow!("No notes folder set in velo"))?;
        let mut o = VaultOps::new(v, self.st.settings_path.clone());
        o.remove = self.remove;
        f(&mut o)
    }

    /// The webview's reply to `req`, which must be one of `ok` (`conflict` and `refused` become errors).
    fn ask_editor(&self, req: Value, ok: &[&str]) -> anyhow::Result<Value> {
        let r = (self.route)(req)?;
        match r.as_str() {
            Some("conflict") => Err(anyhow!("note changed since you read it")),
            Some("refused") => Err(anyhow!("the note is open in velo and can't be edited right now, retry")),
            Some(s) if ok.contains(&s) => Ok(r),
            _ if ok.contains(&"hash") && r.get("hash").is_some_and(Value::is_string) => Ok(r),
            _ => Err(anyhow!("bad reply from velo's editor: {r}")),
        }
    }

    /// Offers a write to the editor: `Some(hash)` when it applied and saved it, `None` when the note isn't open there.
    fn via_editor(&self, req: Value) -> anyhow::Result<Option<String>> {
        let r = self.ask_editor(req, &["not-open", "hash"])?;
        Ok(r.get("hash").and_then(Value::as_str).map(String::from))
    }
}

impl NoteOps for AppOps<'_> {
    fn find(&self, title: &str) -> anyhow::Result<Option<String>> {
        self.with(|o| o.find(title))
    }

    fn read(&mut self, path: &str) -> anyhow::Result<NoteDoc> {
        self.with(|o| o.read(path))
    }

    fn write(&mut self, path: &str, new_text: &str, base_hash: &str, summary: &str) -> anyhow::Result<String> {
        let path = plain(path)?;
        // the editor checks `base` against the saved note and applies only the changed span
        match self.via_editor(json!({"path": path, "kind": "replace", "insert": new_text, "base": base_hash, "summary": summary}))? {
            Some(hash) => Ok(hash),
            None => self.with(|o| o.write(path, new_text, base_hash, summary)),
        }
    }

    fn create(&mut self, title: &str, text: &str, summary: &str) -> anyhow::Result<NoteDoc> {
        self.with(|o| o.create(title, text, summary))
    }

    fn search(&self, query: &str, tags: &[String], offset: usize) -> anyhow::Result<Page> {
        self.with(|o| o.search(query, tags, offset))
    }

    fn tags(&self) -> anyhow::Result<Vec<TagCount>> {
        self.with(|o| o.tags())
    }

    fn tasks(&self, query: &str, tags: &[String], show_done: bool) -> anyhow::Result<TaskView> {
        self.with(|o| o.tasks(query, tags, show_done))
    }

    /// The open note is saved and frozen in the editor first, so autosave can't recreate it under its old name; the
    /// editor then follows it to the new path (`renamed`). Notes whose links get rewritten are saved first too.
    fn rename(&mut self, path: &str, new_title: &str, rewrite_links: bool, summary: &str) -> anyhow::Result<String> {
        let path = plain(path)?;
        if rewrite_links {
            let title = parse_note_file(Path::new(path)).map(|n| n.title).unwrap_or_default();
            let sources: Vec<String> = self.with(|o| o.vault.index.backlinks(&title))?.into_iter().filter(|p| !locked(p)).collect();
            if !sources.is_empty() && (self.route)(json!({"kind": "flush", "paths": sources}))? == "refused" {
                return Err(anyhow!("note is open in velo with unsaved changes"));
            }
        }
        let ready = self.ask_editor(json!({"path": path, "kind": "rename", "summary": summary}), &["ready", "not-open"])? == "ready";
        let r = self.with(|o| o.rename(path, new_title, rewrite_links, summary));
        if ready {
            // unfreezes the editor, on the new path or (failed) the old one
            (self.route)(json!({"path": path, "kind": "renamed", "to": r.as_ref().ok()})).ok();
        }
        r
    }

    /// The open note is saved and closed in the editor first, so autosave can't bring it back.
    fn trash(&mut self, path: &str, summary: &str) -> anyhow::Result<()> {
        let path = plain(path)?;
        self.ask_editor(json!({"path": path, "kind": "trash", "summary": summary}), &["closed", "not-open"])?;
        self.with(|o| o.trash(path, summary))
    }

    fn toggle_task(&mut self, path: &str, line: usize, expected: &str, summary: &str) -> anyhow::Result<Toggled> {
        let doc = self.read(path)?;
        let (text, line_text) = toggled_text(&doc.text, line, expected)?;
        self.write(path, &text, &doc.hash, summary)?;
        // stamping may replace or prepend the front-matter block: shift the line by its change in height
        let saved = self.read(path)?.text;
        Ok(Toggled { line: line - fm_lines(&text) + fm_lines(&saved), line_text })
    }

    fn capture_task(&mut self, title: &str, text: &str, summary: &str) -> anyhow::Result<String> {
        let line = format!("- [ ] {}", text.trim().replace(['\r', '\n'], " "));
        if let Some(path) = self.find(title)?
            && !text.trim().is_empty()
            && self.via_editor(json!({"path": path, "kind": "append", "insert": line, "summary": summary}))?.is_some()
        {
            return Ok(path);
        }
        // a locked match, a missing note (created here) or one not open in the editor
        self.with(|o| o.capture_task(title, text, summary))
    }

    fn open_or_create(&mut self, title: &str) -> anyhow::Result<NoteDoc> {
        self.with(|o| o.open_or_create(title))
    }

    fn snapshot(&mut self, path: &str, summary: &str) -> anyhow::Result<()> {
        self.with(|o| o.snapshot(path, summary))
    }

    fn settings(&self) -> Settings {
        self.st.settings.lock().unwrap().clone()
    }

    fn note_tags(&self, path: &str) -> anyhow::Result<Vec<String>> {
        self.with(|o| o.note_tags(path))
    }

    fn backlinks(&self, title: &str) -> anyhow::Result<Vec<String>> {
        self.with(|o| o.backlinks(title))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;
    use crate::index::Sort;
    use crate::settings::Settings;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::mpsc;
    use std::time::Duration;

    /// App state over a vault holding `P.md` (plain, with a task) and `L.md.age` unlocked in memory.
    fn state() -> (AppState, PathBuf) {
        let t = tempfile::tempdir().unwrap().keep();
        let dir = t.join("notes");
        std::fs::create_dir_all(&dir).unwrap();
        let id = crate::crypto::new_identity();
        std::fs::write(dir.join("P.md"), "plain zebra #shared\n- [ ] open task\n[[L]]\n").unwrap();
        std::fs::write(dir.join("L.md.age"), crate::crypto::encrypt(&id, b"secret zebra #hidden\n- [ ] locked task\n[[P]]\n").unwrap()).unwrap();
        let v = Vault::open_with_progress(dir.clone(), &t.join("i.sqlite"), Some(&id), &mut |_, _| {}).unwrap();
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 2, "unlocked in memory");
        let st = AppState {
            settings: Mutex::new(Settings::default()),
            vault: Mutex::new(Some(v)),
            watcher: Mutex::new(None),
            identity: Mutex::new(Some(id)),
            indexing: Mutex::new(None),
            open_gen: Default::default(),
            locked: Default::default(),
            capture_was_hidden: Default::default(),
            settings_path: t.join("settings.json"),
            data_dir: t.clone(),
        };
        (st, dir)
    }

    fn never(_: Value) -> anyhow::Result<Value> {
        panic!("no editor round trip expected")
    }

    #[test] fn app_ops_filters_unlocked_locked_notes() {
        let (st, dir) = state();
        let ops = AppOps::new(&st, &never);
        let mut ops = ops;
        let locked = dir.join("L.md.age").to_string_lossy().into_owned();
        assert_eq!(ops.search("zebra", &[], 0).unwrap().hits.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), ["P"]);
        let tasks = ops.tasks("", &[], true).unwrap();
        assert!([&tasks.overdue, &tasks.today, &tasks.upcoming, &tasks.no_date, &tasks.done].iter().all(|g| g.iter().all(|t| !t.path.ends_with(".age"))));
        assert_eq!(tasks.no_date.len(), 1);
        assert!(ops.tags().unwrap().iter().all(|t| t.tag != "hidden"));
        assert_eq!(ops.find("L").unwrap(), None);
        assert_eq!(ops.read(&locked).err().unwrap().to_string(), "not found");
        assert!(ops.note_tags(&locked).is_err());
        assert!(ops.backlinks("P").unwrap().is_empty());
        assert!(ops.write(&locked, "x", "h", "s").is_err());
        assert!(ops.toggle_task(&locked, 1, "- [ ] locked task", "s").is_err());
        assert!(ops.capture_task("L", "x", "s").is_err());
        let r = crate::agent::tools::call(&mut ops, "read_note", json!({"title": "L"}));
        assert_eq!(r, Err("not found".to_string()));
    }

    #[test] fn write_times_out_after_5s() {
        assert_eq!(EDITOR_TIMEOUT, Duration::from_secs(5));
        let (st, dir) = state();
        let editors = Editors::default();
        let route = |req: Value| editors.ask(req, |_| {}, Duration::from_millis(50));
        let mut ops = AppOps::new(&st, &route);
        let p = dir.join("P.md").to_string_lossy().into_owned();
        let before = std::fs::read_to_string(&p).unwrap();
        let d = ops.read(&p).unwrap();
        assert_eq!(ops.write(&p, "new", &d.hash, "s").unwrap_err().to_string(), "velo is busy, retry");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), before, "never a direct write");
        assert!(editors.pending.lock().unwrap().is_empty());
    }

    #[test] fn editor_replies_route_the_write() {
        let (st, dir) = state();
        let p = dir.join("P.md").to_string_lossy().into_owned();
        let seen = Mutex::new(Vec::new());
        let reply = Mutex::new(json!("not-open"));
        let route = |req: Value| { seen.lock().unwrap().push(req); Ok(reply.lock().unwrap().clone()) };
        let mut ops = AppOps::new(&st, &route);
        let d = ops.read(&p).unwrap();
        // not open: the backend writes it, with the agent snapshot
        let h = ops.write(&p, "v2\n", &d.hash, "s1").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap().ends_with("v2\n"), true);
        assert_eq!(seen.lock().unwrap()[0], json!({"path": p, "kind": "replace", "insert": "v2\n", "base": d.hash, "summary": "s1"}));
        // open: the editor's hash comes back and the backend leaves the file alone
        *reply.lock().unwrap() = json!({"hash": "edhash"});
        assert_eq!(ops.write(&p, "v3\n", &h, "s2").unwrap(), "edhash");
        assert!(std::fs::read_to_string(&p).unwrap().ends_with("v2\n"));
        *reply.lock().unwrap() = json!("conflict");
        assert_eq!(ops.write(&p, "v3\n", &h, "s").unwrap_err().to_string(), "note changed since you read it");
        *reply.lock().unwrap() = json!("refused");
        assert!(ops.write(&p, "v3\n", &h, "s").unwrap_err().to_string().contains("can't be edited"));
        // append and toggle go through the same round trip
        std::fs::write(&p, "- [ ] a\n").unwrap();
        st.vault.lock().unwrap().as_mut().unwrap().rescan(None);
        *reply.lock().unwrap() = json!({"hash": "x"});
        assert_eq!(ops.capture_task("P", " buy milk\n", "s3").unwrap(), p);
        assert_eq!(seen.lock().unwrap().last().unwrap(), &json!({"path": p, "kind": "append", "insert": "- [ ] buy milk", "summary": "s3"}));
        let t = ops.toggle_task(&p, 0, "- [ ] a", "s4").unwrap();
        assert_eq!((t.line, t.line_text.starts_with("- [x] a")), (0, true));
        let last = seen.lock().unwrap().last().unwrap().clone();
        assert_eq!((last["kind"].as_str(), last["insert"].as_str().unwrap().starts_with("- [x] a")), (Some("replace"), true));
    }

    /// Runs `ask_within` (50 ms, then 2 s once claimed) while `webview` gets the request's id on another thread.
    fn round_trip(webview: impl FnOnce(&Editors, u64) + Send) -> anyhow::Result<Value> {
        let editors = Editors::default();
        let (tx, rx) = mpsc::channel();
        std::thread::scope(|s| {
            let e = &editors;
            s.spawn(move || webview(e, rx.recv().unwrap()));
            editors.ask_within(json!({}), |r| tx.send(r["id"].as_u64().unwrap()).unwrap(), Duration::from_millis(50), Duration::from_secs(2))
        })
    }

    #[test] fn claim_after_timeout_is_refused() {
        let claimed = Mutex::new(None);
        let r = round_trip(|e, id| {
            std::thread::sleep(Duration::from_millis(150));
            *claimed.lock().unwrap() = Some(e.claim(id));
            e.done(id, json!({"hash": "late"}));
        });
        assert_eq!(r.unwrap_err().to_string(), "velo is busy, retry");
        assert_eq!(*claimed.lock().unwrap(), Some(false), "the webview must not apply it");
    }

    #[test] fn claimed_write_waits_past_timeout() {
        assert_eq!(CLAIMED_TIMEOUT, Duration::from_secs(60));
        let r = round_trip(|e, id| {
            assert!(e.claim(id));
            std::thread::sleep(Duration::from_millis(200)); // well past the 50 ms timeout
            e.done(id, json!({"hash": "h2"}));
        });
        assert_eq!(r.unwrap(), json!({"hash": "h2"}));
    }

    #[test] fn trash_of_open_note_waits_for_the_editor_to_close_it() {
        let (st, dir) = state();
        let p = dir.join("P.md").to_string_lossy().into_owned();
        let reply = Mutex::new(json!("refused"));
        let seen = Mutex::new(Vec::new());
        let route = |req: Value| { seen.lock().unwrap().push(req); Ok(reply.lock().unwrap().clone()) };
        let mut ops = AppOps::new(&st, &route);
        ops.remove = |p| std::fs::remove_file(p);
        assert!(ops.trash(&p, "s").is_err());
        assert!(std::path::Path::new(&p).exists(), "refused: not trashed");
        *reply.lock().unwrap() = json!("closed");
        ops.trash(&p, "s").unwrap();
        assert!(!std::path::Path::new(&p).exists());
        assert_eq!(seen.lock().unwrap()[1], json!({"path": p, "kind": "trash", "summary": "s"}));
    }

    #[test] fn rename_of_open_note_freezes_then_moves_the_editor() {
        let (st, dir) = state();
        let p = dir.join("P.md").to_string_lossy().into_owned();
        let seen = Mutex::new(Vec::new());
        let route = |req: Value| { seen.lock().unwrap().push(req.clone()); Ok(json!(if req["kind"] == "rename" { "ready" } else { "ok" })) };
        let mut ops = AppOps::new(&st, &route);
        let np = ops.rename(&p, "Q", false, "s").unwrap();
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen, vec![json!({"path": p, "kind": "rename", "summary": "s"}), json!({"path": p, "kind": "renamed", "to": np})]);
        // a failed rename unfreezes it on the old path
        let seen2 = Mutex::new(Vec::new());
        let route = |req: Value| { seen2.lock().unwrap().push(req.clone()); Ok(json!(if req["kind"] == "rename" { "ready" } else { "ok" })) };
        let mut ops = AppOps::new(&st, &route);
        std::fs::write(dir.join("R.md"), "r").unwrap();
        st.vault.lock().unwrap().as_mut().unwrap().rescan(None);
        assert!(ops.rename(&np, "R", false, "s").is_err());
        assert_eq!(seen2.lock().unwrap().last().unwrap(), &json!({"path": np, "kind": "renamed", "to": null}));
    }

    #[test] fn rename_with_rewrite_saves_open_link_sources_first() {
        let (st, dir) = state();
        let (p, a) = (dir.join("P.md").to_string_lossy().into_owned(), dir.join("A.md").to_string_lossy().into_owned());
        std::fs::write(&a, "see [[P]]\n").unwrap();
        st.vault.lock().unwrap().as_mut().unwrap().rescan(None);
        let seen = Mutex::new(Vec::new());
        let route = |req: Value| { seen.lock().unwrap().push(req.clone()); Ok(json!(if req["kind"] == "flush" { "refused" } else { "not-open" })) };
        let mut ops = AppOps::new(&st, &route);
        assert_eq!(ops.rename(&p, "Q", true, "s").unwrap_err().to_string(), "note is open in velo with unsaved changes");
        assert_eq!(seen.lock().unwrap()[0], json!({"kind": "flush", "paths": [a]}), "the locked source is not listed");
        assert!(std::path::Path::new(&p).exists(), "not renamed");
        let route = |req: Value| Ok(json!(if req["kind"] == "flush" { "flushed" } else { "not-open" }));
        let mut ops = AppOps::new(&st, &route);
        ops.rename(&p, "Q", true, "s").unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "see [[Q]]\n");
    }
}
