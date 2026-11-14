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

/** Built-in error class names, logged as they are; any other `name` (user-settable) logs as `Error`. */
const NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);

/**
 * The logged form of an error. Safe by construction: the result is a literal from CODES or NAMES, `Error`,
 * `other`/`non-error` with a type name from typeof, and a size. It never copies text from the error: the message is
 * only measured (it may quote a query or a line of a note), `name` is only compared with NAMES, and `stack` is never
 * read. A total function: getters that throw, a Proxy or odd field types give `non-error (unreadable)` or no size.
 * The location of a caught error is the static context its caller passes to `logError`.
 */
export function errorText(e: unknown): string {
  try {
    if (typeof e === "string") return CODES.has(e) ? e : `other (${e.length}c)`;
    if (e instanceof Error) {
      const name: unknown = e.name;
      const message: unknown = e.message;
      const n = typeof name === "string" && NAMES.has(name) ? name : "Error";
      return typeof message === "string" ? `${n} (message ${message.length}c)` : n;
    }
    return `non-error (${e === null ? "null" : typeof e})`;
  } catch {
    return "non-error (unreadable)";
  }
}

/** `url` when it is one of the app's own scripts (same origin as the window), else null. */
export const ownScript = (url: unknown) => {
  const origin = globalThis.location?.origin;
  return typeof url === "string" && origin && origin !== "null" && url.startsWith(`${origin}/`) && /^[\w./%:-]+$/.test(url) ? url : null;
};
const lineNo = (n: unknown) => (Number.isInteger(n) ? n : 0);

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
  w.addEventListener("error", (ev) => send("error", () => `uncaught ${errorText(ev.error ?? ev.message)} at ${ownScript(ev.filename) ?? "?"}:${lineNo(ev.lineno)}:${lineNo(ev.colno)}`));
  w.addEventListener("unhandledrejection", (ev) => send("error", () => `unhandled rejection: ${errorText(ev.reason)}`));
}

/** The note's file name (its title plus extension), never the folder path. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "";
