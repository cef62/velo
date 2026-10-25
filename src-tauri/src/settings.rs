use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub notes_dir: Option<PathBuf>,
    pub hotkey: String,
    /// "vertical" | "horizontal"
    pub layout: String,
    pub font_size: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { notes_dir: None, hotkey: "CommandOrControl+Shift+Space".into(), layout: "vertical".into(), font_size: 14 }
    }
}

pub fn load(path: &Path) -> Settings {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
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
        let s = load(&p); assert_eq!(s.hotkey, "CommandOrControl+Shift+Space"); assert_eq!(s.layout, "vertical");
        std::fs::write(&p, "{not json").unwrap(); assert_eq!(load(&p).font_size, 14);
        let mut s2 = s.clone(); s2.font_size = 18; save(&p, &s2).unwrap(); assert_eq!(load(&p).font_size, 18);
    }
}
