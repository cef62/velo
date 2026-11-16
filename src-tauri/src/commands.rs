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
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// What velo remembers of its window. Not VISIBLE: the plugin would then show or hide the window itself, against
/// the tray/hotkey logic that owns that.
pub const WINDOW_STATE: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION).union(StateFlags::MAXIMIZED);

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
    /// set by `quit`: the next close request closes velo even when the close button only hides it
    pub quitting: AtomicBool,
    /// the app-icon mode in effect: `settings.app_icon`, or the startup fallback when "none" lost its hotkey
    pub icon_mode: Mutex<String>,
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

/// `with_vault` for a note operation that may write `.velo/archived`: a failed list write is emitted as
/// `archive-error` (taken, so it never lands on a later operation).
fn with_vault_emit<T>(app: &AppHandle, st: &AppState, f: impl FnOnce(&mut Vault, Option<&str>) -> anyhow::Result<T>) -> Res<T> {
    with_vault(st, |v, id| run_reporting(v, id, f, |e, p| { app.emit(e, p).ok(); }))
}

/// Runs `f`, then reports a kept archive error whatever `f` returned (a failed note operation can still have written the list).
fn run_reporting<T>(v: &mut Vault, id: Option<&str>, f: impl FnOnce(&mut Vault, Option<&str>) -> anyhow::Result<T>, emit: impl FnOnce(&str, serde_json::Value)) -> anyhow::Result<T> {
    let r = f(v, id);
    emit_archive_error(v.archive_error.take(), emit); // under the same lock as `f`: only this operation's failure
    r
}

/// Reports a failed `.velo/archived` write, taken by the caller from the operation that left it.
pub fn emit_archive_error(m: Option<String>, emit: impl FnOnce(&str, serde_json::Value)) {
    if let Some(m) = m {
        emit("archive-error", serde_json::json!({ "message": m }));
    }
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
        let event = batch.as_ref().map_or("rescan".to_string(), |b| format!("{} paths", b.len()));
        let t = std::time::Instant::now();
        let changed = apply_watch(&st, &base, batch);
        crate::log::debug(&format!("watcher: {event} -> {} notes changed in {}ms", changed.len(), t.elapsed().as_millis()));
        notify_changed(&handle, changed);
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

/// Every window-state save in velo goes through here (the plugin's own save on RunEvent::Exit runs on the main thread).
/// Always on the main thread: off it, save_window_state holds the plugin's lock while it waits for the main thread to
/// read the window, and the plugin's Moved/Resized handlers there wait for that lock. Linux X11 runs hotkey handlers on
/// their own thread. Inline when already on the main thread, else queued. The receiver yields once the save ran, or
/// errs if it never will; a failed save is ignored.
pub fn save_window(app: &AppHandle) -> std::sync::mpsc::Receiver<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let h = app.clone();
    app.run_on_main_thread(move || {
        h.save_window_state(WINDOW_STATE).ok();
        tx.send(()).ok();
    })
    .ok();
    rx
}

fn hide_main(app: &AppHandle) {
    // The plugin writes only on RunEvent::Exit, which a Linux session end never sends; in tray and hotkey-only modes
    // velo is rarely quit. Saved before hiding, while the window is on screen: the save reads its live geometry. Off
    // the main thread the save is queued, and the hide below is queued after it on the same FIFO event-loop channel.
    save_window(app);
    let mode = app.try_state::<AppState>().map(|s| s.icon_mode.lock().unwrap().clone());
    if let Some(w) = app.get_webview_window("main").filter(|_| orders_out(mode.as_deref().unwrap_or("dock"))) {
        w.hide().ok();
    }
    #[cfg(target_os = "macos")]
    app.hide().ok(); // hides the whole app so macOS refocuses the previously active one
}

/// Whether hiding also orders the window out. macOS in dock mode keeps it: Cmd+Tab unhides the app but sends no
/// Reopen, so an ordered-out window would not come back. Tray/none (Accessory) apps are not in Cmd+Tab.
fn orders_out(mode: &str) -> bool {
    !cfg!(target_os = "macos") || mode != "dock"
}

/// velo's About box: the macOS app menu and the tray menu share it.
pub fn about_item(app: &AppHandle) -> tauri::Result<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    let meta = tauri::menu::AboutMetadata {
        name: Some("velo".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some("© 2026 Matteo Ronchi · MIT License".into()),
        website: Some("https://cef62.github.io/velo".into()),
        website_label: Some("cef62.github.io/velo".into()),
        // macOS's About panel ignores website: credits is the field it shows
        credits: cfg!(target_os = "macos").then(|| "https://cef62.github.io/velo".into()),
        ..Default::default()
    };
    tauri::menu::PredefinedMenuItem::about(app, Some("About velo"), Some(meta))
}

/// Brings the main window to the front; None if it is gone.
pub fn show_main(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let w = app.get_webview_window("main")?;
    #[cfg(target_os = "macos")]
    app.show().ok();
    w.show().ok();
    // Windows drops the taskbar tab once (DeleteTab); a later show can bring it back
    #[cfg(not(target_os = "macos"))]
    if let Some(st) = app.try_state::<AppState>() {
        let skip = *st.icon_mode.lock().unwrap() != "dock";
        w.set_skip_taskbar(skip).ok();
    }
    w.unminimize().ok();
    w.set_focus().ok();
    Some(w)
}

pub fn toggle_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        hide_main(app);
    } else if let Some(w) = show_main(app) {
        w.emit("focus-search", ()).ok();
    }
}

