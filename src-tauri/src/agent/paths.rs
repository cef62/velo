//! Tauri's `app_data_dir()` / `app_config_dir()` for identifier `dev.velo.app`, without a Tauri app handle.
use std::path::PathBuf;

const IDENTIFIER: &str = "dev.velo.app";

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// `$XDG_*` when set to an absolute path, else `~/<fallback>` (the `dirs` crate rule Tauri uses).
#[cfg(not(target_os = "macos"))]
fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(fallback))
}

#[cfg(target_os = "macos")]
pub fn data_dir() -> PathBuf {
    home().join("Library/Application Support").join(IDENTIFIER)
}

#[cfg(target_os = "macos")]
pub fn config_dir() -> PathBuf {
    data_dir()
}

// shortcut: Windows reuses the Linux rule, but `--mcp` refuses to run there before any path is used.
#[cfg(not(target_os = "macos"))]
pub fn data_dir() -> PathBuf {
    xdg("XDG_DATA_HOME", ".local/share").join(IDENTIFIER)
}

#[cfg(not(target_os = "macos"))]
pub fn config_dir() -> PathBuf {
    xdg("XDG_CONFIG_HOME", ".config").join(IDENTIFIER)
}
