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
    pub watcher: Mutex<Option<watch::Watcher>>,
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

/// (Re)open the vault and watcher for `dir`. On error the previous vault/watcher stay untouched.
pub fn open_vault(app: &AppHandle, st: &AppState, dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(&st.data_dir)?;
    let db = st.data_dir.join(format!("index-{}.sqlite", store::hash(dir.to_string_lossy().as_bytes())));
    let vault = Vault::open(dir.to_path_buf(), &db, identity(st).as_deref())?;
    let handle = app.clone();
    let base = dir.to_path_buf();
    let w = watch::spawn(dir.to_path_buf(), move |paths| {
        let st = handle.state::<AppState>();
        let id = identity(&st);
        let changed = match st.vault.lock().unwrap().as_mut() {
            Some(v) if watch::applies_to(&v.store.dir, &base) => v.apply_fs_changes(&paths, id.as_deref()),
            _ => return,
        };
        if !changed.is_empty() {
            handle.emit("notes-changed", serde_json::json!({ "paths": changed })).ok();
        }
    })?;
    let old = st.watcher.lock().unwrap().replace(w);
    *st.vault.lock().unwrap() = Some(vault);
    if let Some(old) = old {
        old.stop(); // joins; must not hold the vault lock (an in-flight callback may want it)
    }
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
    let closed = st.vault.lock().unwrap().is_none();
    if old.notes_dir != settings.notes_dir || (closed && settings.notes_dir.is_some()) {
        let opened = match &settings.notes_dir {
            Some(dir) => open_vault(&app, &st, dir).map_err(err),
            None => {
                let w = st.watcher.lock().unwrap().take();
                *st.vault.lock().unwrap() = None;
                w.map(|w| w.stop());
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
pub fn list_titles(st: State<AppState>) -> Res<Vec<String>> {
    with_vault(&st, |v, _| v.titles())
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

/// Whether `<dir>/.velo/identity.age` exists; lets the UI choose between "enter" and "create" wording.
fn identity_file_exists_in(dir: &Path) -> std::io::Result<bool> {
    Ok(read_identity_file(&dir.join(crypto::IDENTITY_FILE))?.is_some())
}

#[tauri::command]
pub fn identity_file_exists(st: State<AppState>) -> Res<bool> {
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

#[tauri::command]
pub fn setup_passphrase(app: AppHandle, st: State<AppState>, passphrase: String) -> Res<()> {
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
    if existing.as_deref() != Some(id.as_str()) {
        crypto::keychain_set(&id).map_err(err)?;
    }
    *st.identity.lock().unwrap() = Some(id);
    open_vault(&app, &st, &dir).map_err(err) // reopening re-decrypts locked notes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn read_identity_file_only_maps_not_found_to_none() {
        let d = tempfile::tempdir().unwrap();
        assert!(read_identity_file(&d.path().join("missing")).unwrap().is_none());
        assert!(read_identity_file(d.path()).is_err()); // a directory: read fails, not NotFound
        std::fs::write(d.path().join("f"), "x").unwrap();
        assert_eq!(read_identity_file(&d.path().join("f")).unwrap().unwrap(), b"x");
    }
    #[test] fn identity_file_exists_in_cases() {
        let d = tempfile::tempdir().unwrap();
        assert!(!identity_file_exists_in(d.path()).unwrap());
        std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(crypto::IDENTITY_FILE), b"x").unwrap();
        assert!(identity_file_exists_in(d.path()).unwrap());
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