/// Quit for real: the next close request closes instead of hiding. The window is shown first so the
/// unsaved-edits prompt of the UI's close flow is visible.
pub fn quit(app: &AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    if let Some(w) = show_main(app) {
        w.close().ok();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    quit(&app);
}

/// Back to the configured size, centred on the window's current monitor. Shown first: a minimized window cannot be
/// resized or placed reliably (and the plugin skips saving one), so show_main unminimizes. Not saved here: on macOS
/// and Linux the resize and move are still queued; the save on hide and on quit reads the window once they landed.
pub fn reset_window(app: &AppHandle) {
    if let Some(w) = show_main(app) {
        place_default(app, &w);
    }
}

/// The reset placement, for a shown window. The position is computed rather than `center()`ed: on macOS and Linux
/// set_size and unmaximize are queued, so `center()` would use the old frame. The queues are FIFO, so the move lands
/// after the resize.
fn place_default(app: &AppHandle, w: &tauri::WebviewWindow) {
    let Some(c) = app.config().app.windows.iter().find(|c| c.label == "main") else { return };
    let Some(m) = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten()) else { return };
    let (outer, inner) = (w.outer_size().unwrap_or_default(), w.inner_size().unwrap_or_default());
    let frame = (outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
    let (s, min) = (m.scale_factor(), (c.min_width.unwrap_or(0.0), c.min_height.unwrap_or(0.0)));
    let (x, y, width, height) = reset_placement(m.work_area(), s, (c.width, c.height), min, frame, w.scale_factor().unwrap_or(s));
    w.unmaximize().ok();
    w.set_size(tauri::LogicalSize::new(width, height)).ok();
    w.set_position(tauri::LogicalPosition::new(x, y)).ok();
}

/// Reset placement in a monitor's physical work area `wa`, converted with that monitor's scale `s` (the window's own
/// scale on its current monitor): the configured logical inner `size` shrunk until the outer frame fits (never below
/// `min`), the outer frame centred, its top-left kept on screen. `frame` is the physical outer minus inner size (title
/// bar and borders; 0 on macOS, whose title bar overlays the content) at the window's scale `ws`. Returns the logical
/// outer top-left and inner size, as `set_position` and `set_size` take them.
pub(crate) fn reset_placement(wa: &tauri::PhysicalRect<i32, u32>, s: f64, size: (f64, f64), min: (f64, f64), frame: (u32, u32), ws: f64) -> (f64, f64, f64, f64) {
    let work = (wa.position.x as f64 / s, wa.position.y as f64 / s, wa.size.width as f64 / s, wa.size.height as f64 / s);
    let frame = (frame.0 as f64 / ws, frame.1 as f64 / ws);
    let w = size.0.min(work.2 - frame.0).max(min.0);
    let h = size.1.min(work.3 - frame.1).max(min.1);
    ((work.0 + (work.2 - w - frame.0) / 2.0).max(work.0), (work.1 + (work.3 - h - frame.1) / 2.0).max(work.1), w, h)
}

#[tauri::command]
pub fn reset_window_cmd(app: AppHandle) {
    reset_window(&app);
}

/// The UI's close-requested handler asks first. true = go on closing (velo quits, after the unsaved-edits check);
/// false = velo only hid, because it lives in the tray or on its hotkey and has no Dock/taskbar icon to come back from.
#[tauri::command]
pub fn close_requested(app: AppHandle, st: State<'_, AppState>) -> bool {
    if st.quitting.swap(false, Ordering::SeqCst) || *st.icon_mode.lock().unwrap() == "dock" {
        return true;
    }
    hide_main(&app);
    false
}

/// "none" leaves the Show/hide hotkey as the only way back to a hidden velo: it must be registered, not only set
/// (another app can hold the keys, and then registration failed at startup or in `set_settings`).
pub fn hotkey_only_ok(s: &Settings, live: impl Fn(&str) -> bool) -> bool {
    s.app_icon != "none" || toggle_hotkey_live(s, live)
}

pub fn toggle_hotkey_live(s: &Settings, live: impl Fn(&str) -> bool) -> bool {
    s.global_bindings().iter().any(|(a, k)| *a == GlobalAction::ToggleWindow && live(k))
}

/// The login item starts velo with this argument (see `run`); a normal launch never carries it.
pub const HIDDEN_ARG: &str = "--hidden";

/// The name of velo's login item: the LaunchAgent's file name and label on macOS (the bundle identifier, so a dev
/// build or another tool called "velo" never shares it), the `Run` value on Windows. A test pins it to `tauri.conf.json`.
pub const AUTOSTART_NAME: &str = "dev.velo.app";

pub fn has_hidden_arg(args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    args.into_iter().any(|a| a.as_ref() == HIDDEN_ARG)
}

/// A second launch (Windows/Linux single-instance) shows the running window, unless it is the login item firing.
pub fn second_launch_shows(args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    !has_hidden_arg(args)
}

/// Everything the first-show decision reads.
pub struct StartCtx<'a, S: AsRef<str>> {
    pub args: &'a [S],
    /// The relaunch after an update the user started from the window (`take_restart_mark`).
    pub after_update: bool,
    /// The notes folder is set and exists: a first run, a missing folder or the agent fence's error needs the window.
    pub notes_ready: bool,
    pub mac: bool,
    /// The tray/taskbar mode really took effect.
    pub icon_applied: bool,
    pub mode: &'a str,
    pub toggle_live: bool,
}

/// Whether this start leaves the window hidden: the login item's argument, and a way back for the user. macOS always has
/// the Dock click or a Finder launch (`RunEvent::Reopen`). Elsewhere a window with no taskbar entry is reachable only
/// through the tray icon, a registered Show/hide hotkey or a second launch, and the last one is not something a user
/// thinks of: start shown unless the tray or the hotkey is there. A hidden start never hides something the user must
/// act on, and never follows an update they just installed from the window (the installer relaunches with the
/// original arguments, `--hidden` included, and on Windows Tauri gives no way to drop it).
pub fn start_hidden<S: AsRef<str>>(c: &StartCtx<S>) -> bool {
    has_hidden_arg(c.args.iter().map(|a| a.as_ref()))
        && !c.after_update
        && c.notes_ready
        && c.icon_applied
        && (c.mac || c.mode == "tray" || c.toggle_live)
}

#[derive(Debug, PartialEq, Eq)]
pub enum FirstShow {
    Show,
    /// macOS Dock mode: window ordered in and the whole app hidden, as `hide_main` leaves it (Cmd+Tab still works).
    ShowThenHideApp,
    /// macOS tray / hotkey only: no window, and the app hides so it does not keep the focus.
    HideApp,
    Leave,
}

