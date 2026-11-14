// Window records for velo.log (`log_line`, src-tauri/src/log.rs). Errors and warnings always reach the file; debug
// records only while Settings → Debug logging is on. Privacy rule (#138): titles and sizes, never note text, search
// text or a passphrase. Callers pass a fixed context; error text is cut to one line with its quoted spans emptied.
import { invoke } from "@tauri-apps/api/core";

/** Longest text forwarded; the backend cuts again at its own limit. */
export const MAX = 500;

let debugOn = false;
export const setDebugLog = (on: boolean) => void (debugOn = on);
export const debugLogOn = () => debugOn;

/** One line, at most MAX chars, every quoted span emptied: engine and parser messages quote the input they choked on. */
export const clean = (s: string) =>
  s
    .replace(/(["'`])[^]*?\1/g, "$1…$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX);

export const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : typeof e);

/** Never throws and never logs its own failure: a broken `log_line` must not loop through the error handlers. */
function send(level: "error" | "warn" | "debug", text: () => string) {
  try {
    invoke("log_line", { level, text: clean(text()) }).catch(() => {});
  } catch {}
}

/** console.error (or warn) as before, plus one always-on line in velo.log: `context: error text`. */
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
  w.addEventListener("error", (ev) => send("error", () => `uncaught ${errorText(ev.error ?? ev.message)} at ${ev.filename}:${ev.lineno}:${ev.colno}`));
  w.addEventListener("unhandledrejection", (ev) => send("error", () => `unhandled rejection: ${errorText(ev.reason)}`));
}

/** The note's file name (its title plus extension), never the folder path. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? "";
