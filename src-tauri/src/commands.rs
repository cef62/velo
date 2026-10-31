use crate::agent::listener::{self, AgentState, set_access};
use crate::crypto;
use crate::export::{self, ExportCounts, ExportRequest};
use crate::index::{Page, Sort, TagCount};
use crate::revisions::RevisionInfo;
use crate::settings::{self, GlobalAction, Settings};
use crate::store::{self, SaveResult};
use crate::tasks::TaskView;
use crate::vault::{MergeResult, NoteDoc, RenameResult, TimelineBy, TimelineRow, Vault};
use crate::watch;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub vault: Mutex<Option<Vault>>,
    pub watcher: Mutex<Option<watch::Watcher>>,
    /// keychain identity, read at startup and after `setup_passphrase`
    pub identity: Mutex<Option<String>>,
    /// (done, total) while a vault is being indexed; note commands refuse with "indexing"
    pub indexing: Mutex<Option<(usize, usize)>>,
    /// bumped by every open/close; an open whose number is no longer current is stale and discards its result
    pub open_gen: AtomicU64,
    /// set by Lock all: the keychain identity is not reloaded until the passphrase is entered again
    pub locked: AtomicBool,
    /// set by `capture_requested`: velo was hidden (or unfocused) when the capture shortcut fired
    pub capture_was_hidden: AtomicBool,
    pub settings_path: PathBuf,
    pub data_dir: PathBuf,
}

type Res<T> = Result<T, String>;

/// Map anyhow errors to the stable strings the UI matches on.
fn err(e: anyhow::Error) -> String {
    if e.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists) {
        return "already-exists".into();
    }
    if e.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) {
        return "not-found".into(); // a note deleted behind the UI's back (history navigation)
    }
    e.to_string() // "locked" passes through verbatim
}

fn identity(st: &AppState) -> Option<String> {
    st.identity.lock().unwrap().clone()
}

fn check_gate(gate: &Mutex<Option<(usize, usize)>>) -> Result<(), &'static str> {
    if gate.lock().unwrap().is_some() { Err("indexing") } else { Ok(()) }
}

/// Runs `f` with the gate set; the gate is cleared on every return path (a panic is out of scope).
fn gated<T>(gate: &Mutex<Option<(usize, usize)>>, f: impl FnOnce() -> anyhow::Result<T>) -> anyhow::Result<T> {
    *gate.lock().unwrap() = Some((0, 0));
    let r = f();
    *gate.lock().unwrap() = None;
    r
}

fn with_vault<T>(st: &AppState, f: impl FnOnce(&mut Vault, Option<&str>) -> anyhow::Result<T>) -> Res<T> {
    check_gate(&st.indexing)?;
    let id = identity(st);
    let mut guard = st.vault.lock().unwrap();
    let v = guard.as_mut().ok_or("no-folder")?;
    f(v, id.as_deref()).map_err(err)
}

/// (Re)open the vault and watcher for `dir`, emitting index-progress/index-done/index-error. No lock is held
/// while indexing. On error the previous vault/watcher stay untouched. If another open/close started
/// meanwhile, this one is stale: it emits nothing and discards its result (the newer open wins).
pub fn open_vault(app: &AppHandle, st: &AppState, dir: &Path) -> anyhow::Result<()> {
    let me = st.open_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let current = || st.open_gen.load(Ordering::SeqCst) == me;
    let r = gated(&st.indexing, || open_vault_inner(app, st, dir, me));
    if current() {
        match &r {
            Ok(()) => app.emit("index-done", serde_json::json!({})),
            Err(e) => app.emit("index-error", serde_json::json!({ "message": e.to_string() })),
        }
        .ok();
    }
    r
}

fn open_vault_inner(app: &AppHandle, st: &AppState, dir: &Path, me: u64) -> anyhow::Result<()> {
    let current = || st.open_gen.load(Ordering::SeqCst) == me;
    std::fs::create_dir_all(&st.data_dir)?;
    let db = st.data_dir.join(format!("index-{}.sqlite", store::hash(dir.to_string_lossy().as_bytes())));
    let vault = Vault::open_with_progress(dir.to_path_buf(), &db, identity(st).as_deref(), &mut |done, total| {
        if current() {
            // a stale open finishing first clears the gate; the newer open's next callback restores it
            *st.indexing.lock().unwrap() = Some((done, total));
            app.emit("index-progress", serde_json::json!({ "done": done, "total": total })).ok();
        }
    })?;
    if !current() {
        return Ok(());
    }
    let handle = app.clone();
    let base = dir.to_path_buf();
    let w = watch::spawn(dir.to_path_buf(), move |batch| {
        let st = handle.state::<AppState>();
        notify_changed(&handle, apply_watch(&st, &base, batch));
    })?;
    if !current() {
        w.stop();
        return Ok(());
    }
    let old = st.watcher.lock().unwrap().replace(w);
    *st.vault.lock().unwrap() = Some(vault);
    if let Some(old) = old {
        old.stop(); // joins; must not hold the vault lock (an in-flight callback may want it)
    }
    // changes made while indexing, before the watcher ran or before this vault was installed
    notify_changed(app, apply_watch(st, dir, None));
    Ok(())
}