pub fn first_show_plan(hidden: bool, mac: bool, mode: &str) -> FirstShow {
    match (hidden, mac) {
        (false, _) => FirstShow::Show,
        (true, true) if mode == "dock" => FirstShow::ShowThenHideApp,
        (true, true) => FirstShow::HideApp,
        (true, false) => FirstShow::Leave,
    }
}

/// First show of the main window (declared `visible: false`). Through `show_main`, the one way velo shows it: on Windows
/// the taskbar tab that `set_skip_taskbar` could not delete from the invisible window must be dropped after the show.
pub fn first_show(app: &AppHandle, plan: FirstShow) {
    if matches!(plan, FirstShow::Show | FirstShow::ShowThenHideApp) {
        show_main(app);
    }
    #[cfg(target_os = "macos")]
    if matches!(plan, FirstShow::ShowThenHideApp | FirstShow::HideApp) {
        app.hide().ok(); // show_main's app.show() brings it back
    }
}

const RESTART_MARK: &str = "restart-shown";
const RESTART_MARK_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// Written before an update installs (the user clicked in a visible window); the relaunch consumes it.
pub fn mark_restart(dir: &Path) {
    std::fs::write(dir.join(RESTART_MARK), b"").ok();
}

pub fn clear_restart_mark(dir: &Path) {
    std::fs::remove_file(dir.join(RESTART_MARK)).ok();
}

/// An update's download-and-install `step` with the restart mark around it. `step` gets the end-of-download hook: it runs
/// `done` (the window save), then writes the mark, last, so its ten minutes start after the download, and before the
/// install step that ends the process on Windows. A failed step clears the mark.
pub async fn with_restart_mark<'a, E, F: Future<Output = Result<(), E>>>(
    dir: &'a Path,
    done: impl FnOnce() + Send + 'a,
    step: impl FnOnce(Box<dyn FnOnce() + Send + 'a>) -> F,
) -> Result<(), E> {
    let result = step(Box::new(move || {
        done();
        mark_restart(dir);
    }))
    .await;
    if result.is_err() {
        clear_restart_mark(dir);
    }
    result
}

/// What a GUI start does about another velo on the same data dir (macOS, see `hold_instance_lock`).
#[derive(Debug, PartialEq, Eq)]
pub enum Instance {
    Run,
    /// The login item firing while velo runs: the running one is the app.
    Exit,
    /// A launch by the user that lost the race to a hidden login start: that velo must show its window.
    ShowOtherThenExit,
}

pub fn instance_plan(held_here: bool, hidden: bool) -> Instance {
    match (held_here, hidden) {
        (true, _) => Instance::Run,
        (false, true) => Instance::Exit,
        (false, false) => Instance::ShowOtherThenExit,
    }
}

/// Takes the exclusive lock on `dir/instance.lock` for the rest of the process (the OS drops it at exit or crash, so no
/// stale lock is left). Retried for `wait`: the relaunch after an update can start before the old process has ended.
/// False only when another process holds it; a file system that cannot lock lets velo run.
pub fn hold_instance_lock(dir: &Path, wait: std::time::Duration) -> bool {
    let Ok(f) = std::fs::File::options().create(true).truncate(false).write(true).open(dir.join("instance.lock")) else { return true };
    let until = std::time::Instant::now() + wait;
    loop {
        match f.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(std::fs::TryLockError::WouldBlock) => return false,
            Err(std::fs::TryLockError::Error(e)) => {
                crate::log::line(&format!("instance lock not taken: {e}"));
                break;
            }
        }
    }
    std::mem::forget(f); // held until the process ends
    true
}

/// Has the running velo (the lock holder) show its window, through LaunchServices as a Finder launch would (it sends
/// `RunEvent::Reopen`). `open` runs once this process is gone, so it cannot pick this copy. Should LaunchServices start a
/// new copy instead, `--hidden` makes that copy exit (or, if the holder is gone by then, start as a login start would).
#[cfg(target_os = "macos")]
pub fn show_other_after_exit() {
    let script = format!("while kill -0 {} 2>/dev/null; do sleep 0.1; done; sleep 0.3; exec /usr/bin/open -b {AUTOSTART_NAME} --args {HIDDEN_ARG}", std::process::id());
    if let Err(e) = std::process::Command::new("/bin/sh").args(["-c", &script]).spawn() {
        crate::log::line(&format!("could not ask the running velo to show: {e}"));
    }
}

/// True once for a mark younger than ten minutes; an older one (an install that never relaunched) is only deleted.
pub fn take_restart_mark(dir: &Path) -> bool {
    let p = dir.join(RESTART_MARK);
    let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < RESTART_MARK_TTL);
    std::fs::remove_file(&p).ok();
    fresh
}

/// Why a login item must not point at this executable, if so. `os` is `std::env::consts::OS`. The crate writes the path
/// unquoted and unescaped. macOS: an App Translocation path (a quarantined app run from where it was downloaded) is
/// gone after a reboot, and `& < >` make the plist invalid. Linux: a space or `%` splits or expands the `Exec=` line.
/// A development build is not the installed app that shares the item's name.
pub fn login_item_refusal(exe: &str, os: &str, debug_build: bool) -> Option<&'static str> {
    if debug_build {
        return Some("Start at login is not available in a development build.");
    }
    match os {
        "macos" if exe.contains("/AppTranslocation/") => Some("macOS is running velo from a temporary location. Move velo to Applications, open it from there, then turn Start at login on."),
        "macos" if exe.contains(['&', '<', '>']) => Some("velo's folder name contains & < or >, which a login item cannot hold. Move velo to Applications, then turn Start at login on."),
        // every character the Desktop Entry spec reserves (whitespace, " ' \ > < ~ | & ; $ * ? # ( ) `), and % (field codes)
        "linux" if exe.contains(|c: char| c.is_whitespace() || "%\"'\\><~|&;$*?#()`".contains(c)) => Some("velo's path contains a space or one of % \" ' \\ > < ~ | & ; $ * ? # ( ) `, which an autostart entry cannot hold. Move velo to a folder without them, then turn Start at login on."),
        _ => None,
    }
}

