use crate::crypto;
use crate::index::Hit;
use crate::settings::{self, Settings};
use crate::store::{self, SaveResult};
use crate::vault::{NoteDoc, RenameResult, Vault};
use crate::watch;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub vault: Mutex<Option<Vault>>,
    pub watcher: Mutex<Option<Box<dyn Send>>>,
    /// keychain identity, read at startup and after `setup_passphrase`
    pub identity: Mutex<Option<String>>,
    pub settings_path: PathBuf,
    pub data_dir: PathBuf,
}

type Res<T> = Result<T, String>;

/// Map anyhow errors to the stable strings the UI matches on.
fn err(e: anyhow::Error) -> String {
    if e.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists) {
        return "already-exists".into();
    }
    e.to_string() // "locked" passes through verbatim
}

fn identity(st: &AppState) -> Option<String> {
    st.identity.lock().unwrap().clone()
}

fn with_vault<T>(st: &AppState, f: impl FnOnce(&mut Vault, Option<&str>) -> anyhow::Result<T>) -> Res<T> {
    let id = identity(st);
    let mut guard = st.vault.lock().unwrap();
    let v = guard.as_mut().ok_or("no-folder")?;
    f(v, id.as_deref()).map_err(err)
}

/// (Re)open the vault and watcher for `dir`.
pub fn open_vault(app: &AppHandle, st: &AppState, dir: &Path) -> anyhow::Result<()> {
    *st.watcher.lock().unwrap() = None;
    *st.vault.lock().unwrap() = None; // release the old index connection first
    std::fs::create_dir_all(&st.data_dir)?;
    let db = st.data_dir.join(format!("index-{}.sqlite", store::hash(dir.to_string_lossy().as_bytes())));
    let vault = Vault::open(dir.to_path_buf(), &db, identity(st).as_deref())?;
    *st.vault.lock().unwrap() = Some(vault);
    let handle = app.clone();
    let w = watch::spawn(dir.to_path_buf(), move |paths| {
        let st = handle.state::<AppState>();
        let id = identity(&st);
        let changed = match st.vault.lock().unwrap().as_mut() {
            Some(v) => v.apply_fs_changes(&paths, id.as_deref()),
            None => return,
        };
        if !changed.is_empty() {
            handle.emit("notes-changed", serde_json::json!({ "paths": changed })).ok();
        }
    })?;
    *st.watcher.lock().unwrap() = Some(Box::new(w));
    Ok(())
}

pub fn toggle_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        w.hide().ok();
    } else {
        w.show().ok();
        w.unminimize().ok();
        w.set_focus().ok();
        w.emit("focus-search", ()).ok();
    }
}

pub fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let sc: Shortcut = hotkey.parse().map_err(|e| format!("invalid hotkey: {e}"))?;
    app.global_shortcut()
        .on_shortcut(sc, |app, _, ev| {
            if ev.state == ShortcutState::Pressed {
                toggle_window(app);
            }
        })
        .map_err(|e| e.to_string())
}

fn unregister_hotkey(app: &AppHandle, hotkey: &str) {
    if let Ok(sc) = hotkey.parse::<Shortcut>() {
        app.global_shortcut().unregister(sc).ok();
    }
}

#[tauri::command]
pub fn get_settings(st: State<AppState>) -> Settings {
    st.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, st: State<AppState>, settings: Settings) -> Res<()> {
    let old = st.settings.lock().unwrap().clone();
    let hotkey_changed = old.hotkey != settings.hotkey;
    if hotkey_changed {
        register_hotkey(&app, &settings.hotkey)?; // on failure the old hotkey stays registered
    }
    if old.notes_dir != settings.notes_dir {
        let opened = match &settings.notes_dir {
            Some(dir) => open_vault(&app, &st, dir).map_err(err),
            None => {
                *st.watcher.lock().unwrap() = None;
                *st.vault.lock().unwrap() = None;
                Ok(())
            }
        };
        if let Err(e) = opened {
            if hotkey_changed {
                unregister_hotkey(&app, &settings.hotkey);
            }
            return Err(e);
        }
    }
    if hotkey_changed {
        unregister_hotkey(&app, &old.hotkey);
    }
    settings::save(&st.settings_path, &settings).map_err(err)?;
    *st.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
pub fn search(st: State<AppState>, query: String) -> Res<Vec<Hit>> {
    with_vault(&st, |v, _| v.search(&query))
}

#[tauri::command]
pub fn open_note(st: State<AppState>, path: String) -> Res<NoteDoc> {
    with_vault(&st, |v, id| v.open_note(&path, id))
}

#[tauri::command]
pub fn open_or_create(st: State<AppState>, title: String) -> Res<NoteDoc> {
    with_vault(&st, |v, id| v.open_or_create(&title, id))
}

#[tauri::command]
pub fn save_note(st: State<AppState>, path: String, text: String, base_hash: String) -> Res<SaveResult> {
    with_vault(&st, |v, id| v.save_note(&path, &text, &base_hash, id))
}

#[tauri::command]
pub fn rename_note(st: State<AppState>, path: String, new_title: String, rewrite_links: bool) -> Res<RenameResult> {
    with_vault(&st, |v, _| v.rename_note(&path, &new_title, rewrite_links))
}

#[tauri::command]
pub fn backlink_count(st: State<AppState>, title: String) -> Res<usize> {
    with_vault(&st, |v, _| v.backlink_count(&title))
}

#[tauri::command]
pub fn lock_note(st: State<AppState>, path: String) -> Res<String> {
    with_vault(&st, |v, id| v.lock_note(&path, id.ok_or_else(|| anyhow::anyhow!("no-identity"))?))
}

#[tauri::command]
pub fn unlock_note(st: State<AppState>, path: String) -> Res<String> {
    with_vault(&st, |v, id| v.unlock_note(&path, id.ok_or_else(|| anyhow::anyhow!("no-identity"))?))
}

#[tauri::command]
pub fn lock_all(st: State<AppState>) -> Res<()> {
    with_vault(&st, |v, _| {
        v.lock_all();
        Ok(())
    })
}

#[tauri::command]
pub fn has_identity(st: State<AppState>) -> bool {
    if identity(&st).is_some() {
        return true;
    }
    let found = crypto::keychain_get(); // no locks held across the keychain call
    let has = found.is_some();
    if has {
        *st.identity.lock().unwrap() = found;
    }
    has
}

#[tauri::command]
pub fn setup_passphrase(app: AppHandle, st: State<AppState>, passphrase: String) -> Res<()> {
    let dir = st.settings.lock().unwrap().notes_dir.clone().ok_or("no-folder")?;
    let file = dir.join(crypto::IDENTITY_FILE);
    let id = if file.exists() {
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        crypto::unwrap_identity(&bytes, &passphrase).map_err(|_| "wrong-passphrase".to_string())?
    } else {
        let id = crypto::new_identity();
        let wrapped = crypto::wrap_identity(&id, &passphrase).map_err(err)?;
        std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
        let tmp = file.with_extension("age.tmp");
        std::fs::write(&tmp, wrapped).and_then(|_| std::fs::rename(&tmp, &file)).map_err(|e| e.to_string())?;
        id
    };
    crypto::keychain_set(&id).map_err(err)?;
    *st.identity.lock().unwrap() = Some(id);
    open_vault(&app, &st, &dir).map_err(err) // reopening re-decrypts locked notes
}
