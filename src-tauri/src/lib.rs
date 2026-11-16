pub mod agent;
pub mod archive;
pub mod commands;
pub mod connections;
pub mod crypto;
pub mod export;
pub mod frontmatter;
pub mod index;
pub mod log;
pub mod names;
pub mod revisions;
pub mod settings;
pub mod store;
pub mod tasks;
pub mod text;
pub mod update;
pub mod vault;
pub mod watch;
pub mod whatsnew;

use std::sync::Mutex;
use tauri::Manager;

/// macOS: the default Quit item sends `terminate:`, which skips the window's close-requested flow
/// (and so the unsaved-edits check). Our Quit just closes the main window instead; the app exits
/// when its last window is destroyed. The Edit menu is required for Cmd+C/V/X/Z in the webview.
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuItem, PredefinedMenuItem as P, Submenu};
    let quit = MenuItem::with_id(app, "quit", "Quit velo", true, Some("CmdOrCtrl+Q"))?;
    let check = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset-window", "Reset Window Position and Size", true, None::<&str>)?;
    tauri::menu::Menu::with_items(app, &[
        &Submenu::with_items(app, "velo", true, &[
            &crate::commands::about_item(app)?, &check, &reset, &P::separator(app)?, &P::hide(app, None)?, &P::hide_others(app, None)?,
            &P::show_all(app, None)?, &P::separator(app)?, &quit,
        ])?,
        &Submenu::with_items(app, "Edit", true, &[
            &P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?,
            &P::paste(app, None)?, &P::select_all(app, None)?,
        ])?,
        &Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::close_window(app, None)?])?,
    ])
}

/// Custom commands are open to every window (no app ACL manifest in build.rs, so capabilities do not restrict them):
/// this guard is the boundary. A window other than main reaches only the commands `whatsnew::allowed` names.
fn with_window_guard<R: tauri::Runtime>(handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !whatsnew::allowed(invoke.message.webview_ref().label(), invoke.message.command()) {
            invoke.resolver.reject("not allowed from this window");
            return true;
        }
        handler(invoke)
    }
}

/// The app's commands: `APP_COMMANDS` lists their names (for the guard's tests), `app_handler` registers them behind
/// `with_window_guard`.
macro_rules! app_commands {
    ($($m:ident :: $c:ident),* $(,)?) => {
        #[cfg(test)]
        const APP_COMMANDS: &[&str] = &[$(stringify!($c)),*];
        fn app_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
            with_window_guard(tauri::generate_handler![$($m::$c),*])
        }
    };
}

app_commands![
            commands::get_settings,
            commands::set_settings,
            commands::index_status,
            commands::search,
            commands::timeline,
            commands::export_preview,
            commands::export_text,
            commands::export_markdown,
            commands::print_page,
            commands::list_tags,
            commands::list_titles,
            commands::list_link_targets,
            commands::create_from_selection,
            commands::open_note,
            commands::open_or_create,
            commands::save_note,
            commands::link_mention,
            commands::tasks,
            commands::toggle_task,
            commands::capture_task,
            commands::capture_target_title,
            commands::capture_done,
            commands::set_badge,
            commands::rename_note,
            commands::backlink_count,
            commands::connections,
            commands::lock_note,
            commands::unlock_note,
            commands::lock_all,
            commands::delete_note,
            commands::set_archived,
            commands::merge_notes,
            commands::snapshot_agent,
            commands::drop_agent_snapshot,
            commands::agent_write_claim,
            commands::agent_write_done,
            commands::list_revisions,
            commands::read_revision,
            commands::snapshot_text,
            commands::has_identity,
            commands::agent_setup_command,
            commands::setup_passphrase,
            commands::identity_file_exists,
            commands::close_requested,
            commands::quit_app,
            commands::reset_window_cmd,
            commands::log_line,
            commands::get_autostart,
            commands::set_autostart,
            update::check_update,
            update::install_update,
            whatsnew::open_whatsnew,
            whatsnew::whatsnew_info,
            whatsnew::whatsnew_install,
            whatsnew::whatsnew_failed,
            whatsnew::whatsnew_close,
];

