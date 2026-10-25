pub mod commands;
pub mod crypto;
pub mod index;
pub mod names;
pub mod settings;
pub mod store;
pub mod text;
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
    tauri::menu::Menu::with_items(app, &[
        &Submenu::with_items(app, "velo", true, &[
            &P::about(app, None, None)?, &P::separator(app)?, &P::hide(app, None)?, &P::hide_others(app, None)?,
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
                });
            }
            let h = app.handle().clone();
            let config_dir = h.path().app_config_dir()?;
            let data_dir = h.path().app_data_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;
            let settings_path = config_dir.join("settings.json");
            let settings = settings::load(&settings_path);
            let (dir, hotkey) = (settings.notes_dir.clone(), settings.hotkey.clone());
            app.manage(commands::AppState {
                settings: Mutex::new(settings),
                vault: Mutex::new(None),
                watcher: Mutex::new(None),
                identity: Mutex::new(crypto::keychain_get()),
                settings_path,
                data_dir,
            });
            if let Some(dir) = dir
                && let Err(e) = commands::open_vault(&h, &h.state(), &dir)
            {
                eprintln!("velo: cannot open notes folder: {e}");
            }
            if let Err(e) = commands::register_hotkey(&h, &hotkey) {
                eprintln!("velo: hotkey not registered: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_settings,
            commands::search,
            commands::list_titles,
            commands::open_note,
            commands::open_or_create,
            commands::save_note,
            commands::rename_note,
            commands::backlink_count,
            commands::lock_note,
            commands::unlock_note,
            commands::lock_all,
            commands::has_identity,
            commands::setup_passphrase,
            commands::identity_file_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running velo");
}
