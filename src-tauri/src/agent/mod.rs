//! Agent access: the headless `velo --mcp` MCP server (stdio).
pub mod app_ops;
pub mod client;
pub mod listener;
pub mod ops;
pub mod paths;
pub mod server;
pub mod tools;

use ops::DirectOps;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) const OFF: &str = "Agent access is off — turn it on in velo Settings → General";

/// Entry point for `velo --mcp`; returns the process exit code. No Tauri app is built on this path.
pub fn run_headless() -> i32 {
    if cfg!(windows) {
        eprintln!("velo --mcp is not supported on Windows yet");
        return 1;
    }
    let (Some(config), Some(data)) = (paths::config_dir(), paths::data_dir()) else {
        eprintln!("velo --mcp: no home directory (set HOME)");
        return 1;
    };
    match server::run_stdio(gate(config.join("settings.json"), data)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("velo --mcp: {e}");
            1
        }
    }
}

/// Wraps `tools::call` with the `agent_access` switch and app-or-direct routing, re-read from `settings_path` on every call. The vault (direct
/// mode) opens on the first tool call, with its index in `data_dir` as the app keeps it, and reopens if the notes
/// folder changes.
fn gate(settings_path: PathBuf, data_dir: PathBuf) -> impl Fn(&str, Value) -> Result<Value, String> + Send + Sync + 'static {
    let ops: Mutex<Option<DirectOps>> = Mutex::new(None);
    move |name, args| {
        let s = crate::settings::load(&settings_path);
        if !s.agent_access {
            *ops.lock().unwrap_or_else(|e| e.into_inner()) = None; // nothing may stay open while access is off
            return Err(OFF.into());
        }
        if !tools::TOOL_SPECS.iter().any(|t| t.name == name) {
            return Err("unknown tool".into());
        }
        if let Some(r) = client::forward(&data_dir, name, &args) {
            *ops.lock().unwrap_or_else(|e| e.into_inner()) = None; // the app owns the index while it runs
            return r;
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
        let ops = ops.as_mut().expect("opened above");
        ops.rescan();
        tools::call(ops, name, args)
    }
}

