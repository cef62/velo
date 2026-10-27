//! The running app's side of agent access: a loopback listener the headless `velo --mcp` forwards tool calls to.
//! `<app data>/agent.json` (mode 0600) holds `{port, token, pid}`. Each request is one line of JSON
//! `{token, name, args}`; each reply one line `{ok: value}` or `{err: message}`. A wrong token gets
//! `{err:"unauthorized"}` and the connection is closed.
use super::app_ops::{AppOps, EDITOR_TIMEOUT, Editors};
use crate::commands::AppState;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

pub type Dispatch = Arc<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;

/// Longest request line read; anything longer fails to parse and is refused.
const MAX_REQUEST: u64 = 64 << 20;

/// Managed app state: the running listener (while agent access is on) and the writes awaiting the editor.
#[derive(Default)]
pub struct AgentState {
    pub listener: Mutex<Option<ListenerHandle>>,
    pub editors: Editors,
}

pub struct ListenerHandle {
    file: PathBuf,
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl ListenerHandle {
    /// Deletes `agent.json` and closes the socket. Connections already open stay up until their client hangs up, and
    /// every call they make is still checked against `agent_access`.
    pub fn stop(mut self) {
        std::fs::remove_file(&self.file).ok();
        self.stop.store(true, Ordering::SeqCst);
        // wakes the blocking accept; if that fails, don't join (it would hang the caller): the loop exits on its next
        // connection, refusing it
        let woke = TcpStream::connect_timeout(&self.addr, std::time::Duration::from_secs(1)).is_ok();
        if let Some(t) = self.accept.take()
            && woke
        {
            t.join().ok();
        }
    }
}

/// Starts the listener over the app's state: each request runs one MCP tool on `AppOps`.
pub fn start(app: AppHandle) -> anyhow::Result<ListenerHandle> {
    let dir = app.state::<AppState>().data_dir.clone();
    serve(&dir, Arc::new(move |name: &str, args: Value| {
        let st = app.state::<AppState>();
        // the listener stops when access is turned off, but a call racing the switch must still be refused
        if !st.settings.lock().unwrap().agent_access {
            return Err(super::OFF.into());
        }
        let agent = app.state::<AgentState>();
        let route = |req: Value| agent.editors.ask(req, |r| { app.emit("agent-write", r).ok(); }, EDITOR_TIMEOUT);
        super::tools::call(&mut AppOps::new(&st, &route), name, args)
    }))
}

/// Starts or stops the listener in `slot` to match `on`; `start` runs only when turning it on.
pub fn set_access(slot: &Mutex<Option<ListenerHandle>>, on: bool, start: impl FnOnce() -> anyhow::Result<ListenerHandle>) -> anyhow::Result<()> {
    let mut s = slot.lock().unwrap();
    match (on, s.is_some()) {
        (true, false) => *s = Some(start()?),
        (false, true) => s.take().expect("checked").stop(),
        _ => {}
    }
    Ok(())
}

/// Binds `127.0.0.1:0`, writes `<data_dir>/agent.json` and serves each connection on its own thread.
pub fn serve(data_dir: &Path, dispatch: Dispatch) -> anyhow::Result<ListenerHandle> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let addr = listener.local_addr()?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("no randomness for the agent token: {e}"))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let file = data_dir.join("agent.json");
    write_private(&file, json!({"port": addr.port(), "token": token, "pid": std::process::id()}).to_string().as_bytes())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let accept = std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else { continue };
            let (token, dispatch) = (token.clone(), dispatch.clone());
            std::thread::spawn(move || handle(conn, &token, &dispatch).ok());
        }
    });
    Ok(ListenerHandle { file, addr, stop, accept: Some(accept) })
}

fn handle(conn: TcpStream, token: &str, dispatch: &Dispatch) -> std::io::Result<()> {
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut out = conn;
    loop {
        let mut line = String::new();
        if (&mut reader).take(MAX_REQUEST).read_line(&mut line)? == 0 {
            return Ok(());
        }
        let req: Value = serde_json::from_str(&line).unwrap_or_default();
        if !same(req.get("token").and_then(Value::as_str).unwrap_or(""), token) {
            return writeln!(out, "{}", json!({"err": "unauthorized"}));
        }
        let name = req.get("name").and_then(Value::as_str).unwrap_or("");
        let reply = match dispatch(name, req.get("args").cloned().unwrap_or_else(|| json!({}))) {
            Ok(v) => json!({"ok": v}),
            Err(e) => json!({"err": e}),
        };
        writeln!(out, "{reply}")?;
    }
}

/// Constant-time comparison, so response timing does not leak the token.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Atomic write of a file only the user can read (0600 on unix, set at creation so it is never wider).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::remove_file(&tmp).ok(); // a leftover could carry wider permissions
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let r = o.open(&tmp).and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all())).and_then(|_| std::fs::rename(&tmp, path));
    if r.is_err() {
        std::fs::remove_file(&tmp).ok();
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    fn echo() -> Dispatch {
        Arc::new(|name: &str, args: Value| Ok(json!({"name": name, "args": args})))
    }

    fn info(dir: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(dir.join("agent.json")).unwrap()).unwrap()
    }

    fn ask(s: &mut TcpStream, req: Value) -> String {
        writeln!(s, "{req}").unwrap();
        let mut line = String::new();
        BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
        line
    }

    #[test] fn listener_rejects_bad_token() {
        let t = tempfile::tempdir().unwrap();
        let h = serve(t.path(), echo()).unwrap();
        let a = info(t.path());
        let port = a["port"].as_u64().unwrap() as u16;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert_eq!(ask(&mut s, json!({"token": "nope", "name": "list_tags", "args": {}})).trim(), r#"{"err":"unauthorized"}"#);
        let mut rest = String::new();
        assert_eq!(BufReader::new(s).read_line(&mut rest).unwrap(), 0, "connection closed");
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let ok = ask(&mut s, json!({"token": a["token"], "name": "list_tags", "args": {"x": 1}}));
        assert_eq!(serde_json::from_str::<Value>(&ok).unwrap(), json!({"ok": {"name": "list_tags", "args": {"x": 1}}}));
        let again = ask(&mut s, json!({"token": a["token"], "name": "b", "args": {}})); // same connection, next request
        assert_eq!(serde_json::from_str::<Value>(&again).unwrap()["ok"]["name"], "b");
        h.stop();
    }

    #[test] fn agent_json_mode_0600_and_removed_on_stop() {
        let t = tempfile::tempdir().unwrap();
        let h = serve(t.path(), echo()).unwrap();
        let f = t.path().join("agent.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let a = info(t.path());
        let token = a["token"].as_str().unwrap();
        assert!(token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a["pid"], std::process::id());
        let port = a["port"].as_u64().unwrap() as u16;
        h.stop();
        assert!(!f.exists());
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "socket closed");
    }

    #[test] fn toggling_access_off_stops_listener_and_removes_file() {
        let t = tempfile::tempdir().unwrap();
        let slot = Mutex::new(None);
        set_access(&slot, true, || serve(t.path(), echo())).unwrap();
        let port = info(t.path())["port"].as_u64().unwrap() as u16;
        set_access(&slot, true, || panic!("already running")).unwrap();
        set_access(&slot, false, || panic!("not started when off")).unwrap();
        assert!(!t.path().join("agent.json").exists());
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(slot.lock().unwrap().is_none());
    }
}
