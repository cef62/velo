//! The What's new window: a second, small window that shows what the stored update brings (its release notes) before
//! the user installs it. Opened on request from the update pill; one at a time; it never keeps velo running.
//!
//! Boundary. Capabilities do not restrict velo's own commands (build.rs defines no app ACL manifest, so Tauri lets
//! every window call every `invoke_handler` command): `allowed` does, in Rust, for every window but main. The window
//! holds no event permission (capabilities/whatsnew.json), so it can neither listen to velo's events (some carry note
//! text) nor emit any: install progress reaches it over a `Channel` given to `whatsnew_info`, scoped to its webview.

use crate::commands::AppState;
use crate::update::{self, Phase, UpdateInfo};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "whatsnew";
const MAIN: &str = "main";
/// What a window other than main may invoke: nothing that reads or writes notes or settings.
pub const COMMANDS: &[&str] = &["whatsnew_info", "whatsnew_install", "whatsnew_close", "log_line"];
const SIZE: (f64, f64) = (560.0, 680.0);
const MIN: (f64, f64) = (440.0, 420.0);
const MAX: (f64, f64) = (820.0, 1000.0);

/// Whether the window `label` may call the custom command `command`: deny unless main or in `COMMANDS`.
pub fn allowed(label: &str, command: &str) -> bool {
    label == MAIN || COMMANDS.contains(&command)
}

/// The bundled page (tauri://localhost on macOS/Linux, http(s)://tauri.localhost on Windows) or, in `tauri dev`, the
/// dev server. Anything else (a link opened from the context menu, a dropped URL) must not load in this window.
/// Scheme, host and port must match exactly (WebView2 resolves any *.localhost port to loopback), with no userinfo.
fn own_page(u: &Url, dev: Option<&Url>) -> bool {
    let at = |scheme: &str, host: &str| u.scheme() == scheme && u.host_str() == Some(host) && u.port().is_none();
    let plain = u.username().is_empty() && u.password().is_none();
    plain && (at("tauri", "localhost") || at("http", "tauri.localhost") || at("https", "tauri.localhost") || dev.is_some_and(|d| d.origin() == u.origin()))
}

/// The stored update, where its install stands, and the main window's look (theme, palette, font size).
#[derive(Serialize)]
pub struct WhatsNew {
    update: Option<UpdateInfo>,
    phase: Phase,
    theme: String,
    palette: String,
    font_size: u32,
}

/// Opens the window, or brings it to the front if it is open. Async: building a window from a synchronous command
/// deadlocks on Windows.
#[tauri::command]
pub async fn open_whatsnew(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.unminimize().ok();
        w.show().ok();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let theme = match app.state::<AppState>().settings.lock().unwrap().theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    let dev = cfg!(debug_assertions).then(|| app.config().build.dev_url.clone()).flatten();
    let b = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("whatsnew.html".into()))
        .title("What's new")
        .inner_size(SIZE.0, SIZE.1)
        .min_inner_size(MIN.0, MIN.1)
        .max_inner_size(MAX.0, MAX.1)
        .theme(theme)
        .visible(false) // shown once placed
        .on_navigation(move |u| own_page(u, dev.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny);
    // the main window's title bar: content under a transparent bar, traffic lights inset
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
    let w = b.build().map_err(|e| e.to_string())?;
    place(&app, &w);
    w.show().ok();
    w.set_focus().map_err(|e| e.to_string())
}

