//! The running app's side of agent access: a loopback listener the headless `velo --mcp` forwards tool calls to.
//! `<app data>/agent.json` (mode 0600) holds `{port, token, pid}`. A connection starts with one short line
//! `{token}`, answered `{ok: true}`; then each request is one line of JSON `{name, args}` and each reply one line `{ok: value}` or
//! `{err: message}`. A wrong token gets `{err:"unauthorized"}` and the connection is closed.
use super::app_ops::{AppOps, Editors, with_route};
use crate::commands::AppState;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub type Dispatch = Arc<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;

/// Longest request line read; anything longer fails to parse and is refused.
const MAX_REQUEST: u64 = 64 << 20;
/// Longest auth line, and how long a new connection may take to send it.
const MAX_AUTH: u64 = 256;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an authenticated connection may sit between requests (the headless client sends its one request at once).
const IDLE_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 30 });
/// Connections served at once; more are closed right away, so a local flood can't exhaust threads or fds.
const MAX_CONNS: usize = 8;

/// Managed app state: the running listener (while agent access is on) and the writes awaiting the editor.
#[derive(Default)]
pub struct AgentState {
    pub listener: Mutex<Option<ListenerHandle>>,
    pub editors: Editors,
}

pub struct ListenerHandle {
    file: PathBuf,
    token: String,
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl ListenerHandle {
    /// Deletes `agent.json` and closes the socket. Connections already open stay up until their client hangs up, and
    /// every call they make is still checked against `agent_access`.
    pub fn stop(mut self) {
        // another velo instance may have written its own file since: leave that one alone
        let ours = std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|j| j["token"] == self.token.as_str());
        if ours {
            std::fs::remove_file(&self.file).ok();
        }
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
    // no 0600 agent.json there, and `velo --mcp` refuses to run: the Settings switch stays off with this message
    if cfg!(not(unix)) {
        anyhow::bail!("Agent access is not supported on Windows yet");
    }
    let dir = app.state::<AppState>().data_dir.clone();
    serve(&dir, Arc::new(move |name: &str, args: Value| {
        let st = app.state::<AppState>();
        // the listener stops when access is turned off, but a call racing the switch must still be refused
        if !st.settings.lock().unwrap().agent_access {
            return Err(super::OFF.into());
        }
        let agent = app.state::<AgentState>();
        let emit = |r: Value| { app.emit("agent-write", r).ok(); };
        with_route(&agent.editors, &emit, |route, release| {
            let mut ops = AppOps::new(&st, route);
            ops.release = release;
            let r = super::tools::call(&mut ops, name, args);
            // the watcher drops the backend's own writes: refresh the UI as for an outside change
            if !ops.touched.is_empty() {
                app.emit("notes-changed", json!({ "paths": ops.touched })).ok();
            }
            r
        })
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
    let tok = token.clone();
    let live = Arc::new(AtomicUsize::new(0));
    let accept = std::thread::Builder::new().spawn(move || {
        for conn in listener.incoming() {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else {
                std::thread::sleep(Duration::from_millis(100)); // e.g. out of fds: don't spin
                continue;
            };
            if live.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
                live.fetch_sub(1, Ordering::SeqCst);
                continue; // dropped: closed
            }
            let (token, dispatch, done, stop) = (tok.clone(), dispatch.clone(), live.clone(), stopped.clone());
            // a failed spawn drops the closure (and the connection) instead of panicking
            if std::thread::Builder::new().spawn(move || { handle(conn, &token, &dispatch, &stop).ok(); done.fetch_sub(1, Ordering::SeqCst); }).is_err() {
                live.fetch_sub(1, Ordering::SeqCst);
            }
        }
    });
    let accept = match accept {
        Ok(t) => t,
        Err(e) => {
            std::fs::remove_file(&file).ok();
            return Err(e.into());
        }
    };
    Ok(ListenerHandle { file, token, addr, stop, accept: Some(accept) })
}

/// The auth line, read byte by byte (the client sends nothing more until it is answered) within `AUTH_TIMEOUT` of
/// the accept in total, so a client trickling bytes can't hold a slot.
fn auth_line(conn: &TcpStream) -> std::io::Result<Vec<u8>> {
    let deadline = Instant::now() + AUTH_TIMEOUT;
    let (mut line, mut b) = (Vec::new(), [0u8; 1]);
    while (line.len() as u64) < MAX_AUTH && !line.ends_with(b"\n") {
        let left = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()).ok_or(std::io::ErrorKind::TimedOut)?;
        conn.set_read_timeout(Some(left))?;
        if (&*conn).read(&mut b)? == 0 {
            break;
        }
        line.push(b[0]);
    }
    Ok(line)
}

/// `stop`: this listener was stopped (access turned off, maybe on again with a new token): requests on connections
/// it authenticated are refused undispatched with the access-off message.
fn handle(conn: TcpStream, token: &str, dispatch: &Dispatch, stop: &AtomicBool) -> std::io::Result<()> {
    let auth: Value = serde_json::from_slice(&auth_line(&conn)?).unwrap_or_default();
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut out = conn;
    if !same(auth.get("token").and_then(Value::as_str).unwrap_or(""), token) {
        return writeln!(out, "{}", json!({"err": "unauthorized"}));
    }
    writeln!(out, "{}", json!({"ok": true}))?;
    out.set_read_timeout(Some(IDLE_TIMEOUT))?;
    loop {
        let mut line = String::new();
        if (&mut reader).take(MAX_REQUEST).read_line(&mut line)? == 0 {
            return Ok(());
        }
        if stop.load(Ordering::SeqCst) {
            // final, not retryable: a retry would find agent.json gone and could go direct beside the running app
            return writeln!(out, "{}", json!({"err": super::OFF}));
        }
        let req: Value = serde_json::from_str(&line).unwrap_or_default();
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

/// Startup could not start the listener while access is on: an `agent.json` with only this pid tells `velo --mcp`
/// the app is running (busy, never a second writer). The next listener start overwrites it.
pub fn mark_running(data_dir: &Path) -> std::io::Result<()> {
    write_private(&data_dir.join("agent.json"), json!({"pid": std::process::id()}).to_string().as_bytes())
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

// the listener never starts on Windows (see `start`), and these tests lean on Unix socket behaviour
#[cfg(all(test, unix))]
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
        assert_eq!(ask(&mut s, json!({"token": "nope"})).trim(), r#"{"err":"unauthorized"}"#);
        let mut rest = String::new();
        assert_eq!(BufReader::new(s).read_line(&mut rest).unwrap(), 0, "connection closed");
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert_eq!(ask(&mut s, json!({"token": a["token"]})).trim(), r#"{"ok":true}"#);
        let ok = ask(&mut s, json!({"name": "list_tags", "args": {"x": 1}}));
        assert_eq!(serde_json::from_str::<Value>(&ok).unwrap(), json!({"ok": {"name": "list_tags", "args": {"x": 1}}}));
        let again = ask(&mut s, json!({"name": "b", "args": {}})); // same connection, next request
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

    #[test] fn stop_leaves_another_instances_file() {
        let t = tempfile::tempdir().unwrap();
        let first = serve(t.path(), echo()).unwrap();
        let second = serve(t.path(), echo()).unwrap(); // a second velo overwrote agent.json
        let theirs = info(t.path());
        first.stop();
        assert_eq!(info(t.path()), theirs, "the live instance's file is kept");
        second.stop();
        assert!(!t.path().join("agent.json").exists());
    }

    #[test] fn flood_is_capped_and_pre_auth_lines_are_bounded() {
        let t = tempfile::tempdir().unwrap();
        let h = serve(t.path(), echo()).unwrap();
        let a = info(t.path());
        let port = a["port"].as_u64().unwrap() as u16;
        let closed = |s: TcpStream| {
            s.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
            let mut l = String::new();
            BufReader::new(s).read_line(&mut l).map_or(true, |n| n == 0 || l.contains("unauthorized"))
        };
        // an auth line over the limit is cut off and refused at once
        let mut big = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(big, "{}", "x".repeat(4096)).unwrap();
        let t0 = std::time::Instant::now();
        assert!(closed(big));
        assert!(t0.elapsed() < std::time::Duration::from_secs(2));
        // idle connections fill the cap; one more is closed at once
        let idle: Vec<TcpStream> = (0..MAX_CONNS).map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap()).collect();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let t0 = std::time::Instant::now();
        assert!(closed(TcpStream::connect(("127.0.0.1", port)).unwrap()));
        assert!(t0.elapsed() < AUTH_TIMEOUT, "refused, not served");
        // idle ones time out before auth, freeing the slots
        assert!(idle.into_iter().all(closed));
        std::thread::sleep(std::time::Duration::from_millis(200));
        // a client trickling bytes is cut off AUTH_TIMEOUT after the accept, not after its last byte
        let mut slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let t0 = std::time::Instant::now();
        let trickle = std::thread::spawn({
            let mut s = slow.try_clone().unwrap();
            move || while s.write_all(b" ").is_ok() && t0.elapsed() < AUTH_TIMEOUT * 3 { std::thread::sleep(std::time::Duration::from_millis(500)); }
        });
        slow.set_read_timeout(Some(AUTH_TIMEOUT * 3)).unwrap();
        let mut l = String::new();
        let _ = BufReader::new(&mut slow).read_line(&mut l);
        assert!(t0.elapsed() < AUTH_TIMEOUT + std::time::Duration::from_secs(2), "closed after {:?}", t0.elapsed());
        drop(slow);
        trickle.join().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert_eq!(ask(&mut s, json!({"token": a["token"]})).trim(), r#"{"ok":true}"#);
        h.stop();
    }

    /// After off (and on again), a connection authenticated with the old token gets nothing more dispatched, and an
    /// authenticated connection that goes idle is closed so it can't hold a slot.
    #[test] fn old_and_idle_connections_are_closed() {
        let t = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let c2 = calls.clone();
        let h = serve(t.path(), Arc::new(move |_: &str, _: Value| { c2.fetch_add(1, Ordering::SeqCst); Ok(json!(1)) })).unwrap();
        let a = info(t.path());
        let port = a["port"].as_u64().unwrap() as u16;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert_eq!(ask(&mut s, json!({"token": a["token"]})).trim(), r#"{"ok":true}"#);
        let mut idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert_eq!(ask(&mut idle, json!({"token": a["token"]})).trim(), r#"{"ok":true}"#);
        h.stop();
        assert_eq!(serde_json::from_str::<Value>(&ask(&mut s, json!({"name": "x", "args": {}}))).unwrap(), json!({"err": crate::agent::OFF}));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "not dispatched");
        idle.set_read_timeout(Some(IDLE_TIMEOUT * 3)).unwrap();
        let t0 = Instant::now();
        let mut l = String::new();
        assert_eq!(BufReader::new(idle).read_line(&mut l).unwrap_or(0), 0, "closed");
        assert!(t0.elapsed() < IDLE_TIMEOUT * 2);
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
