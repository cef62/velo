//! `velo.log` in the app log dir: panics and update phases. Release builds launched from Finder
//! send stderr to /dev/null and abort on panic, so this file is the only trace a user can attach.
//! Never write note content or secrets here.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Past this size the file moves to `velo.log.1` (replacing the older one) before the next line.
const MAX_LEN: u64 = 1024 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();

/// Sets the log file and installs the panic hook. The default hook still runs after the line is written.
pub fn init(dir: &Path, version: String) {
    std::fs::create_dir_all(dir).ok();
    if PATH.set(dir.join("velo.log")).is_err() {
        return;
    }
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let p = info.payload();
        let msg = p.downcast_ref::<&str>().copied().or_else(|| p.downcast_ref::<String>().map(String::as_str)).unwrap_or("(non-string payload)");
        let loc = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        line(&panic_line(&version, std::thread::current().name().unwrap_or("unnamed"), msg, loc.as_deref()));
        default(info);
    }));
}

pub fn panic_line(version: &str, thread: &str, msg: &str, loc: Option<&str>) -> String {
    format!("panic in velo {version} on thread '{thread}' at {}: {msg}", loc.unwrap_or("unknown location"))
}

/// One timestamped line; a no-op before `init` (tests, the headless `--mcp` server).
pub fn line(msg: &str) {
    if let Some(p) = PATH.get() {
        append(p, msg);
    }
}

fn append(path: &Path, msg: &str) {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_LEN) {
        std::fs::rename(path, path.with_extension("log.1")).ok();
    }
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f %z");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        f.write_all(format!("{ts} {msg}\n").as_bytes()).ok(); // one write: lines from two threads never interleave
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_lines_and_rotates_past_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("velo.log");
        append(&p, "one");
        append(&p, "two");
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().next().unwrap().ends_with(" one"));
        std::fs::write(&p, vec![b'x'; MAX_LEN as usize + 1]).unwrap();
        append(&p, "three");
        assert!(std::fs::read_to_string(&p).unwrap().trim_end().ends_with(" three"));
        assert_eq!(std::fs::metadata(dir.path().join("velo.log.1")).unwrap().len(), MAX_LEN + 1);
    }

    #[test]
    fn panic_line_names_version_thread_location_and_message() {
        assert_eq!(
            panic_line("0.8.1", "main", "boom", Some("src/a.rs:1:2")),
            "panic in velo 0.8.1 on thread 'main' at src/a.rs:1:2: boom"
        );
        assert_eq!(panic_line("0.8.1", "t", "x", None), "panic in velo 0.8.1 on thread 't' at unknown location: x");
    }
}
