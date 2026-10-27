//! In-app updates: daily check against the GitHub Release feed, install on request. Delivery goes
//! through tauri-plugin-updater; the UI shows a banner (event `update-available`, or the manual
//! check's reply) and calls `install_update` once unsaved edits are saved.

use crate::commands::AppState;
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Let startup indexing settle before touching GitHub.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 3600);
/// How often the checker thread re-reads the clock while waiting for the next check.
const WAKE_POLL: Duration = Duration::from_secs(600);
const _: () = assert!(FIRST_CHECK_DELAY.as_secs() < CHECK_INTERVAL.as_secs());

/// Idle time between bytes before a check or download is abandoned. Without it a half-open
/// socket leaves `busy` set until the app restarts.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

pub const DEBUG_BUILD: &str = "Updates are disabled in debug builds";
pub const BUSY: &str = "An update check or install is already running";

/// What the last check found. The plugin's `Update` handle is kept so "Install" needs no
/// second round-trip to the feed.
#[derive(Default)]
pub struct UpdateState {
    pub available: Option<Update>,
    /// Version already announced to the UI by the background check; announce each version once.
    pub notified: Option<String>,
    /// A check or an install is running; a second request is refused.
    pub busy: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
}

pub fn should_notify(version: &str, notified: Option<&str>) -> bool {
    notified != Some(version)
}

fn state(app: &AppHandle) -> MutexGuard<'_, UpdateState> {
    app.state::<Mutex<UpdateState>>().inner().lock().unwrap_or_else(|p| p.into_inner())
}

fn auto_check_enabled(app: &AppHandle) -> bool {
    app.state::<AppState>().settings.lock().unwrap_or_else(|p| p.into_inner()).auto_update_check
}

/// Claims the busy flag; `false` means another check/install is already running.
fn begin(app: &AppHandle) -> bool {
    let mut st = state(app);
    !std::mem::replace(&mut st.busy, true)
}

/// First check after `FIRST_CHECK_DELAY`, then every `CHECK_INTERVAL`. Release builds only, so
/// `tauri dev` never hits the feed or replaces its own `target/debug` binary.
pub fn spawn_checker(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            // The loop keeps running while auto-check is off so re-enabling needs no restart.
            if auto_check_enabled(&app) {
                // A background failure is never shown (offline, GitHub down): one log line.
                if let Err(e) = tauri::async_runtime::block_on(check(&app, false)) {
                    eprintln!("velo: update check failed: {e}");
                }
            }
            // Wall-clock deadline, re-read after short naps: `Instant` and thread sleeps stop while
            // the machine sleeps (macOS, Linux), so a laptop would otherwise check every ~week.
            let due = SystemTime::now() + CHECK_INTERVAL;
            while SystemTime::now() < due {
                std::thread::sleep(WAKE_POLL);
            }
        }
    });
}

/// `manual`: the user asked, so the reply is always shown; the background check emits
/// `update-available` once per version instead. `None` = up to date.
pub async fn check(app: &AppHandle, manual: bool) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) {
        return Err(DEBUG_BUILD.into());
    }
    if !begin(app) {
        return Err(BUSY.into());
    }
    // The lock is released here; the network call runs without it.
    let result = async { app.updater_builder().configure_client(|c| c.read_timeout(READ_TIMEOUT)).build()?.check().await }.await;
    let mut st = state(app);
    st.busy = false;
    let update = result.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone() });
    st.available = update;
    if let Some(i) = &info {
        // A manual check showed the banner itself; the background check must not re-show a dismissed one.
        let announce = !manual && should_notify(&i.version, st.notified.as_deref());
        st.notified = Some(i.version.clone());
        drop(st);
        if announce {
            app.emit("update-available", i).ok();
        }
    }
    Ok(info)
}

/// Downloads and installs the stored update, then relaunches. The UI has saved and suspended the
/// editor first: the relaunch skips the window's close flow. On Windows the NSIS installer ends
/// the process itself.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = {
        let mut st = state(app);
        if st.busy {
            return Err(BUSY.into());
        }
        let update = st.available.clone().ok_or("No update to install")?;
        st.busy = true;
        update
    };
    let result = update.download_and_install(|_, _| {}, || {}).await;
    let mut st = state(app);
    st.busy = false;
    if let Err(e) = result {
        // The next check finds the version again and announces it again.
        st.available = None;
        st.notified = None;
        return Err(e.to_string());
    }
    drop(st);
    app.restart();
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    check(&app, true).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifies_each_version_once() {
        assert!(should_notify("0.6.0", None));
        assert!(!should_notify("0.6.0", Some("0.6.0")));
        assert!(should_notify("0.6.1", Some("0.6.0")));
    }
}