/// Centred on the main window's monitor (where the pill was clicked), shrunk until the whole frame fits its work area.
/// Measured on the built window: the title bar and borders (Windows, Linux) are only known then.
fn place(app: &AppHandle, w: &tauri::WebviewWindow) {
    let monitor = app.get_webview_window(MAIN).and_then(|m| m.current_monitor().ok().flatten()).or_else(|| w.current_monitor().ok().flatten());
    let Some(m) = monitor else {
        w.center().ok();
        return;
    };
    let (outer, inner) = (w.outer_size().unwrap_or_default(), w.inner_size().unwrap_or_default());
    let frame = (outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
    let s = m.scale_factor();
    let (x, y, width, height) = crate::commands::reset_placement(m.work_area(), s, SIZE, MIN, frame, w.scale_factor().unwrap_or(s));
    w.set_size(tauri::LogicalSize::new(width, height)).ok();
    w.set_position(tauri::LogicalPosition::new(x, y)).ok();
}

/// The window's data, asked on mount. `on_phase` receives every later change of the install (from the pill or from
/// this window); the reply carries the current one, so nothing sent before the window loaded is missed.
#[tauri::command]
pub fn whatsnew_info(app: AppHandle, on_phase: Channel<Phase>) -> WhatsNew {
    let (update, phase) = {
        let mut st = update::state(&app);
        st.watcher = Some(on_phase);
        (st.available.as_ref().map(UpdateInfo::from), st.phase.clone())
    };
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    WhatsNew { update, phase, theme: s.theme, palette: s.palette, font_size: s.font_size }
}

/// "Install and restart" for `version`, the one the window shows. The main window runs the install, because it must
/// save and freeze the editor first: Rust signals main's listener; this window cannot emit events itself.
#[tauri::command]
pub fn whatsnew_install(app: AppHandle, version: String) -> Result<(), String> {
    {
        let mut st = update::state(&app);
        let available = st.available.as_ref().map(|u| u.version.clone()).ok_or(update::NO_UPDATE)?;
        if available != version {
            return Err(update::NEWER.into());
        }
        update::set_phase(&mut st, Phase::Starting);
    }
    app.emit_to(MAIN, "whatsnew-install", version).map_err(|e| e.to_string())
}

/// Main only (not in `COMMANDS`): the install asked by the window did not start, and why.
#[tauri::command]
pub fn whatsnew_failed(app: AppHandle, message: String) {
    let mut st = update::state(&app);
    let retry = st.available.is_some();
    update::set_phase(&mut st, Phase::Failed { message, retry });
}

/// Closes this window only (the plugin's close command takes any window label).
#[tauri::command]
pub fn whatsnew_close(app: AppHandle) {
    close(&app);
}

/// Closes the window if it is open; also when the main window is gone (velo is quitting), so it never keeps velo alive.
pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.destroy().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_list_is_exact() {
        assert_eq!(COMMANDS, ["whatsnew_info", "whatsnew_install", "whatsnew_close", "log_line"]);
        assert!(allowed(MAIN, "save_note") && allowed(MAIN, "anything"));
        assert!(!allowed("other", "open_note") && !allowed("", "open_note")); // any window but main, unknown labels too
    }

    /// No event permission (listen would hear note events; emit could drive main), nothing implicit from a default set.
    #[test]
    fn capabilities_grant_the_window_only_drag_and_open_url() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        files.sort();
        assert_eq!(files, ["default.json", "whatsnew.json"]); // a new capability file must be reviewed here
        let read = |f: &str| serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(dir.join(f)).unwrap()).unwrap();
        let mut cap = read("whatsnew.json");
        cap.as_object_mut().unwrap().remove("description");
        assert_eq!(
            cap,
            serde_json::json!({
                "$schema": "../gen/schemas/desktop-schema.json",
                "identifier": "whatsnew",
                "windows": [LABEL],
                "permissions": ["core:window:allow-start-dragging", { "identifier": "opener:allow-open-url", "allow": [{ "url": "https://*" }, { "url": "http://*" }] }]
            })
        );
        assert_eq!(read("default.json")["windows"], serde_json::json!([MAIN]));
    }

    #[test]
    fn only_the_bundled_page_loads() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(own_page(&u("tauri://localhost/whatsnew.html"), None));
        assert!(own_page(&u("http://tauri.localhost/whatsnew.html"), None));
        assert!(own_page(&u("https://tauri.localhost/whatsnew.html"), None));
        let dev = u("http://localhost:1420");
        assert!(own_page(&u("http://localhost:1420/whatsnew.html"), Some(&dev)));
        assert!(own_page(&u("HTTP://TAURI.LOCALHOST/whatsnew.html"), None)); // special schemes lowercase the host: same origin
        for bad in [
            "https://github.com/cef62/velo",
            "http://localhost:1421/",
            "tauri://evil/",
            "file:///etc/passwd",
            "https://tauri.localhost.evil.com/",
            "javascript:alert(1)",
            "http://tauri.localhost:1234/",
            "https://tauri.localhost:8443/",
            "tauri://localhost:9/",
            "tauri://localhost.evil/",
            "tauri://LOCALHOST/", // not lowercased for a custom scheme: not the app's origin
            "http://tauri.localhost@evil.com/",
            "http://user:pw@tauri.localhost/",
            "http://localhost:1420@evil.com/",
        ] {
            assert!(!own_page(&u(bad), Some(&dev)), "{bad}");
        }
        assert!(!own_page(&u("http://localhost:1420/"), None)); // release: no dev server
    }
}
