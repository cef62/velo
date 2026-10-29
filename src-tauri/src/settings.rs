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
    /// "system" | "light" | "dark"
    pub theme: String,
    /// show text labels next to the header buttons
    pub header_labels: bool,
    /// action id -> binding ("Mod+Shift+KeyP"); missing ids use the UI defaults
    pub shortcuts: BTreeMap<String, String>,
    /// stamp created/modified front matter on save and new notes
    pub write_front_matter: bool,
    /// show the front-matter block in the editor
    pub show_front_matter: bool,
    /// info panel open
    pub info_panel: bool,
    /// check GitHub for a new release daily (release builds only)
    pub auto_update_check: bool,
    /// quick capture target: "inbox" | "daily"
    pub capture_target: String,
    /// the Inbox note's title; empty/invalid falls back to "Inbox"
    pub inbox_title: String,
    /// let AI agents use the notes through `velo --mcp`; the headless server re-reads this on every tool call
    pub agent_access: bool,
    /// Connections view ring order: "ring" | "created" | "updated"; anything else reads as "ring"
    pub connections_sort: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { notes_dir: None, layout: "vertical".into(), font_size: 14, sort: "modified".into(), editor_style: "rich".into(), theme: "system".into(), header_labels: false, shortcuts: BTreeMap::new(), write_front_matter: true, show_front_matter: false, info_panel: false, auto_update_check: true, capture_target: "inbox".into(), inbox_title: "Inbox".into(), agent_access: false, connections_sort: "ring".into() }
    }
}

