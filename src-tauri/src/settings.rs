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
    /// "rich" | "plain": how the editor shows markdown marks
    pub editor_style: String,
    /// action id -> binding ("Mod+Shift+KeyP"); missing ids use the UI defaults
    pub shortcuts: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { notes_dir: None, layout: "vertical".into(), font_size: 14, sort: "modified".into(), editor_style: "rich".into(), shortcuts: BTreeMap::new() }
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

const NAMED: &[&str] = &[
    "Space", "Comma", "Period", "Slash", "Backslash", "Semicolon", "Quote", "Backquote", "Minus", "Equal", "BracketLeft",
    "BracketRight", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp",
    "ArrowDown", "ArrowLeft", "ArrowRight", "Escape",
];

/// Inverse of `to_plugin_format`; also upgrades v1 forms like the UI's normalizeBinding does
/// (case-insensitive aliases `CmdOrCtrl`/`Command`/`Super`/`Option`..., `N` -> `KeyN`, `1` -> `Digit1`, Mod/Ctrl/Alt/Shift order).
pub fn from_plugin_format(s: &str) -> String {
    let mut mods = [false; 4]; // Mod, Ctrl, Alt, Shift
    let mut key = String::new();
    for t in s.split('+').map(str::trim) {
        let l = t.to_ascii_lowercase();
        let m = match l.as_str() {
            "mod" | "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" | "commandorctrl" | "command" | "cmd" | "super" | "meta" => 0,
            "ctrl" | "control" => 1,
            "alt" | "option" => 2,
            "shift" => 3,
            _ => {
                key = canonical_key(&l).unwrap_or_else(|| t.to_string());
                continue;
            }
        };
        mods[m] = true;
    }
    let names = ["Mod", "Ctrl", "Alt", "Shift"];
    (0..4).filter(|&i| mods[i]).map(|i| names[i]).chain(Some(key.as_str()).filter(|k| !k.is_empty())).collect::<Vec<_>>().join("+")
}

fn canonical_key(l: &str) -> Option<String> {
    let single = l.strip_prefix("key").or_else(|| l.strip_prefix("digit")).filter(|r| r.len() == 1).unwrap_or(l);
    let c = single.chars().next()?;
    if single.len() == 1 && c.is_ascii_alphabetic() {
        return Some(format!("Key{}", c.to_ascii_uppercase()));
    }
    if single.len() == 1 && c.is_ascii_digit() {
        return Some(format!("Digit{c}"));
    }
    if let Some(n) = NAMED.iter().find(|n| n.eq_ignore_ascii_case(l)) {
        return Some(n.to_string());
    }
    l.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=12).contains(n)).map(|n| format!("F{n}"))
}

/// True when both bindings parse to the same physical shortcut (spelling and modifier order ignored).
pub fn same_shortcut(a: &str, b: &str) -> bool {
    let id = |k: &str| to_plugin_format(k).parse::<tauri_plugin_global_shortcut::Shortcut>().ok().map(|s| s.id());
    matches!((id(a), id(b)), (Some(x), Some(y)) if x == y)
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
        assert_eq!(s.sort, "modified"); assert_eq!(s.editor_style, "rich"); assert_eq!(s.layout, "horizontal"); assert_eq!(s.font_size, 16);
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
    #[test] fn from_plugin_format_matches_ui_normalization() {
        assert_eq!(from_plugin_format("CmdOrControl+Alt+N"), "Mod+Alt+KeyN");
        assert_eq!(from_plugin_format("command+alt+n"), "Mod+Alt+KeyN");
        assert_eq!(from_plugin_format("Shift+Option+Control+Super+5"), "Mod+Ctrl+Alt+Shift+Digit5");
        assert_eq!(from_plugin_format("CmdOrCtrl+bracketleft"), "Mod+BracketLeft");
        assert_eq!(from_plugin_format("meta+shift+space"), "Mod+Shift+Space");
        assert_eq!(from_plugin_format("Mod+f5"), "Mod+F5");
        assert_eq!(from_plugin_format("Mod+keyb"), "Mod+KeyB");
    }
    #[test] fn same_shortcut_compares_physical_keys() {
        assert!(same_shortcut("Mod+Alt+KeyN", "CommandOrControl+Alt+N"));
        assert!(same_shortcut("Mod+Alt+KeyN", "Alt+Mod+KeyN"));
        assert!(!same_shortcut("Mod+Alt+KeyN", "Mod+Alt+KeyM"));
        assert!(!same_shortcut("Mod+Alt+KeyN", "garbage+++"));
    }
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
