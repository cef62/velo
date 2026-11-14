//! Agent access: the headless `velo --mcp` MCP server (stdio).
pub mod app_ops;
pub mod client;
pub mod listener;
pub mod ops;
pub mod paths;
#[cfg(test)]
mod recipes;
pub mod server;
pub mod tools;

use ops::DirectOps;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) const OFF: &str = "Agent access is off — turn it on in velo Settings → General";

/// Arguments logged as they are: note titles. `date` too, but only when it is a valid YYYY-MM-DD date.
/// Every other string is logged as its size.
const TITLE_KEYS: [&str; 4] = ["title", "new_title", "source", "target"];

/// Tool errors logged verbatim: velo's own fixed messages, which carry no input.
const ERRORS: &[&str] = &[
    OFF, client::BUSY, client::NO_ANSWER, "unknown tool", "not found", "title is empty", "text is empty", "titles is required",
    "tags is required", "line is required", "summary is required: one line describing the change", "note changed since you read it",
    "tag only appears in code or a link", "task-moved", "same-note", "a note with that title already exists",
    "No notes folder set in velo", "the note is open in velo and can't be edited right now, retry",
    "note is open in velo with unsaved changes", "locked", "conflict", "empty", "invalid-title", "already-exists",
    "locked-sibling", "already encrypted", "not encrypted", "not a note in the notes folder",
];
/// Tool errors whose fixed opening words are followed by input (a tag, a date, a title, a count, a reply): only
/// these words are logged.
const ERROR_CLASSES: &[&str] = &[
    "invalid title", "invalid date", "invalid tag", "too many notes", "too many tags", "old_text must occur exactly once",
    "missing", "bad reply from velo's editor", "conflict: the note changed on disk", "not a note file",
];

/// The logged form of a tool error. Safe by construction: the result is a string literal from `ERRORS` or
/// `ERROR_CLASSES`, or `other (Nc)`. No part of the error text itself is copied, so an argument that a message quotes
/// (trimmed, case-folded, normalised, escaped, cut) can never reach the log. A new message logs as `other` until
/// it is listed. The archived-notes sentence `tools::call` appends on a second line is reported as `+archive list`.
fn error_class(e: &str) -> String {
    let (first, more) = e.split_once('\n').map_or((e, false), |(f, _)| (f, true));
    let more = if more { " +archive list" } else { "" };
    if let Some(m) = ERRORS.iter().find(|m| **m == first) {
        return format!("{m}{more}");
    }
    if let Some(c) = ERROR_CLASSES.iter().find(|c| first.starts_with(**c)) {
        return format!("{c} …{more}");
    }
    format!("other ({}c)", e.chars().count())
}

/// Runs one tool call (`f`) and, when `on`, writes its debug record (`record`).
pub(crate) fn logged(on: bool, route: &str, name: &str, args: Value, f: impl FnOnce(Value) -> Result<Value, String>) -> Result<Value, String> {
    if !on {
        return f(args);
    }
    let (desc, t) = (describe(name, &args), std::time::Instant::now());
    let r = f(args);
    record(route, &desc, &r, t);
    r
}

/// One debug record: route, tool, titles, the size of every other argument (bodies, queries, old/new text, task
/// lines, tags, summaries), outcome and duration. Never argument text: titles are the only argument strings printed,
/// and an error is printed only as its `error_class`.
fn record(route: &str, desc: &str, r: &Result<Value, String>, t: std::time::Instant) {
    let outcome = match r {
        Ok(_) => "ok".to_string(),
        Err(e) => format!("err {}", error_class(e)),
    };
    crate::log::debug_when(true, &format!("agent {route} {desc} -> {outcome} in {}ms", t.elapsed().as_millis()));
}