pub fn run() {
    let builder = tauri::Builder::default();
    // first plugin, as its docs ask: launching velo again (common once the close button only hides it) shows the
    // running window instead of starting a second process on the same notes. Not on macOS: the plugin's socket in shared
    // /tmp could be squatted to block launch. There LaunchServices keeps one instance of a Finder/Dock launch and
    // RunEvent::Reopen shows it, but the login item execs the binary outside LaunchServices: `hold_instance_lock` in
    // setup keeps that copy from becoming a second process on the same notes.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
        // the login item firing while velo already runs (it was started by hand first) must not pop the window up
        if commands::second_launch_shows(&args) {
            commands::show_main(app);
        }
    }));
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // the OS keeps the login item (the builder's default on macOS is a LaunchAgent; Windows Run key; Linux .desktop); only it passes --hidden
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(commands::AUTOSTART_NAME)
                .arg(commands::HIDDEN_ARG)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(commands::WINDOW_STATE).with_denylist(&[whatsnew::LABEL]).build())
        .setup(|app| {
            // First thing in setup: the log dir needs the app handle. A panic before this point keeps only the default hook.
            if let Ok(dir) = app.path().app_log_dir() {
                let version = app.package_info().version.to_string();
                log::init(&dir, version.clone());
                log::line(&format!("velo {version} started on {} {}", std::env::consts::OS, std::env::consts::ARCH));
            }
            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(app.handle())?)?;
                app.on_menu_event(|app, ev| {
                    if ev.id() == "quit" {
                        commands::quit(app);
                    }
                    if ev.id() == "reset-window" {
                        commands::reset_window(app);
                    }
                    if ev.id() == "check-updates" {
                        use tauri::Emitter;
                        app.emit("check-updates", ()).ok(); // the UI runs the check and shows the result
                    }
                });
            }
            let h = app.handle().clone();
            let config_dir = h.path().app_config_dir()?;
            let data_dir = h.path().app_data_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;
            // before anything opens the notes, the index or the agent marker: one GUI velo per data dir. The wait covers
            // the update relaunch (`open -n` returns before the old process exits); a start that loses waits it out once.
            #[cfg(target_os = "macos")]
            match commands::instance_plan(commands::hold_instance_lock(&data_dir, std::time::Duration::from_secs(5)),commands::has_hidden_arg(std::env::args())) {
                commands::Instance::Run => {}
                plan => {
                    log::line(&format!("another velo runs on this data dir; this start exits ({plan:?})"));
                    if plan == commands::Instance::ShowOtherThenExit {
                        commands::show_other_after_exit();
                    }
                    std::process::exit(0);
                }
            }
            let settings_path = config_dir.join("settings.json");
            let settings = settings::load(&settings_path);
            log::set_debug(settings.debug_log);
            let (dir, globals, icon) = (settings.notes_dir.clone(), settings.global_bindings(), settings.app_icon.clone());
            app.manage(commands::AppState {
                settings: Mutex::new(settings),
                vault: Mutex::new(None),
                watcher: Mutex::new(None),
                identity: Mutex::new(crypto::keychain_get()),
                // gated from the start so an early UI query sees "indexing", not "no-folder"
                indexing: Mutex::new(dir.is_some().then_some((0, 0))),
                open_gen: Default::default(),
                locked: Default::default(),
                capture_was_hidden: Default::default(),
                quitting: Default::default(),
                icon_mode: Mutex::new("dock".into()), // apply_app_icon sets it at the end of setup
                settings_path,
                data_dir,
            });
            app.manage(agent::listener::AgentState::default());
            // before the vault opens: with access on, velo writes notes only once headless can tell it runs, or access
            // is off (never two writers). Failing both, the notes stay closed and a dialog says why, then velo quits.
            let fenced = {
                let st = app.state::<commands::AppState>();
                let mut s = st.settings.lock().unwrap();
                if s.agent_access {
                    agent::listener::start_or_fence(&st.data_dir, &st.settings_path, &mut s, || agent::listener::start(h.clone())).map(|l| *app.state::<agent::listener::AgentState>().listener.lock().unwrap() = l)
                } else {
                    Ok(())
                }
            };
            let dir = match fenced {
                Ok(()) => dir,
                Err(e) => {
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    eprintln!("velo: {e}");
                    let h2 = h.clone();
                    h.dialog()
                        .message(format!("{e}\n\nAgent access is on, so velo won't open your notes: an agent could write them at the same time. Make that folder writable, then start velo again."))
                        .kind(MessageDialogKind::Error)
                        .title("velo can't open your notes")
                        .show(move |_| h2.exit(1));
                    None
                }
            };
            let notes_ready = dir.as_ref().is_some_and(|d| d.is_dir());
            if let Some(dir) = dir {
                // detached on purpose: quitting must not wait for indexing
                let h = h.clone();
                std::thread::spawn(move || {
                    if let Err(e) = commands::open_vault(&h, &h.state(), &dir) {
                        eprintln!("velo: cannot open notes folder: {e}");
                    }
                });
            }
            for (action, binding) in globals {
                if let Err(e) = commands::register_global(&h, action, &binding) {
                    eprintln!("velo: {action:?} hotkey not registered: {e}");
                }
            }
            // "none" leans on the Show/hide hotkey alone: if it did not register (taken by another app), fall back for
            // this session. Linux falls back to the taskbar: a tray needs libappindicator and a desktop that shows it.
            let live = commands::hotkey_only_ok(&app.state::<commands::AppState>().settings.lock().unwrap(), |k| commands::hotkey_live(&h, k));
            let icon = match icon.as_str() {
                "none" if !live && cfg!(target_os = "linux") => "dock",
                "none" if !live => "tray",
                m => m,
            };
            let icon_applied = commands::apply_app_icon(&h, icon).map_err(|e| eprintln!("velo: app icon mode not applied: {e}")).is_ok();
            let toggle_live = commands::toggle_hotkey_live(&app.state::<commands::AppState>().settings.lock().unwrap(), |k| commands::hotkey_live(&h, k));
            let args: Vec<String> = std::env::args().collect();
            let hidden = commands::start_hidden(&commands::StartCtx {
                args: &args,
                after_update: commands::take_restart_mark(&app.state::<commands::AppState>().data_dir),
                notes_ready,
                mac: cfg!(target_os = "macos"),
                icon_applied,
                mode: icon,
                toggle_live,
            });
            commands::first_show(&h, commands::first_show_plan(hidden, cfg!(target_os = "macos"), icon));
            commands::refresh_login_item(&h);
            app.manage(Mutex::new(update::UpdateState::default()));
            update::spawn_checker(h.clone());
            Ok(())
        })
        .invoke_handler(app_handler())
        .build(tauri::generate_context!())
        .expect("error while running velo")
        .run(|app, ev| {
            // macOS: opening velo again (Finder, Spotlight, Dock) brings back a window the close button hid
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = ev {
                commands::show_main(app);
            }
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &ev
                && label == "main"
            {
                whatsnew::close(app); // quitting: the What's new window must not keep velo running
            }
            if let tauri::RunEvent::Exit = ev {
                // the process exits without dropping state: drop the vault so an interrupted bulk re-index ends here
                drop(app.state::<commands::AppState>().vault.lock().map(|mut v| v.take()));
            }
            if let tauri::RunEvent::Exit = ev
                && let Some(agent) = app.try_state::<agent::listener::AgentState>()
            {
                match agent.listener.lock().unwrap().take() {
                    Some(l) => l.stop(), // deletes agent.json: the headless server goes direct again
                    None => agent::listener::unmark_running(&app.state::<commands::AppState>().data_dir), // a failed start's marker
                }
            }
        });
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn every_registered_command_but_the_allow_list_is_denied_to_other_windows() {
        for c in whatsnew::COMMANDS {
            assert!(APP_COMMANDS.contains(c), "{c} is not registered");
        }
        let denied: Vec<_> = APP_COMMANDS.iter().filter(|c| !whatsnew::allowed(whatsnew::LABEL, c)).collect();
        assert_eq!(denied.len(), APP_COMMANDS.len() - whatsnew::COMMANDS.len());
        assert!(APP_COMMANDS.iter().all(|c| whatsnew::allowed("main", c)));
        for c in ["save_note", "open_note", "get_settings", "whatsnew_failed", "open_whatsnew", "install_update", "get_autostart", "set_autostart"] {
            assert!(denied.contains(&&c), "{c}");
        }
    }
}

