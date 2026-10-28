//! Tauri's `app_data_dir()` / `app_config_dir()` for identifier `dev.velo.app`, without a Tauri app handle: the same
//! `dirs` calls Tauri makes (XDG rules on Linux, the passwd entry when `HOME` is unset), so both processes agree.
use std::path::PathBuf;

const IDENTIFIER: &str = "dev.velo.app";

/// `None` when the OS reports no home directory.
pub fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(IDENTIFIER))
}

pub fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(IDENTIFIER))
}