/// The tool name (when it is a known tool: an unknown name may itself be text) and its arguments as titles and sizes.
fn describe(name: &str, a: &Value) -> String {
    let Some(spec) = tools::TOOL_SPECS.iter().find(|t| t.name == name) else { return "(unknown tool)".into() };
    let schema: Value = serde_json::from_str(spec.input_schema).unwrap_or_default();
    let known = schema["properties"].as_object();
    let Some(o) = a.as_object() else { return format!("{} (no arguments object)", spec.name) };
    let mut out = vec![spec.name.to_string()];
    let mut unknown = 0;
    for (k, v) in o {
        // a key outside the schema may itself be text: printed only as a count
        let Some((k, _)) = known.and_then(|p| p.get_key_value(k)) else {
            unknown += 1;
            continue;
        };
        out.push(match v {
            Value::String(s) if TITLE_KEYS.contains(&k.as_str()) => format!("{k}={:?}", s.chars().take(255).collect::<String>()),
            Value::String(s) if k == "date" && tools::valid_date(s).is_ok() => format!("{k}={s}"),
            Value::String(s) => format!("{k}={}c", s.chars().count()),
            Value::Array(x) => format!("{k}=[{}]", x.len()),
            Value::Bool(_) | Value::Number(_) => format!("{k}={v}"),
            _ => format!("{k}=?"),
        });
    }
    if unknown > 0 {
        out.push(format!("+{unknown} unknown"));
    }
    out.join(" ")
}

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
    // the app's velo.log: warnings, panics and (Debug logging on) direct-mode tool calls land beside the app's lines
    if let Some(dir) = paths::log_dir() {
        crate::log::init(&dir, "--mcp".into());
    }
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
        let (desc, t) = (s.debug_log.then(|| describe(name, &args)), std::time::Instant::now());
        if let Some(r) = client::forward(&data_dir, name, &args) {
            *ops.lock().unwrap_or_else(|e| e.into_inner()) = None; // the app owns the index while it runs
            // the app records each call it answered; one it never answered is recorded here
            if let (Some(d), Err(e)) = (&desc, &r)
                && (e == client::BUSY || e == client::NO_ANSWER)
            {
                record("app-unanswered", d, &r, t);
            }
            return r;
        }
        let r = (|| -> Result<Value, String> {
            // the app may have quit, or access gone off, since the check above: read the switch again before writing
            let s = crate::settings::load(&settings_path);
            if !s.agent_access {
                *ops.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return Err(OFF.into());
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
            if let Err(e) = ops.rescan() {
                eprintln!("velo --mcp: rescan of the notes folder failed: {e}"); // the call goes on with the index as it is
            }
            let r = tools::call(ops, name, args);
            ops.vault.archive_error.take(); // reported in the reply; the next call starts clean
            r
        })();
        // setup failures (no folder, the vault would not open) are recorded too, and the duration includes setup
        if let Some(d) = &desc {
            record("direct", d, &r, t);
        }
        r
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
            assert!(paths::log_dir().unwrap().ends_with("Library/Logs/dev.velo.app"));
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
    #[test] fn gate_routes_get_connections() {
        let (_t, p, data, notes) = setup(true);
        std::fs::write(notes.join("a.md"), "[[b]]").unwrap();
        std::fs::write(notes.join("b.md"), "").unwrap();
        let call = gate(p, data.clone());
        assert_eq!(call("get_connections", serde_json::json!({"title": "a"})).unwrap()["links_out"][0]["title"], "b");
        fake_app(&data, std::process::id(), true);
        assert_eq!(call("get_connections", serde_json::json!({"title": "a"})), Ok(serde_json::json!({"fake": "get_connections"})));
    }
    #[test] fn gate_routes_merge_notes() {
        let (_t, p, data, notes) = setup(true);
        std::fs::write(notes.join("a.md"), "a\n").unwrap();
        std::fs::write(notes.join("b.md"), "b\n").unwrap();
        assert!(tools::TOOL_SPECS.iter().any(|t| t.name == "merge_notes"));
        let call = gate(p, data.clone());
        // passes the gate: the handler answers (same-note), not "unknown tool"
        assert_eq!(call("merge_notes", serde_json::json!({"source": "a", "target": "a", "summary": "s"})), Err("same-note".to_string()));
        fake_app(&data, std::process::id(), true);
        assert_eq!(call("merge_notes", serde_json::json!({"source": "a", "target": "b", "summary": "s"})), Ok(serde_json::json!({"fake": "merge_notes"})));
    }
    /// #95: direct mode reports a failed list write to the call that caused it, and never to the next one.
    #[test] fn gate_reports_a_failed_list_write_once() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, p, data, notes) = setup(true);
        std::fs::write(notes.join("a.md"), "x").unwrap();
        std::fs::create_dir(notes.join(".velo")).unwrap();
        std::fs::write(notes.join(".velo/archived"), "a\n").unwrap();
        let call = gate(p, data);
        call("list_tags", serde_json::json!({})).unwrap(); // the vault opens with the list readable
        std::fs::set_permissions(notes.join(".velo"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let r = call("rename_note", serde_json::json!({"title": "a", "new_title": "b", "rewrite_links": false, "summary": "s"}));
        std::fs::set_permissions(notes.join(".velo"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(r.unwrap()["warning"].as_str().unwrap().contains(".velo/archived"));
        assert!(call("read_note", serde_json::json!({"title": "b"})).unwrap().get("warning").is_none());
        assert!(call("list_tags", serde_json::json!({})).unwrap().get("warning").is_none());
    }
    #[test] fn direct_when_pid_alive_but_port_refused_stale_file() {
        // a stale agent.json whose pid was reused: nothing listens, so there is no app to wait for
        let (_t, p, data, notes) = setup(true); fake_app(&data, std::process::id(), false); // listener dropped: port closed
        std::fs::write(notes.join("a.md"), "x").unwrap();
        let args = serde_json::json!({"title": "a", "text": "y", "summary": "s"});
        assert!(gate(p, data)("append_to_note", args).is_ok());
        assert_ne!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "x");
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

    /// Access turned off while a request is in flight: the app's stopped listener refuses it, settings say off and
    /// agent.json is gone. The request was sent, so it must never be resent nor go direct beside the running app.
    #[test] fn off_mid_request_never_goes_direct() {
        use std::io::{BufRead, BufReader, Write};
        let (_t, p, data, notes) = setup(true); std::fs::write(notes.join("a.md"), "x").unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        std::fs::write(data.join("agent.json"), serde_json::json!({"port": l.local_addr().unwrap().port(), "token": "tok", "pid": std::process::id()}).to_string()).unwrap();
        let (p2, d2) = (p.clone(), data.clone());
        std::thread::spawn(move || for c in l.incoming().flatten() {
            let (mut r, mut line) = (BufReader::new(c.try_clone().unwrap()), String::new());
            r.read_line(&mut line).unwrap(); writeln!(&c, r#"{{"ok":true}}"#).unwrap(); line.clear();
            r.read_line(&mut line).unwrap();
            std::fs::write(&p2, r#"{"agent_access":false}"#).unwrap(); // set_settings saves off
            std::fs::remove_file(d2.join("agent.json")).ok(); // stop() deletes agent.json
            writeln!(&c, r#"{{"err":"unauthorized"}}"#).unwrap(); // an older app's stopped handler
        });
        let r = gate(p, data)("append_to_note", serde_json::json!({"title": "a", "text": "y", "summary": "s"}));
        assert!(r.is_err(), "{r:?}");
        assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "x");
    }
    /// Access turned off and the app's agent.json removed while headless retries the connection: settings are read
    /// again before going direct.
    #[test] fn off_while_retrying_is_refused_not_direct() {
        let (_t, p, data, notes) = setup(true); std::fs::write(notes.join("a.md"), "x").unwrap();
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap(); // pid alive, listener never answers: forward retries
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("agent.json"), serde_json::json!({"port": l.local_addr().unwrap().port(), "token": "t", "pid": std::process::id()}).to_string()).unwrap();
        std::thread::spawn(move || for c in l.incoming() { drop(c) });
        let (p2, d2) = (p.clone(), data.clone());
        let t = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::fs::write(&p2, r#"{"agent_access":false}"#).unwrap();
            std::fs::remove_file(d2.join("agent.json")).unwrap();
        });
        let r = gate(p, data)("append_to_note", serde_json::json!({"title": "a", "text": "y", "summary": "s"}));
        t.join().unwrap();
        assert_eq!(r, Err(OFF.to_string()));
        assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "x");
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

    /// #138 privacy rule: with Debug logging on, every tool call is recorded with titles and sizes, never the text
    /// of an argument (bodies, queries, old/new text, task lines, tags, summaries), also when an error quotes it.
    #[test] fn debug_records_never_carry_argument_text() {
        use serde_json::json;
        const M: &str = "zqmarker";
        let (_t, p, data, notes) = setup(true);
        std::fs::write(&p, json!({"agent_access": true, "notes_dir": notes, "debug_log": true}).to_string()).unwrap();
        std::fs::write(notes.join("a.md"), "- [ ] task\n").unwrap();
        let calls = [
            ("search_notes", json!({"query": M, "tags": [M]})),
            ("list_tags", json!({})),
            ("read_note", json!({"title": "a", M: M})), // a key outside the schema
            ("create_note", json!({"title": "c", "text": M, "summary": M})),
            ("append_to_note", json!({"title": "a", "text": M, "summary": M})),
            ("edit_note", json!({"title": "a", "old_text": M, "new_text": format!("{M}2"), "summary": M})),
            ("edit_note", json!({"title": "a", "old_text": "absent", "new_text": M, "summary": M})),
            ("replace_note", json!({"title": "c", "text": M, "expected_hash": "stale", "summary": M})),
            ("add_tags", json!({"titles": ["a"], "tags": [M, format!("bad {M}")], "summary": M})), // "invalid tag: …" quotes it
            ("add_tags", json!({"titles": ["a"], "tags": [M], "summary": M})),
            ("remove_tags", json!({"titles": ["a"], "tags": [M], "summary": M})),
            ("list_tasks", json!({"query": M, "tags": [M]})),
            ("add_task", json!({"title": "a", "text": M, "due": "2030-01-01", "summary": M})),
            ("set_task_done", json!({"title": "a", "line": 0, "line_text": M, "done": true, "summary": M})),
            ("rename_note", json!({"title": "c", "new_title": "c2", "rewrite_links": false, "summary": M})),
            ("move_to_trash", json!({"title": "nope", "summary": M})),
            ("merge_notes", json!({"source": "nope", "target": "a", "summary": M})),
            ("get_connections", json!({"title": "a"})),
            ("daily_note", json!({"date": "2030-01-02", "summary": M})),
            // round 1, M1: the error quotes a transformed tag (trimmed, `#` stripped), never the argument as given
            ("add_tags", json!({"titles": ["a"], "tags": [format!("#{M} diagnosis")], "summary": "s"})),
            ("add_tags", json!({"titles": ["a"], "tags": [format!("  {M} diagnosis  ")], "summary": "s"})),
            ("remove_tags", json!({"titles": ["a"], "tags": [format!(" #ZQ{} x ", &M[2..].to_uppercase())], "summary": "s"})),
            ("search_notes", json!({"query": format!("\"{M} NEAR( * -\" OR"), "tags": []})), // FTS5 metacharacters
            ("edit_note", json!({"title": "a", "old_text": "zqma\u{308}rker\r\n", "new_text": " zqmarker ", "summary": "s"})), // NFD, not found
            ("daily_note", json!({"date": format!("{M} body"), "summary": "s"})), // an invalid date is a size, not a title
            ("search_notes", json!({"type": M, "properties": M})), // JSON Schema words are not argument names
            ("add_tags", json!({"titles": ["a"], "tags": ["x", "1 "], "summary": "s"})), // one-character values
        ];
        let call = gate(p, data);
        let lines = crate::log::tests::capture(|| for (name, args) in &calls { call(name, args.clone()).ok(); });
        assert_eq!(lines.len(), calls.len(), "{lines:#?}");
        for (l, (name, _)) in lines.iter().zip(&calls) {
            assert!(l.starts_with(&format!("debug: agent direct {name} ")), "{l}");
            assert!(!l.to_lowercase().contains("zq"), "{l}"); // every variant of the marker starts with zq
        }
        assert!(lines[3].contains(r#"create_note summary=8c text=8c title="c" -> ok in "#), "{}", lines[3]);
        assert!(lines[8].contains("-> err invalid tag … in "), "{}", lines[8]);
        assert!(lines[2].contains("+1 unknown"), "{}", lines[2]);
        assert!(lines[6].contains("-> err old_text must occur exactly once … in "), "{}", lines[6]);
        assert!(lines[7].contains("-> err note changed since you read it in "), "{}", lines[7]);
        assert!(lines[18].contains("date=2030-01-02 "), "{}", lines[18]);
        assert!(lines[24].contains("date=13c ") && lines[24].contains("err invalid date …"), "{}", lines[24]);
        assert!(lines[25].contains("+2 unknown") && !lines[25].contains("type="), "{}", lines[25]);
        assert!(lines[26].contains("-> err invalid tag … in "), "{}", lines[26]);
        // an app-forwarded call names no tool it does not know, and copies no error text
        let l = crate::log::tests::capture(|| { logged(true, "app", M, json!({"text": M}), |_| Err(format!("boom {M}\nend"))).ok(); });
        assert_eq!(l.len(), 1);
        assert!(l[0].starts_with("debug: agent app (unknown tool) -> err other (") && !l[0].contains(M), "{}", l[0]);
        assert!(crate::log::tests::capture(|| { logged(false, "app", "list_tags", json!({}), |_| Ok(json!({}))).ok(); }).is_empty());
    }

    /// A setup failure in direct mode (no notes folder) is recorded too.
    #[test] fn debug_records_direct_setup_failures() {
        let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("settings.json");
        std::fs::write(&p, r#"{"agent_access":true,"debug_log":true}"#).unwrap();
        let call = gate(p, tmp.path().join("data"));
        let l = crate::log::tests::capture(|| { call("read_note", serde_json::json!({"title": "a"})).ok(); });
        assert_eq!(l.len(), 1, "{l:?}");
        assert!(l[0].starts_with(r#"debug: agent direct read_note title="a" -> err No notes folder set in velo in "#), "{}", l[0]);
    }

    /// Every fixed message logs as itself; anything else copies none of its text.
    #[test] fn error_class_copies_only_literals() {
        for m in ERRORS { assert_eq!(&error_class(m), m); }
        assert_eq!(error_class("invalid tag: secret"), "invalid tag …");
        assert_eq!(error_class("missing text"), "missing …");
        assert_eq!(error_class("not found\nThe archived-notes list (.velo/archived) was not updated either: secret"), "not found +archive list");
        assert_eq!(error_class(&ops::conflict_copy("/n/secret (conflict).md").to_string()), "conflict: the note changed on disk …");
        assert_eq!(error_class("fts5: syntax error near \"secret\""), "other (32c)");
        assert_eq!(error_class("notfound"), "other (8c)");
    }
}