/// Apply watcher changes (`None` = rescan the folder) in chunks, releasing the vault lock between them so
/// note commands aren't stuck behind a sync that touched thousands of files.
fn apply_watch(st: &AppState, base: &Path, batch: Option<Vec<PathBuf>>) -> Vec<String> {
    let id = identity(st);
    let with = |f: &mut dyn FnMut(&mut Vault) -> Vec<String>| match st.vault.lock().unwrap().as_mut() {
        Some(v) if watch::applies_to(&v.store.dir, base) => Some(f(v)),
        _ => None,
    };
    // A rescan lists the stale paths under the lock, then applies them in the same chunks; a big one as a bulk
    // re-index. Saves and locks between its chunks are erased by its `end_bulk`.
    let (paths, bulk) = match batch {
        Some(p) => (p, false),
        None => match st.vault.lock().unwrap().as_ref() {
            Some(v) if watch::applies_to(&v.store.dir, base) => match v.stale_paths() {
                Ok((p, replaced)) => {
                    let bulk = replaced >= crate::vault::BULK && v.index.begin_bulk().is_ok();
                    (p, bulk)
                }
                Err(_) => return vec![],
            },
            _ => return vec![],
        },
    };
    let mut changed = Vec::new();
    // A bulk's chunks are bigger, so fewer commits rewrite the same pages (10k notes with `begin_bulk`'s settings:
    // chunks of 700 write about a third of what 100 do), each held ~0.4 s; a watcher batch stays at 100.
    for chunk in paths.chunks(if bulk { 700 } else { 100 }) {
        let Some(c) = with(&mut |v| if bulk { v.apply_bulk_chunk(chunk, id.as_deref()) } else { v.apply_fs_changes(chunk, id.as_deref()) }) else { break };
        changed.extend(c);
    }
    if bulk {
        // a vault switch mid-rescan dropped it: `Index`'s drop ended the bulk
        with(&mut |v| {
            v.index.finish_bulk(); // a failure (disk full) is retried by the next lock, or at close or open
            v.index.checkpoint().ok(); // also after a chunk that ended the bulk itself (a note locked elsewhere)
            vec![]
        });
    }
    changed
}

fn notify_changed(app: &AppHandle, changed: Vec<String>) {
    if !changed.is_empty() {
        app.emit("notes-changed", serde_json::json!({ "paths": changed })).ok();
    }
}

pub fn toggle_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        #[cfg(target_os = "macos")]
        app.hide().ok(); // hides the whole app so macOS refocuses the previously active one
        #[cfg(not(target_os = "macos"))]
        w.hide().ok();
    } else {
        #[cfg(target_os = "macos")]
        app.show().ok();
        w.show().ok();
        w.unminimize().ok();
        w.set_focus().ok();
        w.emit("focus-search", ()).ok();
    }
}