/// Why `set_autostart` failed when the OS reported success but kept the previous state. On Windows that is an all-users
/// (HKLM) item an elevated velo wrote: the plugin deletes only the current user's value when HKLM is not writable.
pub fn kept_state_error(os: &str, requested: bool, now: bool) -> Option<&'static str> {
    (requested != now).then_some(if os == "windows" && !requested {
        "Windows keeps this item for all users; run velo as administrator to turn it off."
    } else {
        "The system kept the previous state."
    })
}

/// The path the crate writes: `$APPIMAGE` for an AppImage (the executable itself sits in a temporary mount), else the executable.
fn login_exe() -> String {
    let own = || std::env::current_exe().and_then(|p| p.canonicalize()).map(|p| p.display().to_string()).unwrap_or_default();
    login_exe_for(std::env::consts::OS, std::env::var("APPIMAGE").ok(), own)
}

fn login_exe_for(os: &str, appimage: Option<String>, own: impl FnOnce() -> String) -> String {
    appimage.filter(|_| os == "linux").unwrap_or_else(own)
}

fn refusal() -> Option<&'static str> {
    login_item_refusal(&login_exe(), std::env::consts::OS, cfg!(debug_assertions))
}

/// `ProgramArguments[0]` of a LaunchAgent plist as the crate writes it.
fn plist_program(plist: &str) -> Option<&str> {
    plist.split("<key>ProgramArguments</key>").nth(1)?.split("<string>").nth(1)?.split("</string>").next()
}

/// Whether to rewrite the login item at startup. macOS only: its plist keeps the path from the day it was enabled, so a
/// moved app goes stale. Linux and Windows are left alone (a rewrite would undo what the desktop's own startup settings
/// wrote into the entry, and on Windows an elevated start would write the all-users key). Never an item that is off, never
/// a refused path, and only when the recorded path differs, so a normal start writes nothing (no macOS "Background Items
/// Added" notice each time).
pub fn should_refresh(os: &str, enabled: bool, refused: bool, recorded: Option<&str>, exe: &str) -> bool {
    os == "macos" && enabled && !refused && recorded != Some(exe)
}

pub fn refresh_login_item(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let exe = login_exe();
    let recorded = dirs::home_dir().and_then(|h| std::fs::read_to_string(h.join("Library/LaunchAgents").join(format!("{AUTOSTART_NAME}.plist"))).ok());
    let launcher = app.autolaunch();
    if should_refresh(std::env::consts::OS, launcher.is_enabled().unwrap_or(false), refusal().is_some(), recorded.as_deref().and_then(plist_program), &exe)
        && let Err(e) = launcher.enable()
    {
        crate::log::line(&format!("could not refresh the start at login item: {e}"));
    }
}

/// The OS's own answer: velo keeps no copy. On macOS (LaunchAgent) that is whether the plist exists: a toggle in
/// System Settings › Login Items is not visible to it.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Res<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Flips the login item, then answers what the OS reports. A failure is logged and returned; the caller re-reads.
/// Turning it off is never refused: a development build may remove an item the installed app wrote.
#[tauri::command(async)]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Res<bool> {
    use tauri_plugin_autostart::ManagerExt;
    let verb = if enabled { "turn on" } else { "turn off" };
    if let Some(why) = refusal().filter(|_| enabled) {
        crate::log::line(&format!("could not {verb} start at login: {why}"));
        return Err(why.into());
    }
    let launcher = app.autolaunch();
    if let Err(e) = if enabled { launcher.enable() } else { launcher.disable() } {
        crate::log::line(&format!("could not {verb} start at login: {e}"));
        return Err(format!("Could not {verb} start at login: {e}"));
    }
    let now = launcher.is_enabled().map_err(|e| e.to_string())?;
    if let Some(why) = kept_state_error(std::env::consts::OS, enabled, now) {
        crate::log::line(&format!("could not {verb} start at login: {why}"));
        return Err(format!("Could not {verb} start at login: {why}"));
    }
    Ok(now)
}

pub fn hotkey_live(app: &AppHandle, binding: &str) -> bool {
    settings::parse_hotkey(binding).ok().flatten().is_some_and(|sc| app.global_shortcut().is_registered(sc))
}

