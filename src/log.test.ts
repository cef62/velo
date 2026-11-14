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

test("logError keeps console.error and forwards the error's class and sizes, never its message", () => {
  const con = vi.spyOn(console, "error").mockImplementation(() => {});
  const e = new TypeError(`bad zqmarker \\"zqmarker\\" 'zq`);
  e.stack = `TypeError: ${e.message}\n    at f (tauri://localhost/assets/index-a1.js:10:5)`;
  logError("search failed", e);
  expect(con).toHaveBeenCalledWith("search failed", e);
  expect(invoke.mock.calls[0][1]).toEqual({ level: "error", text: `search failed: TypeError (message ${e.message.length}c) at tauri://localhost/assets/index-a1.js:10:5` });
});

test("the location comes only from a frame line of the app's own script, never from the message", () => {
  const withStack = (message: string, stack: string) => Object.assign(new Error(message), { stack });
  const app = "tauri://localhost/assets/index-a1.js";
  // V8: a URL in the message is not a frame
  const url = "cannot open https://zqmarker.example/x:1:2 now";
  expect(errorText(withStack(url, `Error: ${url}\n    at f (${app}:3:4)`))).toBe(`Error (message ${url.length}c) at ${app}:3:4`);
  // V8: a multi-line message with a line shaped like a frame
  const multi = `first\n    at zq (tauri://localhost/zqmarker.js:9:9)`;
  expect(errorText(withStack(multi, `Error: ${multi}\n    at g (${app}:5:6)`))).toBe(`Error (message ${multi.length}c) at ${app}:5:6`);
  // the message changed after the throw: the header no longer matches, so no location
  expect(errorText(withStack("now different", `Error: ${multi}\n    at g (${app}:5:6)`))).toBe("Error (message 13c)");
  // WebKit / Gecko: frames only
  expect(errorText(withStack("zqmarker", `f@${app}:7:8\nglobal code@${app}:1:1`))).toBe(`Error (message 8c) at ${app}:7:8`);
  // a script of another origin, or a native first frame: no location
  expect(errorText(withStack("x", `f@https://zqmarker.example/a.js:1:2`))).toBe("Error (message 1c)");
  expect(errorText(withStack("x", `Error: x\n    at Array.map (<anonymous>)\n    at f (${app}:1:2)`))).toBe("Error (message 1c)");
  // thrown non-Errors
  expect(errorText("zqmarker https://zqmarker.example/a.js:1:2")).toBe("other (42c)");
  expect(errorText({ stack: `f@${app}:1:2`, message: "zqmarker" })).toBe("object");
});

test("strings: known backend codes as they are, anything else only as its size", () => {
  expect(errorText("locked")).toBe("locked");
  expect(errorText("not-found")).toBe("not-found");
  for (const leak of ["zqmarker", "fts5: syntax error near zqmarker", 'say "zq\\"marker"', "Zqmarker", "zqmarker\n"]) expect(errorText(leak)).not.toMatch(/zq/i);
  expect(errorText({ message: "zqmarker" })).toBe("object");
  expect(errorText(Object.assign(new Error("x"), { name: "zqmarker secret" }))).toBe("Error (message 1c)");
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
  on.error({ error: Object.assign(new RangeError("boom"), { stack: "" }), message: "", filename: "tauri://localhost/assets/app.js", lineno: 3, colno: 4 } as never);
  on.error({ error: null, message: "Script error zqmarker", filename: "zqmarker", lineno: 0, colno: 0 } as never);
  on.unhandledrejection({ reason: "conflict" } as never);
  expect(texts()).toEqual(["uncaught RangeError (message 4c) at tauri://localhost/assets/app.js:3:4", "uncaught other (21c) at ?:0:0", "unhandled rejection: conflict"]);
});

test("clean and fileName", () => {
  expect(clean(`a\n b\u2028c ${"x".repeat(MAX)}`)).toHaveLength(MAX);
  expect(clean("a\n b\u2028c")).toBe("a b c");
  expect(fileName("/Users/me/Notes/Plan.md")).toBe("Plan.md");
  expect(fileName("C:\\Notes\\Plan.md")).toBe("Plan.md");
});