/// Remembers whether velo was hidden (for Task 8's capture_done), then shows it like `toggle_window` and tells the UI.
pub fn capture_requested(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let hidden = !(w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    capture_shown(&app.state::<AppState>().capture_was_hidden, hidden);
    #[cfg(target_os = "macos")]
    app.show().ok();
    w.show().ok();
    w.unminimize().ok();
    w.set_focus().ok();
    app.emit("capture", ()).ok();
}

/// A repeat press finds velo in front (the first press showed it): the session still started hidden.
fn capture_shown(was_hidden: &AtomicBool, hidden: bool) {
    was_hidden.fetch_or(hidden, Ordering::SeqCst);
}

/// Ends the session (the flag never outlives it); true = hide velo again.
fn capture_ended(was_hidden: &AtomicBool, hide: bool) -> bool {
    was_hidden.swap(false, Ordering::SeqCst) && hide
}

/// `binding` is in velo format ("Mod+Shift+Space").
pub fn register_global(app: &AppHandle, action: GlobalAction, binding: &str) -> Result<(), String> {
    let Some(sc) = settings::parse_hotkey(binding)? else { return Ok(()) }; // "none": no global shortcut
    app.global_shortcut()
        .on_shortcut(sc, move |app, _, ev| {
            if ev.state == ShortcutState::Pressed {
                match action {
                    GlobalAction::ToggleWindow => toggle_window(app),
                    GlobalAction::Capture => capture_requested(app),
                }
            }
        })
        .map_err(|e| e.to_string())
}

fn unregister_hotkey(app: &AppHandle, binding: &str) {
    if let Ok(Some(sc)) = settings::parse_hotkey(binding) {
        app.global_shortcut().unregister(sc).ok();
    }
}

/// (action, old, new) for each global binding that really changed (re-registering the same keys would fail).
fn changed_globals(old: &Settings, new: &Settings) -> Vec<(GlobalAction, String, String)> {
    old.global_bindings().into_iter().zip(new.global_bindings())
        .filter(|((_, o), (_, n))| o != n && !settings::same_shortcut(o, n))
        .map(|((a, o), (_, n))| (a, o, n))
        .collect()
}

type Reg<'a> = dyn FnMut(GlobalAction, &str) -> Result<(), String> + 'a;
type Unreg<'a> = dyn FnMut(&str) + 'a;

/// Release every old key first (a swap A<->B needs that), then register the new ones.
/// An old key an unchanged action still holds (`held`) stays registered: it was never this action's.
/// On failure the new keys registered so far are released and all old keys are back.
fn swap_globals(changed: &[(GlobalAction, String, String)], held: &[String], reg: &mut Reg, unreg: &mut Unreg) -> Result<(), String> {
    changed.iter().filter(|(_, o, _)| !held.iter().any(|h| settings::same_shortcut(h, o))).for_each(|(_, o, _)| unreg(o));
    for (i, (a, _, n)) in changed.iter().enumerate() {
        if let Err(e) = reg(*a, n) {
            changed[..i].iter().for_each(|(_, _, n)| unreg(n));
            restore(changed, reg);
            return Err(e);
        }
    }
    Ok(())
}

/// Undo a finished `swap_globals` (the vault reopen failed after it).
fn revert_globals(changed: &[(GlobalAction, String, String)], reg: &mut Reg, unreg: &mut Unreg) {
    changed.iter().for_each(|(_, _, n)| unreg(n));
    restore(changed, reg);
}

/// Re-register the old keys; one that fails stays unregistered (another app took it meanwhile), so say which.
fn restore(changed: &[(GlobalAction, String, String)], reg: &mut Reg) {
    for (a, o, _) in changed {
        if let Err(e) = reg(*a, o) {
            eprintln!("velo: {a:?} hotkey {o} not restored: {e}");
        }
    }
}

#[tauri::command]
pub fn get_settings(st: State<AppState>) -> Settings {
    st.settings.lock().unwrap().clone()
}

#[tauri::command(async)]
pub fn set_settings(app: AppHandle, st: State<'_, AppState>, settings: Settings) -> Res<()> {
    let old = st.settings.lock().unwrap().clone();
    let changed = changed_globals(&old, &settings);
    // All-or-nothing on purpose: if any new key fails, every action keeps its old key and nothing is saved,
    // so settings.json and the registered keys always agree.
    let (mut reg, mut unreg) = (|a, k: &str| register_global(&app, a, k), |k: &str| unregister_hotkey(&app, k));
    let held: Vec<String> = old.global_bindings().into_iter().filter(|(a, _)| !changed.iter().any(|(c, ..)| c == a)).map(|(_, k)| k).collect();
    swap_globals(&changed, &held, &mut reg, &mut unreg)?;
    let (no_vault, indexing) = (st.vault.lock().unwrap().is_none(), st.indexing.lock().unwrap().is_some());
    if needs_reopen(&old.notes_dir, &settings.notes_dir, no_vault, indexing) {
        let opened = match &settings.notes_dir {
            Some(dir) => open_vault(&app, &st, dir).map_err(err),
            None => {
                st.open_gen.fetch_add(1, Ordering::SeqCst); // discard any open still in flight
                let w = st.watcher.lock().unwrap().take();
                *st.vault.lock().unwrap() = None;
                w.map(|w| w.stop());
                Ok(())
            }
        };
        if let Err(e) = opened {
            revert_globals(&changed, &mut reg, &mut unreg); // old keys must be live again
            return Err(e);
        }
    }
    let agent = app.state::<AgentState>();
    let was_running = agent.listener.lock().unwrap().is_some();
    if settings.agent_access {
        // before saving: a listener that can't start must not leave access "on" with nothing answering
        set_access(&agent.listener, true, || listener::start(app.clone())).map_err(|e| e.to_string())?;
    }
    if let Err(e) = settings::save(&st.settings_path, &settings) {
        if !was_running {
            set_access(&agent.listener, false, || unreachable!()).ok(); // access stays off: no listener
        }
        return Err(err(e));
    }
    let on = settings.agent_access;
    *st.settings.lock().unwrap() = settings;
    if !on {
        set_access(&agent.listener, false, || unreachable!()).ok(); // removes agent.json; later calls see the switch off
    }
    Ok(())
}

/// Reopen when the folder changed, or when a folder is set but there is no vault and no open in flight.
fn needs_reopen(old: &Option<PathBuf>, new: &Option<PathBuf>, no_vault: bool, indexing: bool) -> bool {
    old != new || (no_vault && !indexing && new.is_some())
}

#[tauri::command(async)]
pub fn index_status(st: State<'_, AppState>) -> Option<(usize, usize)> {
    *st.indexing.lock().unwrap()
}

#[tauri::command(async)]
pub fn timeline(st: State<'_, AppState>, query: String, tags: Vec<String>, no_links: bool, by: TimelineBy, since_ms: Option<i64>) -> Res<Vec<TimelineRow>> {
    with_vault(&st, |v, _| v.timeline(&query, &tags, no_links, by, since_ms))
}

fn export_today() -> String {
    chrono::Local::now().format("%F").to_string()
}

#[tauri::command(async)]
pub fn export_preview(st: State<'_, AppState>, request: ExportRequest) -> Res<ExportCounts> {
    with_vault(&st, |v, _| Ok(export::build(v, &request, &export_today())?.1))
}

#[tauri::command(async)]
pub fn export_text(st: State<'_, AppState>, request: ExportRequest) -> Res<String> {
    with_vault(&st, |v, _| Ok(export::build(v, &request, &export_today())?.0))
}

/// PDF export: the native print dialog for the calling webview (the frontend has filled its print-only container).
#[tauri::command]
pub fn print_page(webview: tauri::Webview) -> Res<()> {
    webview.print().map_err(|e| e.to_string())
}

/// Writes exactly `path` (the file the user picked in the save dialog).
#[tauri::command(async)]
pub fn export_markdown(st: State<'_, AppState>, path: String, request: ExportRequest) -> Res<ExportCounts> {
    with_vault(&st, |v, _| {
        let (text, counts) = export::build(v, &request, &export_today())?;
        export::write(Path::new(&path), &text)?;
        Ok(counts)
    })
}

#[tauri::command(async)]
pub fn search(st: State<'_, AppState>, query: String, sort: Sort, offset: usize, tags: Vec<String>, no_links: Option<bool>) -> Res<Page> {
    with_vault(&st, |v, _| v.search_where(&query, sort, offset, &tags, no_links.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn list_tags(st: State<'_, AppState>) -> Res<Vec<TagCount>> {
    with_vault(&st, |v, _| v.tags())
}

#[tauri::command(async)]
pub fn list_titles(st: State<'_, AppState>) -> Res<Vec<String>> {
    with_vault(&st, |v, _| v.titles())
}

#[tauri::command(async)]
pub fn list_link_targets(st: State<'_, AppState>) -> Res<Vec<crate::index::LinkTarget>> {
    with_vault(&st, |v, _| v.link_targets())
}

#[tauri::command(async)]
pub fn create_from_selection(st: State<'_, AppState>, title: String, text: String) -> Res<String> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault(&st, |v, _| v.create_from_selection(&title, &text, fm))
}

/// Longest wait for an agent's backend write to the note being opened (it is then opened as it is).
const AGENT_HOLD_MAX: std::time::Duration = std::time::Duration::from_secs(5);

#[tauri::command(async)]
pub fn open_note(st: State<'_, AppState>, agent: State<'_, AgentState>, path: String) -> Res<NoteDoc> {
    agent.editors.wait_free(&path, AGENT_HOLD_MAX); // an agent may be writing it right now
    with_vault(&st, |v, id| v.open_note(&path, id))
}

#[derive(serde::Serialize)]
pub struct Opened {
    #[serde(flatten)]
    doc: NoteDoc,
    /// the file did not exist before this call (⌥↩ adds a checklist only then)
    created: bool,
}

#[tauri::command(async)]
pub fn open_or_create(st: State<'_, AppState>, agent: State<'_, AgentState>, title: String) -> Res<Opened> {
    if let Ok(Some(path)) = with_vault(&st, |v, _| v.find_note(&title)) {
        agent.editors.wait_free(&path, AGENT_HOLD_MAX);
    }
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault(&st, |v, id| v.open_or_create_new(&title, id, fm)).map(|(doc, created)| Opened { doc, created })
}

#[tauri::command(async)]
pub fn save_note(st: State<'_, AppState>, path: String, text: String, base_hash: String) -> Res<SaveResult> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault(&st, |v, id| v.save_note(&path, &text, &base_hash, id, fm))
}

#[tauri::command(async)]
pub fn link_mention(st: State<'_, AppState>, path: String, target_title: String, expected_count: usize, editor_text: Option<String>) -> Res<Option<String>> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault(&st, |v, _| v.link_mention(&path, &target_title, expected_count, editor_text.as_deref(), fm))
}

#[tauri::command(async)]
pub fn tasks(st: State<'_, AppState>, query: String, tags: Vec<String>, show_done: bool) -> Res<TaskView> {
    with_vault(&st, |v, _| v.tasks(&query, &tags, show_done))
}

#[tauri::command(async)]
pub fn toggle_task(st: State<'_, AppState>, path: String, line: usize, expected: String) -> Res<crate::vault::Toggled> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault(&st, |v, id| v.toggle_task(&path, line, &expected, id, fm))
}

#[tauri::command(async)]
pub fn capture_task(st: State<'_, AppState>, text: String) -> Res<String> {
    let (fm, title) = { let s = st.settings.lock().unwrap(); (s.write_front_matter, settings::capture_title(&s, &crate::tasks::local_today())) };
    with_vault(&st, |v, id| v.capture_task(&title, &text, id, fm))
}

#[derive(serde::Serialize)]
pub struct CaptureTarget {
    title: String,
    /// The existing note capture_task would write to (an alias resolves to its note); None if it would create one.
    path: Option<String>,
}

/// The note quick capture appends to (the field hint and the frontend's "is it open?" check).
#[tauri::command(async)]
pub fn capture_target_title(st: State<'_, AppState>) -> CaptureTarget {
    let title = settings::capture_title(&st.settings.lock().unwrap(), &crate::tasks::local_today());
    // best effort: no folder or indexing leaves path None and the frontend compares titles
    let path = with_vault(&st, |v, _| v.find_note(&title)).ok().flatten();
    CaptureTarget { title, path }
}

/// Capture mode ended. `hide` (Enter or Esc, not a blur): if the shortcut showed velo, hide it again so the previous app is back in front.
#[tauri::command]
pub fn capture_done(app: AppHandle, st: State<'_, AppState>, hide: bool) {
    if !capture_ended(&st.capture_was_hidden, hide) {
        return;
    }
    #[cfg(target_os = "macos")]
    app.hide().ok();
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        w.hide().ok();
    }
}

/// Dock badge: macOS only, a no-op elsewhere.
#[tauri::command]
pub fn set_badge(app: AppHandle, count: u32) {
    #[cfg(target_os = "macos")]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count == 0 { None } else { Some(count as i64) });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, count);
}

#[tauri::command(async)]
pub fn rename_note(st: State<'_, AppState>, path: String, new_title: String, rewrite_links: bool) -> Res<RenameResult> {
    with_vault(&st, |v, _| v.rename_note(&path, &new_title, rewrite_links))
}

#[tauri::command(async)]
pub fn connections(st: State<'_, AppState>, path: String) -> Res<crate::connections::Connections> {
    with_vault(&st, |v, _| v.connections(&path, &|_| false))
}

#[tauri::command(async)]
pub fn backlink_count(st: State<'_, AppState>, title: String) -> Res<usize> {
    with_vault(&st, |v, _| v.backlink_count(&title))
}

#[tauri::command(async)]
pub fn lock_note(st: State<'_, AppState>, path: String) -> Res<String> {
    with_vault(&st, |v, id| v.lock_note(&path, id.ok_or_else(|| anyhow::anyhow!("no-identity"))?))
}

#[tauri::command(async)]
pub fn unlock_note(st: State<'_, AppState>, path: String) -> Res<String> {
    with_vault(&st, |v, id| v.unlock_note(&path, id.ok_or_else(|| anyhow::anyhow!("no-identity"))?))
}

#[tauri::command(async)]
pub fn list_revisions(st: State<'_, AppState>, path: String) -> Res<Vec<RevisionInfo>> {
    with_vault(&st, |v, _| v.list_revisions(&path))
}

#[tauri::command(async)]
pub fn read_revision(st: State<'_, AppState>, path: String, id: String) -> Res<String> {
    with_vault(&st, |v, ident| v.read_revision(&path, &id, ident))
}

#[tauri::command(async)]
pub fn snapshot_text(st: State<'_, AppState>, path: String, text: String) -> Res<()> {
    with_vault(&st, |v, ident| v.snapshot_text(&path, &text, ident))
}

/// Agent undo trail for a write the editor applies (`agent-write`): snapshot the saved note with the summary first.
#[tauri::command(async)]
pub fn snapshot_agent(st: State<'_, AppState>, path: String, summary: String) -> Res<Option<String>> {
    with_vault(&st, |v, _| v.agent_snapshot(&path, &summary))
}

/// The editor did not apply the agent write after all: drop the agent snapshot `id` taken for it (agent ones only).
#[tauri::command(async)]
pub fn drop_agent_snapshot(st: State<'_, AppState>, path: String, id: String) -> Res<()> {
    with_vault(&st, |v, _| {
        if v.list_revisions(&path)?.iter().any(|r| r.id == id && r.agent) {
            v.drop_revision(&path, &id);
        }
        Ok(())
    })
}

/// The webview is about to apply `agent-write` `id`: false once the backend stopped waiting (then it must not).
#[tauri::command]
pub fn agent_write_claim(agent: State<'_, AgentState>, id: u64) -> bool {
    agent.editors.claim(id)
}

/// The webview's answer to `agent-write` `id`: `{hash}`, "not-open", "refused", "conflict" or "unsaved" (applied, not saved).
#[tauri::command]
pub fn agent_write_done(agent: State<'_, AgentState>, id: u64, result: serde_json::Value) {
    agent.editors.done(id, result);
}

#[tauri::command(async)]
pub fn merge_notes(st: State<'_, AppState>, source: String, target: String) -> Res<MergeResult> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault(&st, |v, _| v.merge_notes(&source, &target, fm))
}

#[tauri::command(async)]
pub fn delete_note(st: State<'_, AppState>, path: String) -> Res<()> {
    with_vault(&st, |v, _| v.delete_note(&path))
}

/// Forget the decrypted notes and the identity; locked notes need the passphrase again.
#[tauri::command(async)]
pub fn lock_all(st: State<'_, AppState>) -> Res<()> {
    with_vault(&st, |v, _| {
        v.lock_all();
        Ok(())
    })?;
    st.locked.store(true, Ordering::SeqCst);
    *st.identity.lock().unwrap() = None;
    Ok(())
}

#[tauri::command(async)]
pub fn has_identity(st: State<'_, AppState>) -> bool {
    if identity(&st).is_some() {
        return true;
    }
    // After Lock all only the passphrase brings the key back, when the folder has an identity.age to check it against.
    let dir = st.settings.lock().unwrap().notes_dir.clone();
    if st.locked.load(Ordering::SeqCst) && dir.is_some_and(|d| identity_file_exists_in(&d).unwrap_or(true)) {
        return false;
    }
    let found = crypto::keychain_get(); // no locks held across the keychain call
    let has = found.is_some();
    if has {
        *st.identity.lock().unwrap() = found;
    }
    has
}

/// Whether `<dir>/.velo/identity.age` exists; lets the UI choose between "enter" and "create" wording.
fn identity_file_exists_in(dir: &Path) -> std::io::Result<bool> {
    Ok(read_identity_file(&dir.join(crypto::IDENTITY_FILE))?.is_some())
}

#[tauri::command(async)]
pub fn identity_file_exists(st: State<'_, AppState>) -> Res<bool> {
    let dir = st.settings.lock().unwrap().notes_dir.clone().ok_or("no-folder")?;
    identity_file_exists_in(&dir).map_err(|e| e.to_string())
}

/// None only when the file does not exist; any other read error must abort.
fn read_identity_file(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Pick the identity for `setup_passphrase`: the folder's wrapped one wins, else reuse the
/// keychain one (never replace it), else make a new one. Returns bytes to write to identity.age.
fn resolve_identity(file: Option<&[u8]>, existing: Option<String>, passphrase: &str) -> Result<(String, Option<Vec<u8>>), &'static str> {
    if let Some(bytes) = file {
        return crypto::unwrap_identity(bytes, passphrase).map(|id| (id, None)).map_err(|_| "wrong-passphrase");
    }
    let id = existing.unwrap_or_else(crypto::new_identity);
    let wrapped = crypto::wrap_identity(&id, passphrase).map_err(|_| "wrap-failed")?;
    Ok((id, Some(wrapped)))
}

#[tauri::command(async)]
pub fn setup_passphrase(app: AppHandle, st: State<'_, AppState>, passphrase: String) -> Res<Option<String>> {
    check_gate(&st.indexing)?; // its final reopen would race the in-flight index
    let dir = st.settings.lock().unwrap().notes_dir.clone().ok_or("no-folder")?;
    let file = dir.join(crypto::IDENTITY_FILE);
    let existing = identity(&st).or_else(crypto::keychain_get);
    let bytes = read_identity_file(&file).map_err(|e| e.to_string())?;
    let (id, to_write) = resolve_identity(bytes.as_deref(), existing.clone(), &passphrase).map_err(String::from)?;
    if let Some(wrapped) = to_write {
        std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("age.tmp");
        // hard_link fails if identity.age appeared meanwhile: never overwrite an existing identity
        let linked = std::fs::write(&tmp, wrapped).and_then(|_| std::fs::hard_link(&tmp, &file));
        std::fs::remove_file(&tmp).ok();
        linked.map_err(|e| e.to_string())?;
    }
    let warning = keychain_warning(existing.as_deref() != Some(id.as_str()), || crypto::keychain_set(&id));
    *st.identity.lock().unwrap() = Some(id);
    st.locked.store(false, Ordering::SeqCst);
    open_vault(&app, &st, &dir).map_err(err)?; // reopening re-decrypts locked notes
    Ok(warning)
}

/// The line to paste into a terminal; single-quoted (POSIX) when the path has anything but plain path characters.
fn setup_command(exe: &Path) -> String {
    let p = exe.to_string_lossy();
    let plain = p.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+@:".contains(c));
    let p = if plain { p.into_owned() } else { format!("'{}'", p.replace('\'', r"'\''")) };
    format!("claude mcp add velo -- {p} --mcp")
}

#[tauri::command]
pub fn agent_setup_command() -> Result<String, String> {
    // an AppImage runs from a temporary mount: its own path ($APPIMAGE) is the one that stays valid
    let exe = std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
    exe.map_or_else(std::env::current_exe, Ok).map(|e| setup_command(&e)).map_err(|e| e.to_string())
}

/// A keychain write failure is not fatal: the identity stays in memory for this session.
fn keychain_warning<E>(needs_set: bool, set: impl FnOnce() -> Result<(), E>) -> Option<String> {
    (needs_set && set().is_err()).then(|| "keychain-unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn setup_command_uses_current_exe() {
        let c = agent_setup_command().unwrap();
        let exe = std::env::current_exe().unwrap();
        assert!(c.starts_with("claude mcp add velo -- ") && c.ends_with(" --mcp"));
        assert!(c.contains(exe.to_str().unwrap()));
        assert_eq!(setup_command(Path::new("/a b/it's")), r"claude mcp add velo -- '/a b/it'\''s' --mcp");
    }
    #[test] fn err_maps_io_kinds() {
        let io = |k| anyhow::Error::from(std::io::Error::from(k));
        assert_eq!(err(io(std::io::ErrorKind::NotFound)), "not-found");
        assert_eq!(err(io(std::io::ErrorKind::AlreadyExists)), "already-exists");
        assert_eq!(err(anyhow::anyhow!("locked")), "locked");
    }
    #[test] fn indexing_gate_cleared_on_error() {
        let gate = Mutex::new(None);
        let r: anyhow::Result<()> = gated(&gate, || {
            assert_eq!(*gate.lock().unwrap(), Some((0, 0)));
            Err(anyhow::anyhow!("boom"))
        });
        assert!(r.is_err());
        assert_eq!(*gate.lock().unwrap(), None);
        assert_eq!(gated(&gate, || Ok(1)).unwrap(), 1);
        assert_eq!(*gate.lock().unwrap(), None);
    }
    #[test] fn with_vault_refuses_while_indexing() {
        assert_eq!(check_gate(&Mutex::new(Some((1, 2)))), Err("indexing"));
        assert_eq!(check_gate(&Mutex::new(None)), Ok(()));
    }
    #[test] fn read_identity_file_only_maps_not_found_to_none() {
        let d = tempfile::tempdir().unwrap();
        assert!(read_identity_file(&d.path().join("missing")).unwrap().is_none());
        assert!(read_identity_file(d.path()).is_err()); // a directory: read fails, not NotFound
        std::fs::write(d.path().join("f"), "x").unwrap();
        assert_eq!(read_identity_file(&d.path().join("f")).unwrap().unwrap(), b"x");
    }
    #[test] fn needs_reopen_cases() {
        let (a, b) = (Some(PathBuf::from("a")), Some(PathBuf::from("b")));
        assert!(!needs_reopen(&a, &a, true, true)); // startup open still running
        assert!(needs_reopen(&a, &a, true, false)); // truly closed
        assert!(!needs_reopen(&a, &a, false, false));
        assert!(needs_reopen(&a, &b, false, true)); // folder changed
        assert!(!needs_reopen(&None, &None, true, false));
    }
    #[test] fn identity_file_exists_in_cases() {
        let d = tempfile::tempdir().unwrap();
        assert!(!identity_file_exists_in(d.path()).unwrap());
        std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(crypto::IDENTITY_FILE), b"x").unwrap();
        assert!(identity_file_exists_in(d.path()).unwrap());
    }
    #[test] fn keychain_warning_cases() {
        assert_eq!(keychain_warning(true, || Err::<(), _>("no keychain")), Some("keychain-unavailable".into()));
        assert_eq!(keychain_warning(true, || Ok::<(), ()>(())), None);
        assert_eq!(keychain_warning(false, || Err::<(), _>("never called")), None);
    }
    #[test] fn resolve_identity_cases() {
        let id = crypto::new_identity(); let wrapped = crypto::wrap_identity(&id, "pw").unwrap();
        assert_eq!(resolve_identity(Some(&wrapped), None, "pw").unwrap(), (id.clone(), None));
        assert_eq!(resolve_identity(Some(&wrapped), Some("other".into()), "bad").unwrap_err(), "wrong-passphrase");
        let (got, bytes) = resolve_identity(None, Some(id.clone()), "pw2").unwrap();
        assert_eq!(got, id); assert_eq!(crypto::unwrap_identity(&bytes.unwrap(), "pw2").unwrap(), id);
        let (fresh, bytes) = resolve_identity(None, None, "pw3").unwrap();
        assert_eq!(crypto::unwrap_identity(&bytes.unwrap(), "pw3").unwrap(), fresh);
    }
}

