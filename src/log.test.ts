import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { clean, fileName, installWindowHandlers, logDebug, logError, MAX, setDebugLog } from "./log";

afterEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => {});
  setDebugLog(false);
  vi.restoreAllMocks();
});

test("logError keeps console.error and forwards one bounded line", () => {
  const con = vi.spyOn(console, "error").mockImplementation(() => {});
  logError("search failed", new TypeError(`bad\ninput "secret query"\n${"x".repeat(2000)}`));
  expect(con).toHaveBeenCalledOnce();
  const { level, text } = invoke.mock.calls[0][1] as { level: string; text: string };
  expect(level).toBe("error");
  expect(text.startsWith('search failed: TypeError: bad input "…" x')).toBe(true);
  expect(text).not.toContain("secret");
  expect(text).not.toMatch(/\n/);
  expect(text.length).toBe(MAX);
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
  expect(() => logError("x", undefined)).not.toThrow();
});

test("debug records only while the switch is on", () => {
  logDebug(() => "saver: saved a.md");
  expect(invoke).not.toHaveBeenCalled();
  setDebugLog(true);
  logDebug(() => "saver: saved a.md");
  expect(invoke).toHaveBeenCalledWith("log_line", { level: "debug", text: "saver: saved a.md" });
});

test("window handlers forward uncaught errors and rejections", () => {
  const on: Record<string, (ev: never) => void> = {};
  installWindowHandlers({ addEventListener: (t: string, f: (ev: never) => void) => void (on[t] = f) } as never);
  on.error({ error: new RangeError("boom"), message: "", filename: "app.js", lineno: 3, colno: 4 } as never);
  on.unhandledrejection({ reason: "conflict" } as never);
  expect(invoke.mock.calls.map((c) => (c[1] as { text: string }).text)).toEqual(["uncaught RangeError: boom at app.js:3:4", "unhandled rejection: conflict"]);
});

test("clean and fileName", () => {
  expect(clean("a 'b c' `d` e")).toBe("a '…' `…` e");
  expect(fileName("/Users/me/Notes/Plan.md")).toBe("Plan.md");
  expect(fileName("C:\\Notes\\Plan.md")).toBe("Plan.md");
});