/// The wrapper's wiring through real IPC on the mock runtime. Not on Windows: a test binary that builds a Tauri app links
/// Tauri's window and menu code, which imports `TaskDialogIndirect` from Common Controls v6; tauri-build embeds the
/// manifest that selects v6 only into binaries (embed-resource `rustc-link-arg-bins`), so the test binary cannot start
/// (STATUS_ENTRYPOINT_NOT_FOUND). macOS and Linux CI run it; the guard's rule itself is tested on every OS.
#[cfg(all(test, not(windows)))]
mod guard_ipc_tests {
    use super::*;
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets};

    #[tauri::command]
    fn open_note() -> &'static str {
        "note"
    }
    #[tauri::command]
    fn whatsnew_info() -> &'static str {
        "info"
    }

    fn call(w: &tauri::WebviewWindow<MockRuntime>, cmd: &str) -> Result<String, serde_json::Value> {
        let req = tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
            body: Default::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(w, req).map(|r| r.deserialize::<String>().unwrap())
    }

    #[test]
    fn the_wrapper_refuses_other_commands_from_other_windows() {
        let app = mock_builder().invoke_handler(with_window_guard(tauri::generate_handler![open_note, whatsnew_info])).build(mock_context(noop_assets())).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let other = tauri::WebviewWindowBuilder::new(&app, whatsnew::LABEL, Default::default()).build().unwrap();
        assert_eq!(call(&main, "open_note").unwrap(), "note");
        assert_eq!(call(&main, "whatsnew_info").unwrap(), "info");
        assert_eq!(call(&other, "whatsnew_info").unwrap(), "info");
        assert_eq!(call(&other, "open_note").unwrap_err(), serde_json::json!("not allowed from this window"));
    }
}
