//! The What's new window: a second, small window that shows what the stored update brings (its release notes) before
//! the user installs it. Opened on request from the update pill; one at a time; it never keeps velo running.
//!
//! Custom commands have no ACL in this app (build.rs defines no app manifest, so Tauri lets every window call every
//! `invoke_handler` command). This window renders text from the update feed, so `allowed` limits it to its own
//! commands; its plugin permissions are in capabilities/whatsnew.json.

use crate::commands::AppState;
use crate::update::{self, UpdateInfo};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "whatsnew";
const MAIN: &str = "main";
/// What the What's new window may invoke: nothing that reads or writes notes or settings.
pub const COMMANDS: &[&str] = &["whatsnew_info", "whatsnew_install", "log_line"];
const SIZE: (f64, f64) = (560.0, 680.0);
const MIN: (f64, f64) = (440.0, 420.0);
const MAX: (f64, f64) = (820.0, 1000.0);

/// Whether the window `label` may call the custom command `command`.
pub fn allowed(label: &str, command: &str) -> bool {
    label == MAIN || COMMANDS.contains(&command)
}

/// The stored update and the main window's look (theme, palette, font size), so the window matches it.
#[derive(Serialize)]
pub struct WhatsNew {
    update: Option<UpdateInfo>,
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
    let b = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("whatsnew.html".into()))
        .title("What's new")
        .min_inner_size(MIN.0, MIN.1)
        .max_inner_size(MAX.0, MAX.1)
        .theme(theme);
    // centred on the main window's monitor (where the pill was clicked), shrunk to fit a small screen
    let monitor = app.get_webview_window(MAIN).and_then(|w| w.current_monitor().ok().flatten());
    let b = match monitor {
        Some(m) => {
            let s = m.scale_factor();
            let (x, y, w, h) = crate::commands::reset_placement(m.work_area(), s, SIZE, MIN, (0, 0), s);
            b.inner_size(w, h).position(x, y)
        }
        None => b.inner_size(SIZE.0, SIZE.1).center(),
    };
    // the main window's title bar: content under a transparent bar, traffic lights inset
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
    b.build().map(|_| ()).map_err(|e| e.to_string())
}

/// Asked by the window once it listens for progress, so no update data is lost to an event sent before that.
#[tauri::command]
pub fn whatsnew_info(app: AppHandle) -> WhatsNew {
    let update = update::state(&app).available.as_ref().map(UpdateInfo::from);
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    WhatsNew { update, theme: s.theme, palette: s.palette, font_size: s.font_size }
}

/// "Install and restart": the main window runs the install, because it must save and freeze the editor first. It
/// answers with `whatsnew-install-failed` if the install does not start or fails; progress events reach both windows.
#[tauri::command]
pub fn whatsnew_install(app: AppHandle) -> Result<(), String> {
    let version = update::state(&app).available.as_ref().map(|u| u.version.clone()).ok_or("No update to install")?;
    app.emit_to(MAIN, "whatsnew-install", version).map_err(|e| e.to_string())
}

/// The main window is gone (velo is quitting): close this one too, so it never keeps the app alive.
pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.destroy().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whatsnew_reaches_only_its_own_commands() {
        assert!(allowed("main", "save_note"));
        assert!(allowed("main", "whatsnew_info"));
        for cmd in ["whatsnew_info", "whatsnew_install", "log_line"] {
            assert!(allowed(LABEL, cmd));
        }
        for cmd in ["open_note", "save_note", "search", "get_settings", "set_settings", "delete_note", "install_update", "check_update", "open_whatsnew", "unlock_note", "export_text"] {
            assert!(!allowed(LABEL, cmd), "{cmd}");
        }
        assert!(!allowed("other", "open_note")); // any window but main
    }
}
