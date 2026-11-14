// Window records for velo.log (`log_line`, src-tauri/src/log.rs). Errors and warnings always reach the file; debug
// records only while Settings → Debug logging is on. Privacy rule (#138): titles and sizes, never note text, search
// text or a passphrase. An error is logged only by `errorText`, which copies no text from the error itself.
import { invoke } from "@tauri-apps/api/core";

/** Longest record forwarded; the backend cuts again at its own limit. */
export const MAX = 500;
/** At most BURST error and warning records per WINDOW_MS; the rest are counted and reported in one line. */
export const BURST = 20;
export const WINDOW_MS = 10_000;

let debugOn = false;
export const setDebugLog = (on: boolean) => void (debugOn = on);
export const debugLogOn = () => debugOn;

/** One line (whitespace runs, line separators included, become one space), at most MAX chars. */
export const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX);

/** Error codes velo's backend returns (src-tauri `Err("…")`, `err()`): logged as they are. */
const CODES = new Set(["already-exists", "conflict", "empty", "indexing", "invalid-title", "locked", "locked-sibling", "mention-moved", "no-folder", "no-identity", "not-found", "same-note", "task-moved", "wrong-passphrase"]);

/**
 * The logged form of an error. Safe by construction: only a known backend code, an Error's class name, the
 * script location it was thrown at (an app URL) and sizes. A message may quote anything (a query, a line of a note),
 * so it is only measured; the full error stays in the console.
 */
export function errorText(e: unknown): string {
  if (typeof e === "string") return CODES.has(e) ? e : `other (${e.length}c)`;
  if (e instanceof Error) {
    const name = /^\w{1,40}$/.test(e.name) ? e.name : "Error";
    const at = /(?:https?|tauri|file):\/\/[\w./%:-]+:\d+:\d+/.exec(e.stack ?? "")?.[0];
    return `${name} (message ${e.message.length}c)${at ? ` at ${at}` : ""}`;
  }
  return e === undefined ? "undefined" : typeof e;
}

let windowStart = 0;
let sent = 0;
let suppressed = 0;

/** false once BURST error/warning records went out in this window; the first record of the next window reports how many were dropped. */
function allow(now = Date.now()): boolean {
  if (now - windowStart >= WINDOW_MS) {
    if (suppressed) post("warn", `${suppressed} more window errors suppressed`);
    windowStart = now;
    sent = 0;
    suppressed = 0;
  }
  if (sent >= BURST) {
    suppressed++;
    return false;
  }
  sent++;
  return true;
}

function post(level: "error" | "warn" | "debug", text: string) {
  invoke("log_line", { level, text: clean(text) }).catch(() => {});
}

/** Never throws and never logs its own failure: a broken `log_line` must not loop through the error handlers. */
function send(level: "error" | "warn" | "debug", text: () => string) {
  try {
    if (level !== "debug" && !allow()) return;
    post(level, text());
  } catch {}
}

/** console.error (or warn) as before, plus one always-on line in velo.log: `context: errorText`. */
export function logError(context: string, e?: unknown, level: "error" | "warn" = "error") {
  (level === "warn" ? console.warn : console.error)(context, e);
  send(level, () => (e === undefined ? context : `${context}: ${errorText(e)}`));
}

/** A debug record, sent only while Debug logging is on. */
export function logDebug(text: () => string) {
  if (debugOn) send("debug", text);
}

/** Uncaught errors and unhandled rejections in the window go to velo.log too. */
export function installWindowHandlers(w: Pick<Window, "addEventListener">) {
  w.addEventListener("error", (ev) => send("error", () => `uncaught ${errorText(ev.error ?? ev.message)} at ${/^(?:https?|tauri|file):\/\/[\w./%:-]+$/.test(ev.filename) ? ev.filename : "?"}:${ev.lineno}:${ev.colno}`));
  w.addEventListener("unhandledrejection", (ev) => send("error", () => `unhandled rejection: ${errorText(ev.reason)}`));
}

/** The note's file name (its title plus extension), never the folder path. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "";
