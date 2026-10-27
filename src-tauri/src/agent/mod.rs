//! Agent access: the headless `velo --mcp` MCP server (stdio).
pub mod ops;
pub mod paths;
pub mod server;
pub mod tools;

use ops::DirectOps;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

const OFF: &str = "Agent access is off — turn it on in velo Settings → General";

/// Entry point for `velo --mcp`; returns the process exit code. No Tauri app is built on this path.
pub fn run_headless() -> i32 {
    if cfg!(windows) {
        eprintln!("velo --mcp is not supported on Windows yet");
        return 1;
    }
    match server::run_stdio(gate(paths::config_dir().join("settings.json"), paths::data_dir())) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("velo --mcp: {e}");
            1
        }
    }
}

/// Wraps `tools::call` with the `agent_access` switch, re-read from `settings_path` on every call. The vault (direct
/// mode) opens on the first tool call, with its index in `data_dir` as the app keeps it, and reopens if the notes
/// folder changes.
fn gate(settings_path: PathBuf, data_dir: PathBuf) -> impl Fn(&str, Value) -> Result<Value, String> + Send + Sync + 'static {
    let ops: Mutex<Option<DirectOps>> = Mutex::new(None);
    move |name, args| {
        let s = crate::settings::load(&settings_path);
        if !s.agent_access {
            return Err(OFF.into());
        }
        if !tools::TOOL_SPECS.iter().any(|t| t.name == name) {
            return Err("unknown tool".into());
        }
        let dir = s.notes_dir.ok_or("No notes folder set in velo")?;
        let mut ops = ops.lock().unwrap_or_else(|e| e.into_inner());
        if ops.as_ref().is_none_or(|o| o.dir() != dir) {
            *ops = None;
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            // same index file as commands::open_vault_inner
            let db = data_dir.join(format!("index-{}.sqlite", crate::store::hash(dir.to_string_lossy().as_bytes())));
            *ops = Some(DirectOps::open(dir, &db, settings_path.clone()).map_err(|e| e.to_string())?);
        }
        tools::call(ops.as_mut().expect("opened above"), name, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test] fn paths_match_tauri() {
        assert!(paths::data_dir().ends_with("Library/Application Support/dev.velo.app"));
        assert_eq!(paths::config_dir(), paths::data_dir());
    }

    #[test] fn headless_refuses_when_off() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("settings.json");
        std::fs::write(&p, r#"{"agent_access":false}"#).unwrap();
        let call = gate(p.clone(), tmp.path().join("data"));
        assert_eq!(call("list_tags", serde_json::json!({})), Err("Agent access is off — turn it on in velo Settings → General".to_string()));
        std::fs::write(&p, r#"{"agent_access":true}"#).unwrap(); // re-read on every call
        assert_eq!(call("list_notes", serde_json::json!({})), Err("unknown tool".to_string()));
        assert_eq!(call("list_tags", serde_json::json!({})), Err("No notes folder set in velo".to_string()));
        let notes = tmp.path().join("notes"); std::fs::create_dir(&notes).unwrap();
        std::fs::write(notes.join("a.md"), "#t").unwrap();
        std::fs::write(&p, serde_json::json!({"agent_access": true, "notes_dir": notes}).to_string()).unwrap();
        assert_eq!(call("list_tags", serde_json::json!({})), Ok(serde_json::json!({"tags": [{"tag": "t", "count": 1}]})));
        assert!(std::fs::read_dir(tmp.path().join("data")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("index-")));
    }
}