/// Shows velo in the Dock/taskbar ("dock"), the menu bar/system tray ("tray") or neither ("none").
pub fn apply_app_icon(app: &AppHandle, mode: &str) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(if mode == "dock" { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory })?;
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        w.set_skip_taskbar(mode != "dock")?;
    }
    if mode != "tray" {
        app.remove_tray_by_id("main");
    } else if app.tray_by_id("main").is_none() {
        build_tray(app)?;
    }
    if let Some(st) = app.try_state::<AppState>() {
        *st.icon_mode.lock().unwrap() = mode.into();
    }
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(app, &[
        &item("tray-show", "Show velo")?,
        &item("tray-capture", "Quick capture")?,
        &item("tray-daily", "Today's daily note")?,
        &PredefinedMenuItem::separator(app)?,
        &item("tray-settings", "Settings…")?,
        &item("tray-reset", "Reset window position and size")?,
        &item("tray-updates", "Check for Updates…")?,
        &about_item(app)?,
        &PredefinedMenuItem::separator(app)?,
        &item("tray-quit", "Quit velo")?,
    ])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("velo")
        .menu(&menu)
        .show_menu_on_left_click(false) // left click toggles the window, right click opens the menu
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "tray-show" => {
                show_main(app).map(|w| w.emit("focus-search", ()).ok());
            }
            "tray-capture" => capture_requested(app, true),
            // the UI runs these as their shortcuts would; check-updates shows its result in the window
            "tray-daily" | "tray-settings" | "tray-updates" => {
                show_main(app);
                match ev.id().as_ref() {
                    "tray-daily" => app.emit("run-action", "daily_note"),
                    "tray-settings" => app.emit("run-action", "settings"),
                    _ => app.emit("check-updates", ()),
                }
                .ok();
            }
            "tray-reset" => reset_window(app),
            "tray-quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                // on screen = hide, whatever has focus: a tray click takes focus first (Windows) or not at all (macOS)
                let app = tray.app_handle();
                if app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)) {
                    hide_main(app);
                } else if let Some(w) = show_main(app) {
                    w.emit("focus-search", ()).ok();
                }
            }
        });
    // macOS: a black glyph that the menu bar tints for light/dark (icons/tray-template.svg is the source)
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Remembers whether velo was hidden (for Task 8's capture_done), then shows it like `toggle_window` and tells the UI.
/// `tray`: Windows/Linux give the foreground to the tray first, so velo on screen never reads as focused there.
pub fn capture_requested(app: &AppHandle, tray: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    let shown = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    let hidden = if tray && !cfg!(target_os = "macos") { !shown } else { !(shown && w.is_focused().unwrap_or(false)) };
    capture_shown(&app.state::<AppState>().capture_was_hidden, hidden);
    show_main(app);
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
                    GlobalAction::Capture => capture_requested(app, false),
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

/// One record from the window: errors and warnings always, "debug" only while Debug logging is on.
#[tauri::command]
pub fn log_line(level: String, text: String) {
    crate::log::window(&level, &text);
}

#[tauri::command]
pub fn get_settings(st: State<AppState>) -> Settings {
    st.settings.lock().unwrap().clone()
}

#[tauri::command(async)]
pub fn set_settings(app: AppHandle, st: State<'_, AppState>, mut settings: Settings) -> Res<()> {
    if !settings::APP_ICONS.contains(&settings.app_icon.as_str()) {
        settings.app_icon = "dock".into();
    }
    let old = st.settings.lock().unwrap().clone();
    let changed = changed_globals(&old, &settings);
    // All-or-nothing on purpose: if any new key fails, every action keeps its old key and nothing is saved,
    // so settings.json and the registered keys always agree.
    let (mut reg, mut unreg) = (|a, k: &str| register_global(&app, a, k), |k: &str| unregister_hotkey(&app, k));
    let held: Vec<String> = old.global_bindings().into_iter().filter(|(a, _)| !changed.iter().any(|(c, ..)| c == a)).map(|(_, k)| k).collect();
    swap_globals(&changed, &held, &mut reg, &mut unreg)?;
    // only when the mode or the Show/hide key changes: a startup fallback (key taken, tray shown) must not block every other setting
    let recheck = old.app_icon != settings.app_icon || changed.iter().any(|(a, ..)| *a == GlobalAction::ToggleWindow);
    if recheck && !hotkey_only_ok(&settings, |k| hotkey_live(&app, k)) {
        revert_globals(&changed, &mut reg, &mut unreg);
        return Err("Hotkey only needs a working Show / hide velo shortcut: set one, or pick another that no other app uses".into());
    }
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
    crate::log::set_debug(settings.debug_log);
    let on = settings.agent_access;
    let icon = (old.app_icon != settings.app_icon).then(|| settings.app_icon.clone());
    *st.settings.lock().unwrap() = settings;
    if let Some(mode) = icon {
        if let Err(e) = apply_app_icon(&app, &mode) {
            eprintln!("velo: app icon mode not applied: {e}");
        }
        show_main(&app); // a macOS activation-policy switch can drop the window behind other apps
    }
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
pub fn timeline(st: State<'_, AppState>, query: String, tags: Vec<String>, no_links: bool, include_archived: Option<bool>, by: TimelineBy, since_ms: Option<i64>) -> Res<Vec<TimelineRow>> {
    with_vault(&st, |v, _| v.timeline(&query, &tags, no_links, include_archived.unwrap_or(false), by, since_ms))
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
pub fn search(st: State<'_, AppState>, query: String, sort: Sort, offset: usize, tags: Vec<String>, no_links: Option<bool>, include_archived: Option<bool>) -> Res<Page> {
    with_vault(&st, |v, _| v.search_where(&query, sort, offset, &tags, no_links.unwrap_or(false), include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn list_tags(st: State<'_, AppState>, include_archived: Option<bool>) -> Res<Vec<TagCount>> {
    with_vault(&st, |v, _| v.tags(include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn list_titles(st: State<'_, AppState>) -> Res<Vec<String>> {
    with_vault(&st, |v, _| v.titles())
}

#[tauri::command(async)]
pub fn list_link_targets(st: State<'_, AppState>, include_archived: Option<bool>) -> Res<Vec<crate::index::LinkTarget>> {
    with_vault(&st, |v, _| v.link_targets(include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn create_from_selection(app: AppHandle, st: State<'_, AppState>, title: String, text: String) -> Res<String> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault_emit(&app, &st, |v, _| v.create_from_selection(&title, &text, fm))
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
pub fn open_or_create(app: AppHandle, st: State<'_, AppState>, agent: State<'_, AgentState>, title: String) -> Res<Opened> {
    if let Ok(Some(path)) = with_vault(&st, |v, _| v.find_note(&title)) {
        agent.editors.wait_free(&path, AGENT_HOLD_MAX);
    }
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault_emit(&app, &st, |v, id| v.open_or_create_new(&title, id, fm)).map(|(doc, created)| Opened { doc, created })
}

#[tauri::command(async)]
pub fn save_note(app: AppHandle, st: State<'_, AppState>, path: String, text: String, base_hash: String) -> Res<SaveResult> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault_emit(&app, &st, |v, id| v.save_note(&path, &text, &base_hash, id, fm))
}

#[tauri::command(async)]
pub fn link_mention(app: AppHandle, st: State<'_, AppState>, path: String, target_title: String, expected_count: usize, editor_text: Option<String>, include_archived: Option<bool>) -> Res<Option<String>> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault_emit(&app, &st, |v, _| v.link_mention(&path, &target_title, expected_count, editor_text.as_deref(), fm, include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn tasks(st: State<'_, AppState>, query: String, tags: Vec<String>, show_done: bool, include_archived: Option<bool>) -> Res<TaskView> {
    with_vault(&st, |v, _| v.tasks(&query, &tags, show_done, include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn toggle_task(app: AppHandle, st: State<'_, AppState>, path: String, line: usize, expected: String) -> Res<crate::vault::Toggled> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault_emit(&app, &st, |v, id| v.toggle_task(&path, line, &expected, id, fm))
}

#[tauri::command(async)]
pub fn capture_task(app: AppHandle, st: State<'_, AppState>, text: String) -> Res<String> {
    let (fm, title) = { let s = st.settings.lock().unwrap(); (s.write_front_matter, settings::capture_title(&s, &crate::tasks::local_today())) };
    with_vault_emit(&app, &st, |v, id| v.capture_task(&title, &text, id, fm))
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
    if capture_ended(&st.capture_was_hidden, hide) {
        hide_main(&app);
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
pub fn rename_note(app: AppHandle, st: State<'_, AppState>, path: String, new_title: String, rewrite_links: bool) -> Res<RenameResult> {
    with_vault_emit(&app, &st, |v, _| v.rename_note(&path, &new_title, rewrite_links))
}

#[tauri::command(async)]
pub fn connections(st: State<'_, AppState>, path: String, include_archived: Option<bool>) -> Res<crate::connections::Connections> {
    with_vault(&st, |v, _| v.connections(&path, &|_| false, include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
pub fn backlink_count(st: State<'_, AppState>, title: String) -> Res<usize> {
    with_vault(&st, |v, _| v.backlink_count(&title))
}

#[tauri::command(async)]
pub fn lock_note(app: AppHandle, st: State<'_, AppState>, path: String) -> Res<String> {
    with_vault_emit(&app, &st, |v, id| v.lock_note(&path, id.ok_or_else(|| anyhow::anyhow!("no-identity"))?))
}

#[tauri::command(async)]
pub fn unlock_note(app: AppHandle, st: State<'_, AppState>, path: String) -> Res<String> {
    with_vault_emit(&app, &st, |v, id| v.unlock_note(&path, id.ok_or_else(|| anyhow::anyhow!("no-identity"))?))
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
pub fn merge_notes(app: AppHandle, st: State<'_, AppState>, source: String, target: String) -> Res<MergeResult> {
    let fm = st.settings.lock().unwrap().write_front_matter;
    with_vault_emit(&app, &st, |v, _| v.merge_notes(&source, &target, fm))
}

#[tauri::command(async)]
pub fn delete_note(app: AppHandle, st: State<'_, AppState>, path: String) -> Res<()> {
    with_vault_emit(&app, &st, |v, _| v.delete_note(&path))
}

/// Archive or unarchive the note at `path` (a locked note needs no key). Errors are returned, not emitted.
#[tauri::command(async)]
pub fn set_archived(st: State<'_, AppState>, path: String, archived: bool) -> Res<()> {
    with_vault(&st, |v, _| v.set_archived(&path, archived))
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
    #[cfg(unix)] #[test] fn note_operations_report_a_failed_list_write_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap().keep(); let db = tempfile::tempdir().unwrap().keep().join("i.sqlite");
        std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = Vault::open_with_progress(dir.clone(), &db, None, &mut |_, _| {}).unwrap();
        let p = dir.join("Old.md").to_string_lossy().into_owned();
        v.set_archived(&p, true).unwrap();
        let lock = |m| std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(m)).unwrap();
        let run = |v: &mut Vault, f: &dyn Fn(&mut Vault) -> anyhow::Result<()>| { let mut n = 0; let r = run_reporting(v, None, |v, _| f(v), |_, _| n += 1); (r.is_ok(), n) };
        lock(0o555);
        assert_eq!(run(&mut v, &|v| v.rename_note(&p, "New", false).map(|_| ())), (true, 1)); // the list write fails, the rename succeeds
        lock(0o755);
        assert_eq!(run(&mut v, &|_| Ok(())).1, 0); // a clean operation emits nothing
        v.archive_error.set(Some("kept".into()));
        assert_eq!(run(&mut v, &|_| Err(anyhow::anyhow!("boom"))), (false, 1)); // the error path still emits
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
mod window_tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};
    fn area(x: i32, y: i32, w: u32, h: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect { position: PhysicalPosition::new(x, y), size: PhysicalSize::new(w, h) }
    }

    #[test] fn reset_centres_the_outer_frame_in_the_work_area() {
        // macOS: no frame, menu bar 25 pt above the work area
        assert_eq!(reset_placement(&area(0, 25, 1512, 957), 1.0, (1000.0, 700.0), (600.0, 400.0), (0, 0), 1.0), (256.0, 153.5, 1000.0, 700.0));
        // a 30 pt title bar shifts the inner box down, the outer frame stays centred; a second monitor's origin counts
        assert_eq!(reset_placement(&area(1920, 0, 1920, 1040), 1.0, (1000.0, 700.0), (600.0, 400.0), (0, 30), 1.0), (2380.0, 155.0, 1000.0, 700.0));
    }

    #[test] fn reset_converts_a_2x_work_area_and_frame_to_logical_and_centres_with_side_borders() {
        // Windows at 200%: 3840x2080 physical work area, 8 px borders each side and a 31 px title bar (16 x 78 physical)
        assert_eq!(reset_placement(&area(0, 0, 3840, 2080), 2.0, (1000.0, 700.0), (600.0, 400.0), (16, 78), 2.0), (456.0, 150.5, 1000.0, 700.0));
    }

    #[test] fn reset_divides_the_work_area_by_the_monitor_scale_and_the_frame_by_the_window_scale() {
        // monitor at 200%, window still at 100% (mixed DPI): work area 1920x1080 logical, frame 16 x 60 logical
        assert_eq!(reset_placement(&area(0, 0, 3840, 2160), 2.0, (1000.0, 700.0), (600.0, 400.0), (16, 60), 1.0), (452.0, 160.0, 1000.0, 700.0));
    }

    #[test] fn reset_shrinks_to_a_small_work_area_but_not_below_the_minimum() {
        assert_eq!(reset_placement(&area(0, 0, 800, 600), 1.0, (1000.0, 700.0), (600.0, 400.0), (0, 30), 1.0), (0.0, 0.0, 800.0, 570.0));
        // smaller than the minimum: the minimum wins and the top-left stays on screen
        assert_eq!(reset_placement(&area(0, 0, 500, 300), 1.0, (1000.0, 700.0), (600.0, 400.0), (0, 0), 1.0), (0.0, 0.0, 600.0, 400.0));
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
    #[test] fn hiding_orders_out_except_macos_dock() {
        assert!(orders_out("tray") && orders_out("none"));
        assert_eq!(orders_out("dock"), !cfg!(target_os = "macos"), "macOS dock mode keeps the window for Cmd+Tab");
    }
    #[test] fn hotkey_only_needs_a_live_toggle_hotkey() {
        let mut s = Settings::default();
        assert!(hotkey_only_ok(&s, |_| false), "dock never depends on the hotkey");
        s.app_icon = "tray".into();
        assert!(hotkey_only_ok(&s, |_| false), "tray has its icon");
        s.app_icon = "none".into();
        assert!(hotkey_only_ok(&s, |k| k == "Mod+Shift+Space"));
        assert!(!hotkey_only_ok(&s, |_| false), "set but taken by another app");
        s.shortcuts.insert("toggle_window".into(), "none".into());
        assert!(!hotkey_only_ok(&s, |k| k != "none"), "cleared");
    }
    #[test] fn only_the_login_item_argument_marks_a_hidden_start() {
        assert!(has_hidden_arg(["/Applications/velo.app/Contents/MacOS/velo", "--hidden"]));
        assert!(!has_hidden_arg(["velo"]) && !has_hidden_arg(["velo", "--mcp", "hidden", "--hidden=1"]));
    }
    fn ctx<'a>(args: &'a [&'a str]) -> StartCtx<'a, &'a str> {
        StartCtx { args, after_update: false, notes_ready: true, mac: false, icon_applied: true, mode: "tray", toggle_live: false }
    }
    #[test] fn a_hidden_start_needs_the_argument_and_a_way_back() {
        let h = ["velo", "--hidden"];
        assert!(start_hidden(&ctx(&h)));
        assert!(!start_hidden(&ctx(&["velo"])), "a normal launch shows the window");
        assert!(start_hidden(&StartCtx { mac: true, mode: "dock", ..ctx(&h) }), "macOS: the Dock click reopens");
        assert!(start_hidden(&StartCtx { mode: "none", toggle_live: true, ..ctx(&h) }) && start_hidden(&StartCtx { mode: "dock", toggle_live: true, ..ctx(&h) }));
        assert!(!start_hidden(&StartCtx { mode: "dock", ..ctx(&h) }), "taskbar-less and no hotkey");
        assert!(!start_hidden(&StartCtx { icon_applied: false, mac: true, ..ctx(&h) }), "the tray did not build");
    }
    #[test] fn a_hidden_start_never_hides_what_the_user_must_see() {
        let h = ["velo", "--hidden"];
        assert!(!start_hidden(&StartCtx { notes_ready: false, ..ctx(&h) }), "first run, missing folder, agent fence error");
        assert!(!start_hidden(&StartCtx { after_update: true, ..ctx(&h) }), "the relaunch after Install and restart");
    }
    #[test] fn first_show_plan_covers_every_platform_and_mode() {
        for mode in ["dock", "tray", "none"] {
            assert_eq!(first_show_plan(false, true, mode), FirstShow::Show);
            assert_eq!(first_show_plan(false, false, mode), FirstShow::Show);
            assert_eq!(first_show_plan(true, false, mode), FirstShow::Leave);
        }
        assert_eq!(first_show_plan(true, true, "dock"), FirstShow::ShowThenHideApp);
        assert_eq!(first_show_plan(true, true, "tray"), FirstShow::HideApp);
        assert_eq!(first_show_plan(true, true, "none"), FirstShow::HideApp);
    }
    #[test] fn the_login_item_second_launch_does_not_show_the_window() {
        assert!(second_launch_shows(["velo"]) && second_launch_shows(["velo", "--mcp"]));
        assert!(!second_launch_shows(["velo", "--hidden"]));
    }
    #[test] fn the_restart_mark_is_consumed_once_and_expires() {
        let d = tempfile::tempdir().unwrap();
        assert!(!take_restart_mark(d.path()));
        mark_restart(d.path());
        assert!(take_restart_mark(d.path()));
        assert!(!take_restart_mark(d.path()), "consumed");
        mark_restart(d.path());
        clear_restart_mark(d.path());
        assert!(!take_restart_mark(d.path()), "a failed install clears it");
        mark_restart(d.path());
        let old = std::time::SystemTime::now() - RESTART_MARK_TTL - std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(d.path().join(RESTART_MARK)).unwrap().set_modified(old).unwrap();
        assert!(!take_restart_mark(d.path()), "a stale mark must not show a login start");
        assert!(!d.path().join(RESTART_MARK).exists());
    }
    #[test] fn the_login_item_refuses_paths_it_cannot_hold() {
        let ok = "/Applications/velo.app/Contents/MacOS/velo";
        assert_eq!(login_item_refusal(ok, "macos", false), None);
        assert!(login_item_refusal("/private/var/folders/x/T/AppTranslocation/ABC/d/velo.app/Contents/MacOS/velo", "macos", false).unwrap().contains("Move velo to Applications"));
        for bad in ["/Apps & Tools/velo.app/Contents/MacOS/velo", "/a<b/velo", "/a>b/velo"] {
            assert!(login_item_refusal(bad, "macos", false).is_some(), "{bad}");
        }
        assert_eq!(login_item_refusal("/home/u/bin/velo-0.20_x86-64.AppImage", "linux", false), None);
        for bad in ["/home/u/My Apps/velo.AppImage", "/home/u/a\tb/velo", "/home/u/a\nb/velo", "/home/u/100%/velo", "/home/u/a\"b/velo", "/home/o'neal/velo.AppImage", "/home/u/a\\b/velo"] {
            assert!(login_item_refusal(bad, "linux", false).is_some(), "{bad:?}");
        }
        for c in [">", "<", "~", "|", "&", ";", "$", "*", "?", "#", "(", ")", "`"] {
            assert!(login_item_refusal(&format!("/home/u/a{c}b/velo"), "linux", false).is_some(), "{c}");
        }
        assert_eq!(login_item_refusal("C:\\Apps & Tools\\velo.exe", "windows", false), None, "the plugin writes the Run value unquoted and Windows still resolves it");
        assert!(login_item_refusal(ok, "macos", true).is_some(), "a development build");
    }
    #[test] fn the_startup_refresh_is_macos_only_never_turns_an_item_on_and_skips_a_current_path() {
        let exe = "/Applications/velo.app/Contents/MacOS/velo";
        assert!(should_refresh("macos", true, false, Some("/Users/u/Downloads/velo.app/Contents/MacOS/velo"), exe), "moved");
        assert!(should_refresh("macos", true, false, None, exe), "unreadable record");
        assert!(!should_refresh("macos", true, false, Some(exe), exe), "same path: write nothing");
        assert!(!should_refresh("macos", false, false, Some("/old"), exe), "off stays off");
        assert!(!should_refresh("macos", true, true, Some("/old"), exe), "refused path");
        assert!(!should_refresh("linux", true, false, Some("/old"), exe) && !should_refresh("windows", true, false, None, exe));
    }
    #[test] fn the_recorded_path_is_read_from_the_plist_the_crate_writes() {
        let plist = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>dev.velo.app</string>\n  <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  <key>ProgramArguments</key>\n  <array><string>/Applications/velo.app/Contents/MacOS/velo</string><string>--hidden</string></array>\n  <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>";
        assert_eq!(plist_program(plist), Some("/Applications/velo.app/Contents/MacOS/velo"));
        assert_eq!(plist_program("garbage"), None);
    }
    #[test] fn a_toggle_the_system_did_not_apply_is_an_error() {
        assert_eq!(kept_state_error("windows", true, true), None);
        assert_eq!(kept_state_error("macos", false, false), None);
        assert!(kept_state_error("windows", false, true).unwrap().contains("run velo as administrator"), "an all-users item");
        for (os, on) in [("windows", true), ("macos", false), ("macos", true), ("linux", false)] {
            assert_eq!(kept_state_error(os, on, !on), Some("The system kept the previous state."), "{os} {on}");
        }
    }
    #[test] fn the_login_item_path_is_the_appimage_on_linux_only() {
        let own = || "/tmp/.mount_velo/velo".to_string();
        assert_eq!(login_exe_for("linux", Some("/home/u/velo.AppImage".into()), own), "/home/u/velo.AppImage");
        assert_eq!(login_exe_for("linux", None, own), "/tmp/.mount_velo/velo");
        assert_eq!(login_exe_for("macos", Some("/x.AppImage".into()), own), "/tmp/.mount_velo/velo");
    }
    #[test] fn the_restart_mark_is_written_after_the_download_and_cleared_when_the_install_fails() {
        let d = tempfile::tempdir().unwrap();
        let mark = d.path().join(RESTART_MARK);
        let saved = AtomicBool::new(false);
        let ok: Result<(), ()> = tauri::async_runtime::block_on(with_restart_mark(
            d.path(),
            || {
                assert!(!mark.exists(), "the mark follows the window save");
                saved.store(true, Ordering::SeqCst);
            },
            |finish| async {
                assert!(!mark.exists(), "not before the download");
                finish();
                assert!(mark.exists(), "written when the download is done, before the install step");
                Ok(())
            },
        ));
        assert!(ok.is_ok() && saved.load(Ordering::SeqCst) && take_restart_mark(d.path()));
        let failed: Result<(), &str> = tauri::async_runtime::block_on(with_restart_mark(d.path(), || {}, |finish| async {
            finish();
            Err("signature")
        }));
        assert!(failed.is_err() && !mark.exists(), "a failed verify/install clears it");
        let failed: Result<(), &str> = tauri::async_runtime::block_on(with_restart_mark(d.path(), || {}, |_| async { Err("download") }));
        assert!(failed.is_err() && !mark.exists());
    }
    #[test] fn one_gui_velo_per_data_dir() {
        assert_eq!(instance_plan(true, true), Instance::Run);
        assert_eq!(instance_plan(true, false), Instance::Run);
        assert_eq!(instance_plan(false, true), Instance::Exit, "the login item while velo runs");
        assert_eq!(instance_plan(false, false), Instance::ShowOtherThenExit, "a user launch shows the running velo");
        let d = tempfile::tempdir().unwrap();
        assert!(hold_instance_lock(d.path(), std::time::Duration::ZERO));
        let t = std::time::Instant::now();
        assert!(!hold_instance_lock(d.path(), std::time::Duration::from_millis(300)), "a second handle cannot take it");
        assert!(t.elapsed() >= std::time::Duration::from_millis(300), "retried for the wait");
    }
    #[test] fn the_instance_lock_is_released_when_its_holder_ends() {
        // the lock lives on an open file: closing it (as process exit does) frees it, so no stale lock is left
        let d = tempfile::tempdir().unwrap();
        let other = std::fs::File::options().create(true).truncate(false).write(true).open(d.path().join("instance.lock")).unwrap();
        other.try_lock().unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            drop(other);
        });
        assert!(hold_instance_lock(d.path(), std::time::Duration::from_secs(5)), "an update relaunch waits for the old process");
        release.join().unwrap();
    }
    #[test] fn the_login_item_name_is_the_bundle_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], AUTOSTART_NAME);
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
