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

const NO_ANSWER: &str = "velo did not answer; the change may have been applied — read the note before retrying";

enum Sent {
    /// Not dispatched (connect failed, unauthorized): safe to retry.
    No,
    /// Dispatched: never resend.
    Reply(Result<Value, String>),
}

/// `None` = no running app (no `agent.json`, or dead pid): work directly. `Some` = the app owns the vault. A file that
/// exists but is unusable counts as a running app (busy), never direct. Connect failures and `unauthorized` retry for 2 s,
/// then `BUSY`. Once a request is sent it is never resent and never goes direct: no usable reply gives `NO_ANSWER`.
pub fn forward(data_dir: &Path, name: &str, args: &Value) -> Option<Result<Value, String>> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // re-read each attempt: the app may have quit or restarted meanwhile
        let bytes = match std::fs::read(data_dir.join("agent.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => return Some(Err(BUSY.into())),
            Ok(b) => b,
        };
        let info: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let (Some(pid), Some(port)) = (info["pid"].as_u64().filter(|p| (1..=i32::MAX as u64).contains(p)), info["port"].as_u64().and_then(|p| u16::try_from(p).ok())) else {
            return Some(Err(BUSY.into()));
        };
        if !pid_alive(pid as u32) {
            return None;
        }
        if let Sent::Reply(r) = attempt(port, &info["token"], name, args) {
            return Some(r);
        }
        if Instant::now() >= deadline {
            return Some(Err(BUSY.into()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn attempt(port: u16, token: &Value, name: &str, args: &Value) -> Sent {
    let Ok(mut conn) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else { return Sent::No };
    // above the app's 5 s editor wait + 60 s claimed wait, with margin
    if conn.set_read_timeout(Some(Duration::from_secs(90))).is_err() {
        return Sent::No;
    }
    if writeln!(conn, "{}", json!({"token": token, "name": name, "args": args})).is_err() {
        return Sent::Reply(Err(NO_ANSWER.into()));
    }
    let mut line = String::new();
    let got = BufReader::new(conn).read_line(&mut line);
    let Some(mut reply) = got.ok().and_then(|_| serde_json::from_str::<Value>(&line).ok()) else { return Sent::Reply(Err(NO_ANSWER.into())) };
    if let Some(ok) = reply.get_mut("ok") {
        return Sent::Reply(Ok(ok.take()));
    }
    match reply.get("err").and_then(Value::as_str) {
        Some("unauthorized") => Sent::No, // rejected before dispatch; stale file from another run
        Some(e) => Sent::Reply(Err(e.into())),
        None => Sent::Reply(Err(NO_ANSWER.into())),
    }
}
