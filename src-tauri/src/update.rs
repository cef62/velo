//! In-app updates: daily check against the GitHub Release feed, install on request. Delivery goes
//! through tauri-plugin-updater; the UI shows a banner (event `update-available`, or the manual
//! check's reply) and calls `install_update` once unsaved edits are saved.

use crate::commands::AppState;
use crate::log;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Payload of `update-progress`; `total` is the Content-Length, when the server sent one.
#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Which `n`th of the download `done` is in (`n` = 100: percent), or 256 KiB steps when the size is
/// unknown. Progress is reported when the bucket changes, not on every chunk.
fn bucket(done: u64, total: Option<u64>, n: u64) -> u64 {
    match total {
        Some(t) if t > 0 => done.min(t) * n / t,
        _ => done >> 18,
    }
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
                    eprintln!("velo: update check failed: {e}"); // check() already wrote it to velo.log
                }
            }
            // Wall-clock deadline, re-read after short naps: `Instant` and thread sleeps stop while
            // the machine sleeps (macOS, Linux), so a laptop would otherwise check every ~week.
            // The awake-time bound ends the wait if the clock was set back after a check.
            let (due, started) = (SystemTime::now() + CHECK_INTERVAL, std::time::Instant::now());
            while SystemTime::now() < due && started.elapsed() < CHECK_INTERVAL {
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
    log::line(&format!("update check start ({})", if manual { "manual" } else { "background" }));
    // The lock is released here; the network call runs without it.
    let result = async { app.updater_builder().configure_client(|c| c.read_timeout(READ_TIMEOUT)).build()?.check().await }.await;
    let mut st = state(app);
    st.busy = false;
    let update = result.map_err(|e| {
        log::line(&format!("update check error: {e}"));
        e.to_string()
    })?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone() });
    log::line(&match &info {
        Some(i) => format!("update check result: {} available", i.version),
        None => "update check result: up to date".into(),
    });
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
    log::line(&format!("update download start: {} -> {}", update.current_version, update.version));
    let (mut done, mut shown, mut logged) = (0u64, None, 0u64);
    let downloaded = AtomicBool::new(false);
    let on_chunk = |len: usize, total: Option<u64>| {
        done += len as u64;
        let b = bucket(done, total, 100);
        if shown != Some(b) {
            shown = Some(b);
            app.emit("update-progress", Progress { downloaded: done, total }).ok();
        }
        if total.is_some() && bucket(done, total, 4) > logged {
            logged = bucket(done, total, 4);
            log::line(&format!("update download {}% ({done} bytes)", logged * 25));
        }
    };
    let on_finish = || {
        downloaded.store(true, Ordering::Relaxed);
        log::line("update download done; verifying and installing");
        app.emit("update-installing", ()).ok();
    };
    let result = update.download_and_install(on_chunk, on_finish).await;
    let mut st = state(app);
    st.busy = false;
    if let Err(e) = result {
        let phase = if downloaded.load(Ordering::Relaxed) { "verify/install" } else { "download" }; // the plugin checks the signature after on_finish
        log::line(&format!("update {phase} error: {e}"));
        eprintln!("velo: update {phase} failed: {e}");
        // The next check finds the version again and announces it again.
        st.available = None;
        st.notified = None;
        return Err(e.to_string());
    }
    drop(st);
    log::line("update install done; restart");
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

    #[test]
    fn progress_buckets() {
        assert_eq!(bucket(0, Some(1000), 100), 0);
        assert_eq!(bucket(499, Some(1000), 4), 1);
        assert_eq!(bucket(1000, Some(1000), 4), 4);
        assert_eq!(bucket(2000, Some(1000), 100), 100); // a server that lied about the size
        assert_eq!(bucket(300 * 1024, None, 100), 1); // unknown size: 256 KiB steps
        assert_eq!(bucket(10, Some(0), 100), 0);
    }
}
