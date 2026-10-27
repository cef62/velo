//! Agent access: the headless `velo --mcp` MCP server (stdio).
pub mod paths;
pub mod server;
pub mod tools;

use serde_json::Value;
use std::path::PathBuf;

const OFF: &str = "Agent access is off — turn it on in velo Settings → General";

/// Entry point for `velo --mcp`; returns the process exit code. No Tauri app is built on this path.
pub fn run_headless() -> i32 {
    if cfg!(windows) {
        eprintln!("velo --mcp is not supported on Windows yet");
        return 1;
    }
    match server::run_stdio(gate(paths::config_dir().join("settings.json"))) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("velo --mcp: {e}");
            1
        }
    }
}

/// Wraps `tools::call` with the `agent_access` switch, re-read from `settings_path` on every call.
fn gate(settings_path: PathBuf) -> impl Fn(&str, Value) -> Result<Value, String> + Send + Sync + 'static {
    move |name, args| {
        if !crate::settings::load(&settings_path).agent_access {
            return Err(OFF.into());
        }
        tools::call(name, args)
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
        let call = gate(p.clone());
        assert_eq!(call("list_notes", serde_json::json!({})), Err("Agent access is off — turn it on in velo Settings → General".to_string()));
        std::fs::write(&p, r#"{"agent_access":true}"#).unwrap(); // re-read on every call
        assert_eq!(call("list_notes", serde_json::json!({})), Err("unknown tool".to_string()));
    }
}
