pub mod agent;
pub mod commands;
pub mod crypto;
pub mod frontmatter;
pub mod index;
pub mod names;
pub mod revisions;
pub mod settings;
pub mod store;
pub mod tasks;
pub mod text;
pub mod update;
pub mod vault;
pub mod watch;

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
    tauri::menu::Menu::with_items(app, &[
        &Submenu::with_items(app, "velo", true, &[
            &P::about(app, None, None)?, &check, &P::separator(app)?, &P::hide(app, None)?, &P::hide_others(app, None)?,
            &P::show_all(app, None)?, &P::separator(app)?, &quit,
        ])?,
        &Submenu::with_items(app, "Edit", true, &[
            &P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?,
            &P::paste(app, None)?, &P::select_all(app, None)?,
        ])?,
        &Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::close_window(app, None)?])?,
    ])
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(app.handle())?)?;
                app.on_menu_event(|app, ev| {
                    if ev.id() == "quit"
                        && let Some(w) = app.get_webview_window("main")
                    {
                        w.close().ok();
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
            let settings_path = config_dir.join("settings.json");
            let settings = settings::load(&settings_path);
            let (dir, globals) = (settings.notes_dir.clone(), settings.global_bindings());
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
                settings_path,
                data_dir,
            });
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
            app.manage(agent::listener::AgentState::default());
            if app.state::<commands::AppState>().settings.lock().unwrap().agent_access {
                let started = agent::listener::start(h.clone()).map(|l| *app.state::<agent::listener::AgentState>().listener.lock().unwrap() = Some(l));
                if let Err(e) = started {
                    eprintln!("velo: agent access listener not started: {e}");
                }
            }
            app.manage(Mutex::new(update::UpdateState::default()));
            update::spawn_checker(h.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_settings,
            commands::index_status,
            commands::search,
            commands::list_tags,
            commands::list_titles,
            commands::open_note,
            commands::open_or_create,
            commands::save_note,
            commands::tasks,
            commands::toggle_task,
            commands::capture_task,
            commands::capture_target_title,
            commands::capture_done,
            commands::set_badge,
            commands::rename_note,
            commands::backlink_count,
            commands::lock_note,
            commands::unlock_note,
            commands::lock_all,
            commands::delete_note,
            commands::snapshot_agent,
            commands::agent_write_done,
            commands::list_revisions,
            commands::read_revision,
            commands::snapshot_text,
            commands::has_identity,
            commands::setup_passphrase,
            commands::identity_file_exists,
            update::check_update,
            update::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while running velo")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev
                && let Some(agent) = app.try_state::<agent::listener::AgentState>()
                && let Some(l) = agent.listener.lock().unwrap().take()
            {
                l.stop(); // deletes agent.json: the headless server goes direct again
            }
        });
}
