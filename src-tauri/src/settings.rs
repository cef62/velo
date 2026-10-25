use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub notes_dir: Option<PathBuf>,
    /// "vertical" | "horizontal"
    pub layout: String,
    pub font_size: u32,
    /// "modified" | "title"
    pub sort: String,
    /// action id -> binding ("Mod+Shift+KeyP"); missing ids use the UI defaults
    pub shortcuts: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { notes_dir: None, layout: "vertical".into(), font_size: 14, sort: "modified".into(), shortcuts: BTreeMap::new() }
    }
}

const DEFAULT_TOGGLE: &str = "Mod+Shift+Space";

impl Settings {
    pub fn toggle_window_binding(&self) -> String {
        self.shortcuts.get("toggle_window").cloned().unwrap_or_else(|| DEFAULT_TOGGLE.into())
    }
}

/// "Mod+Shift+Space" -> "CommandOrControl+Shift+Space" (global-shortcut plugin syntax).
pub fn to_plugin_format(binding: &str) -> String {
    binding.split('+').map(|t| match t { "Mod" => "CommandOrControl", "Ctrl" => "Control", t => t }).collect::<Vec<_>>().join("+")
}

/// Inverse of `to_plugin_format`; also upgrades v1 forms (`CmdOrCtrl`, `N` -> `KeyN`, `1` -> `Digit1`).
pub fn from_plugin_format(s: &str) -> String {
    s.split('+').map(|t| match t {
        "CommandOrControl" | "CmdOrCtrl" | "CommandOrCtrl" => "Mod".to_string(),
        "Control" => "Ctrl".into(),
        t if t.len() == 1 && t.chars().all(|c| c.is_ascii_alphabetic()) => format!("Key{}", t.to_ascii_uppercase()),
        t if t.len() == 1 && t.chars().all(|c| c.is_ascii_digit()) => format!("Digit{t}"),
        t => t.into(),
    }).collect::<Vec<_>>().join("+")
}

pub fn load(path: &Path) -> Settings {
    let Some(v) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { return Settings::default() };
    let legacy = v.get("hotkey").and_then(|h| h.as_str()).map(from_plugin_format); // v1 field
    let mut s: Settings = serde_json::from_value(v).unwrap_or_default();
    if let Some(h) = legacy {
        s.shortcuts.entry("toggle_window".into()).or_insert(h);
    }
    s
}

pub fn save(path: &Path, s: &Settings) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn settings_defaults_and_roundtrip() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        let s = load(&p); assert_eq!(s.toggle_window_binding(), "Mod+Shift+Space"); assert_eq!(s.layout, "vertical");
        std::fs::write(&p, "{not json").unwrap(); assert_eq!(load(&p).font_size, 14);
        let mut s2 = s.clone(); s2.font_size = 18; s2.sort = "title".into(); s2.shortcuts.insert("rename".into(), "Mod+KeyR".into());
        save(&p, &s2).unwrap();
        let back = load(&p); assert_eq!((back.font_size, back.sort.as_str()), (18, "title")); assert_eq!(back.shortcuts, s2.shortcuts);
    }
    #[test] fn v1_settings_migrate() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        std::fs::write(&p, r#"{"notes_dir":"/n","hotkey":"CommandOrControl+Alt+KeyN","layout":"horizontal","font_size":16}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.shortcuts.get("toggle_window").map(String::as_str), Some("Mod+Alt+KeyN"));
        assert_eq!(s.sort, "modified"); assert_eq!(s.layout, "horizontal"); assert_eq!(s.font_size, 16);
    }
    #[test] fn migrate_when_shortcuts_lack_toggle_and_keeps_existing_toggle() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        std::fs::write(&p, r#"{"hotkey":"CmdOrCtrl+Alt+N","shortcuts":{"rename":"Mod+KeyR"}}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.toggle_window_binding(), "Mod+Alt+KeyN"); assert_eq!(s.shortcuts["rename"], "Mod+KeyR");
        std::fs::write(&p, r#"{"hotkey":"CmdOrCtrl+Alt+N","shortcuts":{"toggle_window":"Mod+KeyG"}}"#).unwrap();
        assert_eq!(load(&p).toggle_window_binding(), "Mod+KeyG");
    }
    #[test] fn defaults() { let s = Settings::default(); assert_eq!(s.sort, "modified"); assert_eq!(s.toggle_window_binding(), "Mod+Shift+Space"); }
    #[test] fn plugin_format_roundtrip() {
        assert_eq!(to_plugin_format("Mod+Shift+Space"), "CommandOrControl+Shift+Space");
        assert_eq!(from_plugin_format("CommandOrControl+Shift+Space"), "Mod+Shift+Space");
        assert_eq!(from_plugin_format("CmdOrCtrl+Alt+N"), "Mod+Alt+KeyN");
        assert_eq!(from_plugin_format("Control+1"), "Ctrl+Digit1");
        for b in ["Mod+Shift+Space", "Mod+Alt+KeyE", "Mod+BracketLeft", "Ctrl+F5"] {
            assert!(to_plugin_format(b).parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok(), "{b}");
        }
    }
}
