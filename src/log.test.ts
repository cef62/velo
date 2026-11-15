import { afterEach, beforeEach, expect, test, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { BURST, clean, errorText, fileName, installWindowHandlers, logDebug, logError, MAX, setDebugLog, WINDOW_MS } from "./log";

let now = 1e12;
beforeEach(() => {
  now += 1e9; // every test starts a fresh rate-limit window
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("location", { origin: "tauri://localhost" });
});
afterEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => {});
  setDebugLog(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const texts = () => invoke.mock.calls.map((c) => (c[1] as { text: string }).text);
const M = "zqmarker";
const ORIGIN = "tauri://localhost";
/** An Error with the marker in its message, name and stack, unless the caller overrides them. */
const marked = (o: Record<string, unknown> = {}) => Object.assign(new Error(`msg ${M}`), { name: `${M}Name`, stack: `${M}@${ORIGIN}/${M}.js:1:2` }, o);

test("logError keeps console.error and forwards only the error's class and message size", () => {
  const con = vi.spyOn(console, "error").mockImplementation(() => {});
  const e = Object.assign(new TypeError(`bad ${M}`), { stack: `TypeError: bad ${M}\n    at f (${ORIGIN}/assets/${M}.js:10:5)` });
  logError("search failed", e);
  expect(con).toHaveBeenCalledWith("search failed", e);
  expect(invoke.mock.calls[0][1]).toEqual({ level: "error", text: "search failed: TypeError (message 12c)" });
});

test("errorText copies nothing from message, name or stack", () => {
  class Custom extends Error {
    constructor(m: string) {
      super(m);
      this.name = `${M}Error`; // set after super(): differs from the stack header
    }
  }
  const sub = new Custom(`code@${ORIGIN}/${M}.js:1:2`);
  sub.stack = `Error: code@${ORIGIN}/${M}.js:1:2\n    at f (${ORIGIN}/${M}.js:3:4)`;
  const throwing = new Error("x");
  for (const k of ["name", "message", "stack"]) Object.defineProperty(throwing, k, { get: () => { throw new Error(M); } });
  const proxy = new Proxy(new Error(M), { get: () => { throw new Error(M); }, getPrototypeOf: () => { throw new Error(M); } });
  const cases: [unknown, string][] = [
    [marked(), "Error (message 12c)"],
    [Object.assign(new RangeError(`msg ${M}`), { stack: `${M}@${ORIGIN}/a.js:1:2` }), "RangeError (message 12c)"],
    [sub, `Error (message ${sub.message.length}c)`],
    [marked({ name: M }), "Error (message 12c)"],
    [`${M} ${ORIGIN}/${M}.js:1:2`, "other (42c)"],
    [marked({ message: null }), "Error"],
    [marked({ message: 5 }), "Error"],
    [marked({ stack: { toString: () => M } }), "Error (message 12c)"],
    [throwing, "non-error (unreadable)"],
    [proxy, "non-error (unreadable)"],
    [null, "non-error (null)"],
    [undefined, "non-error (undefined)"],
    [5, "non-error (number)"],
    [{ message: M, stack: M, name: M }, "non-error (object)"],
    ["locked", "locked"],
  ];
  for (const [e, want] of cases) {
    const got = errorText(e);
    expect(got).toBe(want);
    expect(got).not.toMatch(/zq/i);
  }
});

test("warnings go out as warnings; a failing log_line never throws or recurses", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  invoke.mockImplementation(async () => {
    throw new Error("ipc down");
  });
  expect(() => logError("snapshot failed", "locked", "warn")).not.toThrow();
  await new Promise((r) => setTimeout(r, 0)); // the rejection is swallowed, not unhandled
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke.mock.calls[0][1]).toEqual({ level: "warn", text: "snapshot failed: locked" });
  invoke.mockImplementation(() => {
    throw new Error("sync throw");
  });
  expect(() => logError("x")).not.toThrow();
});

test("an error flood sends BURST lines per window, then one line with the count", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (let i = 0; i < BURST + 30; i++) logError("loop", "locked");
  expect(invoke).toHaveBeenCalledTimes(BURST);
  now += WINDOW_MS;
  logError("loop", "locked");
  expect(texts().slice(BURST)).toEqual(["30 more window errors suppressed", "loop: locked"]);
});

test("a flood with no later error still reports its count once, when the window ends", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (let i = 0; i < BURST + 30; i++) logError("loop", "locked");
  expect(invoke).toHaveBeenCalledTimes(BURST);
  now += WINDOW_MS;
  vi.advanceTimersByTime(WINDOW_MS);
  expect(texts().slice(BURST)).toEqual(["30 more window errors suppressed"]);
  vi.advanceTimersByTime(5 * WINDOW_MS);
  logError("loop", "locked"); // a later error neither repeats the count nor loses its slot
  expect(texts().slice(BURST)).toEqual(["30 more window errors suppressed", "loop: locked"]);
  vi.useRealTimers();
});

test("debug records only while the switch is on, titles intact", () => {
  logDebug(() => "saver: saved Alice's and Bob's notes.md");
  expect(invoke).not.toHaveBeenCalled();
  setDebugLog(true);
  logDebug(() => "saver: saved Alice's and Bob's notes.md");
  expect(invoke).toHaveBeenCalledWith("log_line", { level: "debug", text: "saver: saved Alice's and Bob's notes.md" });
});

test("window handlers forward uncaught errors and rejections", () => {
  const on: Record<string, (ev: never) => void> = {};
  installWindowHandlers({ addEventListener: (t: string, f: (ev: never) => void) => void (on[t] = f) } as never);
  on.error({ error: Object.assign(new RangeError("boom"), { stack: `${M}@${ORIGIN}/${M}.js:1:2` }), message: "", filename: "tauri://localhost/assets/app.js", lineno: 3, colno: 4 } as never);
  on.error({ error: marked(), message: `Script error ${M}`, filename: `https://${M}.example/a.js`, lineno: `${M}`, colno: 2 } as never);
  on.error({ error: null, message: `Script error ${M}`, filename: `${ORIGIN}/${M} x.js`, lineno: 0, colno: 0 } as never);
  on.unhandledrejection({ reason: "conflict" } as never);
  on.unhandledrejection({ reason: marked() } as never);
  expect(texts()).toEqual([
    "uncaught RangeError (message 4c) at tauri://localhost/assets/app.js:3:4",
    "uncaught Error (message 12c) at ?:0:2",
    "uncaught other (21c) at ?:0:0",
    "unhandled rejection: conflict",
    "unhandled rejection: Error (message 12c)",
  ]);
  for (const t of texts()) expect(t).not.toMatch(/zq/i);
});

test("clean and fileName", () => {
  expect(clean(`a\n b\u2028c ${"x".repeat(MAX)}`)).toHaveLength(MAX);
  expect(clean("a\n b\u2028c")).toBe("a b c");
  expect(fileName("/Users/me/Notes/Plan.md")).toBe("Plan.md");
  expect(fileName("C:\\Notes\\Plan.md")).toBe("Plan.md");
});