const DEFAULT_TOGGLE: &str = "Mod+Shift+Space";
const DEFAULT_CAPTURE: &str = "Mod+Alt+Shift+KeyN"; // canonical modifier order, as the UI's DEFAULTS
/// Every action id in the UI's `DEFAULTS` (src/shortcuts.ts); a saved id outside it (e.g. the old `next_note`) is ignored there.
pub const ACTIONS: [&str; 20] = [
    "focus_search", "toggle_preview", "rename", "toggle_lock", "lock_all", "settings", "toggle_sort", "back", "forward", "delete_note",
    "toggle_tags", "toggle_rich", "toggle_layout", "toggle_window", "toggle_info", "toggle_front_matter", "toggle_tasks", "toggle_connections", "capture", "daily_note",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GlobalAction { ToggleWindow, Capture }

impl Settings {
    pub fn toggle_window_binding(&self) -> String {
        self.shortcuts.get("toggle_window").cloned().unwrap_or_else(|| DEFAULT_TOGGLE.into())
    }

    /// Every global shortcut with its binding ("none" = unset). Same rule as the UI's `resolve()`: an action left
    /// on its default yields to any saved binding of another action on that key (a default added by an upgrade).
    pub fn global_bindings(&self) -> Vec<(GlobalAction, String)> {
        let get = |id: &str, d: &str| match self.shortcuts.get(id) {
            Some(k) => k.clone(),
            None if self.shortcuts.iter().any(|(a, k)| ACTIONS.contains(&a.as_str()) && same_shortcut(k, d)) => "none".into(),
            None => d.into(),
        };
        vec![(GlobalAction::ToggleWindow, get("toggle_window", DEFAULT_TOGGLE)), (GlobalAction::Capture, get("capture", DEFAULT_CAPTURE))]
    }
}

/// The quick-capture target note title: today's daily note or the Inbox, through the file-name rules.
pub fn capture_title(s: &Settings, today: &str) -> String {
    if s.capture_target == "daily" {
        return today.into();
    }
    let t = crate::names::title_to_stem(&s.inbox_title);
    // title_to_stem says "Untitled" for a title with nothing usable left (empty, "...")
    if t == "Untitled" && s.inbox_title.trim() != "Untitled" { "Inbox".into() } else { t }
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

/// Parses a velo binding for registration; "none" (cleared) is Ok(None).
pub fn parse_hotkey(binding: &str) -> Result<Option<tauri_plugin_global_shortcut::Shortcut>, String> {
    if binding == "none" {
        return Ok(None);
    }
    to_plugin_format(binding).parse().map(Some).map_err(|e| format!("invalid hotkey: {e}"))
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
    if !["ring", "created", "updated"].contains(&s.connections_sort.as_str()) {
        s.connections_sort = "ring".into();
    }
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
        assert!(s.write_front_matter && !s.show_front_matter && !s.info_panel && s.auto_update_check);
        std::fs::write(&p, "{not json").unwrap(); assert_eq!(load(&p).font_size, 14);
        let mut s2 = s.clone(); s2.font_size = 18; s2.write_front_matter = false; s2.info_panel = true; s2.sort = "title".into(); s2.shortcuts.insert("rename".into(), "Mod+KeyR".into());
        save(&p, &s2).unwrap();
        let back = load(&p); assert_eq!((back.font_size, back.sort.as_str()), (18, "title")); assert_eq!(back.shortcuts, s2.shortcuts); assert!(!back.write_front_matter && back.info_panel);
    }
    #[test] fn v1_settings_migrate() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        std::fs::write(&p, r#"{"notes_dir":"/n","hotkey":"CommandOrControl+Alt+KeyN","layout":"horizontal","font_size":16}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.shortcuts.get("toggle_window").map(String::as_str), Some("Mod+Alt+KeyN"));
        assert_eq!(s.sort, "modified"); assert_eq!(s.editor_style, "rich"); assert_eq!(s.theme, "system"); assert!(!s.header_labels); assert_eq!(s.layout, "horizontal"); assert_eq!(s.font_size, 16);
    }
    #[test] fn migrate_when_shortcuts_lack_toggle_and_keeps_existing_toggle() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        std::fs::write(&p, r#"{"hotkey":"CmdOrCtrl+Alt+N","shortcuts":{"rename":"Mod+KeyR"}}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.toggle_window_binding(), "Mod+Alt+KeyN"); assert_eq!(s.shortcuts["rename"], "Mod+KeyR");
        std::fs::write(&p, r#"{"hotkey":"CmdOrCtrl+Alt+N","shortcuts":{"toggle_window":"Mod+KeyG"}}"#).unwrap();
        assert_eq!(load(&p).toggle_window_binding(), "Mod+KeyG");
    }
    #[test] fn none_binding() {
        let dir = tempfile::tempdir().unwrap(); let p = dir.path().join("settings.json");
        let mut s = Settings::default(); s.shortcuts.insert("toggle_window".into(), "none".into());
        save(&p, &s).unwrap();
        assert_eq!(load(&p).toggle_window_binding(), "none");
        assert!(parse_hotkey("none").unwrap().is_none());
        assert!(parse_hotkey("Mod+Shift+Space").unwrap().is_some());
        assert!(parse_hotkey("bogus").is_err());
    }
    #[test] fn settings_agent_access_defaults_off() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        std::fs::write(&p, r#"{"font_size":16}"#).unwrap();
        assert!(!load(&p).agent_access);
        assert!(!Settings::default().agent_access);
    }
    #[test] fn connections_sort_defaults_to_ring() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
        assert_eq!(Settings::default().connections_sort, "ring");
        std::fs::write(&p, r#"{"font_size":16}"#).unwrap();
        assert_eq!(load(&p).connections_sort, "ring");
        std::fs::write(&p, r#"{"connections_sort":"bogus"}"#).unwrap();
        assert_eq!(load(&p).connections_sort, "ring");
        std::fs::write(&p, r#"{"connections_sort":"created"}"#).unwrap();
        assert_eq!(load(&p).connections_sort, "created");
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

    #[test] fn capture_title_inbox_daily_and_fallback() {
        let mut s = Settings::default();
        assert_eq!(s.capture_target, "inbox");
        s.inbox_title = "".into(); assert_eq!(capture_title(&s, "2026-10-27"), "Inbox");
        s.inbox_title = "  ".into(); assert_eq!(capture_title(&s, "2026-10-27"), "Inbox");
        s.inbox_title = "...".into(); assert_eq!(capture_title(&s, "2026-10-27"), "Inbox");
        s.inbox_title = "Untitled".into(); assert_eq!(capture_title(&s, "2026-10-27"), "Untitled");
        s.inbox_title = "Todo".into(); assert_eq!(capture_title(&s, "2026-10-27"), "Todo");
        s.inbox_title = "a/b".into(); assert_eq!(capture_title(&s, "2026-10-27"), "a-b");
        s.capture_target = "daily".into(); assert_eq!(capture_title(&s, "2026-10-27"), "2026-10-27");
        assert_eq!(Settings::default().inbox_title, "Inbox");
    }

    #[test] fn global_bindings_defaults_and_overrides() {
        let mut s = Settings::default();
        assert_eq!(s.global_bindings(), vec![(GlobalAction::ToggleWindow, "Mod+Shift+Space".to_string()), (GlobalAction::Capture, "Mod+Alt+Shift+KeyN".to_string())]);
        s.shortcuts.insert("capture".into(), "Mod+KeyG".into()); s.shortcuts.insert("toggle_window".into(), "none".into());
        assert_eq!(s.global_bindings(), vec![(GlobalAction::ToggleWindow, "none".to_string()), (GlobalAction::Capture, "Mod+KeyG".to_string())]);
    }
    #[test] fn global_default_yields_to_a_saved_binding_on_its_key() {
        let mut s = Settings::default();
        s.shortcuts.insert("rename".into(), "Mod+Alt+Shift+KeyN".into()); // saved before capture existed
        assert_eq!(s.global_bindings()[1], (GlobalAction::Capture, "none".to_string()));
        s.shortcuts.insert("capture".into(), "Mod+Shift+Alt+KeyN".into()); // explicitly chosen: kept
        assert_eq!(s.global_bindings()[1], (GlobalAction::Capture, "Mod+Shift+Alt+KeyN".to_string()));
        let mut t = Settings::default();
        t.shortcuts.insert("capture".into(), "Mod+Shift+Space".into()); // capture saved on toggle_window's default
        assert_eq!(t.global_bindings()[0], (GlobalAction::ToggleWindow, "none".to_string()));
    }
    #[test] fn global_default_ignores_saved_ids_the_ui_does_not_know() {
        let mut s = Settings::default();
        s.shortcuts.insert("next_note".into(), "Mod+Alt+Shift+KeyN".into()); // obsolete action, still in an old full snapshot
        assert_eq!(s.global_bindings()[1], (GlobalAction::Capture, "Mod+Alt+Shift+KeyN".to_string()));
    }
}