// `velo --mcp` refuses to run on Windows, and these tests use Unix processes and sockets
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test] fn paths_match_tauri() {
        let (data, config) = (paths::data_dir().unwrap(), paths::config_dir().unwrap());
        assert!(data.is_absolute() && data.ends_with("dev.velo.app") && config.ends_with("dev.velo.app"));
        #[cfg(target_os = "macos")]
        {
            assert!(data.ends_with("Library/Application Support/dev.velo.app"));
            assert_eq!(config, data);
        }
        // Linux: the XDG rules are the `dirs` crate's, the same calls Tauri's path resolver makes
        #[cfg(target_os = "linux")]
        assert_eq!((data.parent(), config.parent()), (dirs::data_dir().as_deref(), dirs::config_dir().as_deref()));
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
        // outside changes after the vault opened are seen on the next call
        std::fs::write(notes.join("b.md"), "late").unwrap();
        assert_eq!(call("read_note", serde_json::json!({"title": "b"})).unwrap()["text"], "late");
        std::fs::remove_file(notes.join("a.md")).unwrap();
        let hits = call("search_notes", serde_json::json!({})).unwrap();
        assert_eq!(hits["notes"].as_array().unwrap().iter().map(|n| n["title"].as_str().unwrap()).collect::<Vec<_>>(), vec!["b"]);
        assert!(std::fs::read_dir(tmp.path().join("data")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("index-")));
    }

    /// Fake app: answers the auth line `{"ok": true}` when the token matches, then every request with
    /// `{"ok": {"fake": name}}`.
    fn fake_app(data: &std::path::Path, pid: u32, listen: bool) {
        use std::io::{BufRead, BufReader, Write};
        std::fs::create_dir_all(data).unwrap();
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::fs::write(data.join("agent.json"), serde_json::json!({"port": port, "token": "tok", "pid": pid}).to_string()).unwrap();
        if !listen { return; }
        std::thread::spawn(move || for c in l.incoming().flatten() {
            let mut r = BufReader::new(c.try_clone().unwrap()); let mut line = String::new();
            r.read_line(&mut line).unwrap();
            if serde_json::from_str::<Value>(&line).unwrap()["token"] != "tok" { writeln!(&c, r#"{{"err":"unauthorized"}}"#).unwrap(); continue; }
            writeln!(&c, r#"{{"ok":true}}"#).unwrap(); line.clear();
            while r.read_line(&mut line).unwrap_or(0) > 0 {
                let q: Value = serde_json::from_str(&line).unwrap(); line.clear();
                writeln!(&c, "{}", serde_json::json!({"ok": {"fake": q["name"]}})).unwrap();
            }
        });
    }
    fn setup(access: bool) -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap(); let notes = tmp.path().join("notes"); std::fs::create_dir(&notes).unwrap();
        let p = tmp.path().join("settings.json");
        std::fs::write(&p, serde_json::json!({"agent_access": access, "notes_dir": notes}).to_string()).unwrap();
        let data = tmp.path().join("data"); (tmp, p, data, notes)
    }
    fn dead_pid() -> u32 { let mut c = std::process::Command::new("true").spawn().unwrap(); c.wait().unwrap(); c.id() }

    #[test] fn forwards_when_app_alive() {
        let (_t, p, data, notes) = setup(true); fake_app(&data, std::process::id(), true);
        let call = gate(p, data.clone());
        assert_eq!(call("list_tags", serde_json::json!({})), Ok(serde_json::json!({"fake": "list_tags"})));
        assert!(!std::fs::read_dir(&data).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("index-")), "no direct vault");
        drop(notes);
    }
    #[test] fn busy_when_pid_alive_but_unreachable() {
        let (_t, p, data, notes) = setup(true); fake_app(&data, std::process::id(), false); // listener dropped: port closed
        std::fs::write(notes.join("a.md"), "x").unwrap();
        let call = gate(p, data.clone());
        let args = serde_json::json!({"title": "a", "text": "y", "summary": "s"});
        let t = std::time::Instant::now();
        assert_eq!(call("append_to_note", args), Err("velo is busy, retry".to_string()));
        assert!(t.elapsed() >= std::time::Duration::from_secs(2));
        assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "x");
    }
    #[test] fn busy_on_token_mismatch() {
        let (_t, p, data, _n) = setup(true); fake_app(&data, std::process::id(), true);
        let j: Value = serde_json::from_slice(&std::fs::read(data.join("agent.json")).unwrap()).unwrap();
        std::fs::write(data.join("agent.json"), serde_json::json!({"port": j["port"], "token": "stale", "pid": j["pid"]}).to_string()).unwrap();
        assert_eq!(gate(p, data)("list_tags", serde_json::json!({})), Err("velo is busy, retry".to_string()));
    }
    #[test] fn direct_when_pid_dead_stale_file() {
        let (_t, p, data, notes) = setup(true); std::fs::write(notes.join("a.md"), "#t").unwrap();
        fake_app(&data, dead_pid(), true);
        assert_eq!(gate(p, data)("list_tags", serde_json::json!({})), Ok(serde_json::json!({"tags": [{"tag": "t", "count": 1}]})));
    }
    #[test] fn switches_mode_between_calls() {
        let (_t, p, data, notes) = setup(true); std::fs::write(notes.join("a.md"), "#t").unwrap();
        let call = gate(p, data.clone());
        let direct = serde_json::json!({"tags": [{"tag": "t", "count": 1}]});
        assert_eq!(call("list_tags", serde_json::json!({})), Ok(direct.clone()));
        fake_app(&data, std::process::id(), true); // velo starts
        assert_eq!(call("list_tags", serde_json::json!({})), Ok(serde_json::json!({"fake": "list_tags"})));
        std::fs::remove_file(data.join("agent.json")).unwrap(); // velo quits
        assert_eq!(call("list_tags", serde_json::json!({})), Ok(direct));
    }
    #[test] fn refuses_when_turned_off_mid_session() {
        let (_t, p, data, _n) = setup(true); fake_app(&data, std::process::id(), true);
        let call = gate(p.clone(), data);
        assert!(call("list_tags", serde_json::json!({})).is_ok());
        std::fs::write(&p, r#"{"agent_access":false}"#).unwrap();
        assert_eq!(call("list_tags", serde_json::json!({})), Err(OFF.to_string()));
    }

    /// The direct vault (and its SQLite handle) closes once access is off, and while the app owns the vault. SQLite
    /// removes the `-wal` file when its last connection closes, which makes the handle visible here.
    #[test] fn direct_vault_closes_when_off_or_forwarding() {
        let (_t, p, data, _n) = setup(true);
        let call = gate(p.clone(), data.clone());
        let wal = || std::fs::read_dir(&data).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with("-wal"));
        call("list_tags", serde_json::json!({})).unwrap();
        assert!(wal(), "open");
        std::fs::write(&p, r#"{"agent_access":false}"#).unwrap();
        assert_eq!(call("list_tags", serde_json::json!({})), Err(OFF.to_string()));
        assert!(!wal(), "closed when off");
        let (_t, p, data, _n) = setup(true);
        let call = gate(p, data.clone());
        call("list_tags", serde_json::json!({})).unwrap();
        fake_app(&data, std::process::id(), true);
        call("list_tags", serde_json::json!({})).unwrap();
        assert!(!std::fs::read_dir(&data).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with("-wal")), "closed while forwarding");
    }

    const NO_ANSWER: &str = "velo did not answer; the change may have been applied — read the note before retrying";
    #[test] fn no_reply_after_send_is_not_retried_nor_direct() {
        use std::io::{BufRead, BufReader, Write};
        let (_t, p, data, notes) = setup(true); std::fs::write(notes.join("a.md"), "x").unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        std::fs::write(data.join("agent.json"), serde_json::json!({"port": l.local_addr().unwrap().port(), "token": "tok", "pid": std::process::id()}).to_string()).unwrap();
        let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)); let s2 = seen.clone();
        std::thread::spawn(move || for c in l.incoming().flatten() {
            let (mut r, mut line) = (BufReader::new(c.try_clone().unwrap()), String::new());
            r.read_line(&mut line).unwrap(); writeln!(&c, r#"{{"ok":true}}"#).unwrap(); line.clear(); // auth accepted
            if r.read_line(&mut line).unwrap_or(0) > 0 { s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst); } // drop: close without reply
        });
        let r = gate(p, data)("append_to_note", serde_json::json!({"title": "a", "text": "y", "summary": "s"}));
        assert_eq!(r, Err(NO_ANSWER.to_string()));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "x");
    }
    /// The app runs with access on but its listener failed to start: it leaves a pid-only marker, so headless never
    /// writes beside it; once that pid is gone the marker is stale and headless goes direct.
    #[test] fn app_without_listener_is_busy_not_direct() {
        let (_t, p, data, notes) = setup(true); std::fs::write(notes.join("a.md"), "x").unwrap();
        std::fs::create_dir_all(&data).unwrap();
        listener::mark_running(&data).unwrap();
        let call = gate(p, data.clone());
        assert_eq!(call("append_to_note", serde_json::json!({"title": "a", "text": "y", "summary": "s"})), Err("velo is busy, retry".to_string()));
        assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "x");
        std::fs::write(data.join("agent.json"), serde_json::json!({"pid": dead_pid()}).to_string()).unwrap();
        assert!(call("append_to_note", serde_json::json!({"title": "a", "text": "y", "summary": "s"})).is_ok());
    }
    #[test] fn broken_agent_json_is_busy_not_direct() {
        for bad in ["not json", "{}", r#"{"port":1,"token":"t"}"#, r#"{"port":1,"token":"t","pid":0}"#, r#"{"port":1,"token":"t","pid":4294967295}"#, r#"{"token":"t","pid":1}"#] {
            let (_t, p, data, _n) = setup(true); std::fs::create_dir_all(&data).unwrap();
            std::fs::write(data.join("agent.json"), bad).unwrap();
            assert_eq!(gate(p, data)("list_tags", serde_json::json!({})), Err("velo is busy, retry".to_string()), "{bad}");
        }
    }
}