#[cfg(test)]
mod global_tests {
    use super::*;
    #[test] fn a_second_capture_press_keeps_the_hidden_flag_until_the_session_ends() {
        let f = AtomicBool::new(false);
        capture_shown(&f, true); // velo was hidden
        capture_shown(&f, false); // second press: velo is in front now
        assert!(capture_ended(&f, true), "Enter hides velo again");
        capture_shown(&f, true);
        assert!(!capture_ended(&f, false), "a blur ends the session without hiding");
        capture_shown(&f, false);
        assert!(!capture_ended(&f, true), "the flag never outlives its session");
    }
    #[test] fn changed_globals_lists_only_real_changes() {
        let (a, mut b) = (Settings::default(), Settings::default());
        assert!(changed_globals(&a, &b).is_empty());
        b.shortcuts.insert("capture".into(), "Mod+KeyG".into());
        b.shortcuts.insert("toggle_window".into(), "Mod+Shift+Space".into()); // same as default: unchanged
        assert_eq!(changed_globals(&a, &b), vec![(GlobalAction::Capture, "Mod+Alt+Shift+KeyN".to_string(), "Mod+KeyG".to_string())]);
    }
    fn with(t: &str, c: &str) -> Settings {
        let mut s = Settings::default();
        s.shortcuts.insert("toggle_window".into(), t.into()); s.shortcuts.insert("capture".into(), c.into()); s
    }
    const T: &str = "Mod+Shift+Space";
    const C: &str = "Mod+Alt+Shift+KeyN";
    fn ch(a: GlobalAction, o: &str, n: &str) -> (GlobalAction, String, String) { (a, o.into(), n.into()) }
    #[test] fn changed_globals_toggle_both_swap_none() {
        use GlobalAction::*;
        let d = Settings::default();
        assert_eq!(changed_globals(&d, &with("Mod+KeyG", C)), vec![ch(ToggleWindow, T, "Mod+KeyG")]);
        assert_eq!(changed_globals(&d, &with("Mod+KeyG", "Mod+KeyH")), vec![ch(ToggleWindow, T, "Mod+KeyG"), ch(Capture, C, "Mod+KeyH")]);
        assert_eq!(changed_globals(&d, &with(C, T)), vec![ch(ToggleWindow, T, C), ch(Capture, C, T)]);
        assert_eq!(changed_globals(&d, &with("none", C)), vec![ch(ToggleWindow, T, "none")]);
        assert_eq!(changed_globals(&with("none", C), &d), vec![ch(ToggleWindow, "none", T)]);
    }
    /// Runs swap_globals with a fake OS that rejects registering a held key or `bad`; returns (log, result, held keys).
    fn run(changed: &[(GlobalAction, String, String)], bad: &str) -> (Vec<String>, Result<(), String>, Vec<String>) { run_held(changed, &[], bad) }
    fn run_held(changed: &[(GlobalAction, String, String)], keep: &[String], bad: &str) -> (Vec<String>, Result<(), String>, Vec<String>) {
        use std::cell::RefCell;
        let held = RefCell::new(vec![T.to_string(), C.to_string()]);
        let log = RefCell::new(vec![]);
        let r = swap_globals(
            changed,
            keep,
            &mut |_, k| {
                log.borrow_mut().push(format!("+{k}"));
                if k == bad || held.borrow().iter().any(|h| h == k) { return Err(format!("taken {k}")); }
                held.borrow_mut().push(k.into()); Ok(())
            },
            &mut |k| { log.borrow_mut().push(format!("-{k}")); held.borrow_mut().retain(|h| h != k); },
        );
        (log.into_inner(), r, held.into_inner())
    }
    #[test] fn swap_releases_old_before_registering_new() {
        use GlobalAction::*;
        let (log, r, held) = run(&[ch(ToggleWindow, T, C), ch(Capture, C, T)], "");
        assert!(r.is_ok());
        assert_eq!(log, vec![format!("-{T}"), format!("-{C}"), format!("+{C}"), format!("+{T}")]);
        assert_eq!(held, vec![C.to_string(), T.to_string()]);
    }
    #[test] fn failed_swap_rolls_back_to_old_keys() {
        use GlobalAction::*;
        let (log, r, held) = run(&[ch(ToggleWindow, T, "Mod+KeyG"), ch(Capture, C, "Mod+KeyH")], "Mod+KeyH");
        assert!(r.is_err());
        // release old, register G, H fails, release G, re-register old T and C
        assert_eq!(log, vec![format!("-{T}"), format!("-{C}"), "+Mod+KeyG".into(), "+Mod+KeyH".into(), "-Mod+KeyG".into(), format!("+{T}"), format!("+{C}")]);
        assert_eq!(held, vec![T.to_string(), C.to_string()]);
    }
    #[test] fn swap_keeps_a_key_another_action_holds() {
        // upgrade: toggle_window was saved on capture's new default, so capture never got it; remapping capture must not free it
        let (log, r, held) = run_held(&[ch(GlobalAction::Capture, C, "Mod+KeyG")], &[C.to_string()], "");
        assert!(r.is_ok());
        assert_eq!(log, vec!["+Mod+KeyG".to_string()]);
        assert!(held.contains(&C.to_string()));
    }
}
