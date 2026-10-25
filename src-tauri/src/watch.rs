use crate::names::parse_note_file;
use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{Debouncer, RecommendedCache, new_debouncer};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Call `.stop()` (joins the thread) when replacing a watcher; plain drop may fire one more callback.
pub type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// A callback may only touch the vault of the folder its watcher was started for.
pub fn applies_to(vault_dir: &Path, watched: &Path) -> bool {
    vault_dir == watched
}

/// Watches `dir` (non-recursive). Paths are rebuilt as `dir.join(file_name)` so they match
/// `Store::list` even when the OS reports canonicalized paths; non-note files are dropped.
pub fn spawn(dir: PathBuf, on_change: impl Fn(Vec<PathBuf>) + Send + 'static) -> Result<Watcher> {
    let base = dir.clone();
    let mut deb = new_debouncer(Duration::from_millis(300), None, move |res: notify_debouncer_full::DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<PathBuf> = events
            .iter()
            .flat_map(|e| e.event.paths.iter())
            .filter_map(|p| p.file_name())
            .map(|n| base.join(n))
            .filter(|p| parse_note_file(p).is_some())
            .collect();
        paths.sort();
        paths.dedup();
        if !paths.is_empty() {
            on_change(paths);
        }
    })?;
    deb.watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(deb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test] fn watcher_reports_external_write() {
        let tmp = tempfile::tempdir().unwrap(); let dir = tmp.path().to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel(); let _w = spawn(dir.clone(), move |p| { tx.send(p).ok(); }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.join(".x.md.tmp"), "t").unwrap(); std::fs::write(dir.join("y.png"), "p").unwrap(); std::fs::write(dir.join("x.md"), "hi").unwrap();
        let mut got: Vec<PathBuf> = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        while let Ok(more) = rx.recv_timeout(Duration::from_millis(1000)) { got.extend(more); }
        assert!(got.contains(&dir.join("x.md")), "{got:?}");
        assert!(got.iter().all(|p| parse_note_file(p).is_some()), "non-note delivered: {got:?}");
    }
    #[test] fn applies_only_to_own_folder() { assert!(applies_to(Path::new("/a"), Path::new("/a"))); assert!(!applies_to(Path::new("/b"), Path::new("/a"))); }
}
