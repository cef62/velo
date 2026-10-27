//! Headless side of the loopback protocol (see `listener`): forward a tool call to the running app.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

pub(crate) const BUSY: &str = "velo is busy, retry";

pub fn pid_alive(pid: u32) -> bool {
    // EPERM still means the process exists
    unsafe { libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// `None` = no running app (no file, or dead pid): work directly. `Some` = the app owns the vault; its reply, or
/// `BUSY` after 2 s of failed attempts (unreachable, wrong token, no reply). Never falls back to direct while the pid lives.
pub fn forward(data_dir: &Path, name: &str, args: &Value) -> Option<Result<Value, String>> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // re-read each attempt: the app may have quit or restarted meanwhile
        let info: Value = serde_json::from_slice(&std::fs::read(data_dir.join("agent.json")).ok()?).ok()?;
        if !pid_alive(info["pid"].as_u64()? as u32) {
            return None;
        }
        if let Some(r) = attempt(&info, name, args) {
            return Some(r);
        }
        if Instant::now() >= deadline {
            return Some(Err(BUSY.into()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn attempt(info: &Value, name: &str, args: &Value) -> Option<Result<Value, String>> {
    let port = info["port"].as_u64()? as u16;
    let mut conn = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)).ok()?;
    // longer than the app's own 5 s editor wait, so its busy error arrives first
    conn.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    writeln!(conn, "{}", json!({"token": info["token"], "name": name, "args": args})).ok()?;
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).ok()?;
    let mut reply: Value = serde_json::from_str(&line).ok()?;
    if let Some(ok) = reply.get_mut("ok") {
        return Some(Ok(ok.take()));
    }
    match reply.get("err").and_then(Value::as_str)? {
        "unauthorized" => None, // stale file from another run: treat as busy
        e => Some(Err(e.into())),
    }
}
