import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => []));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { listTitles, search } from "./api";
import { setDebugLog } from "./log";

afterEach(() => setDebugLog(false));

const records = () => invoke.mock.calls.filter((c) => c[0] === "log_line").map((c) => (c[1] as { text: string }).text);

test("with Debug logging on every command leaves one record: name, outcome, duration, never its arguments", async () => {
  await listTitles();
  expect(records()).toEqual([]); // off: nothing extra crosses the bridge
  setDebugLog(true);
  await listTitles();
  invoke.mockRejectedValueOnce("indexing");
  await expect(search("secret query", "modified", 0, ["secret tag"], false, false)).rejects.toBe("indexing");
  const got = records();
  expect(got).toHaveLength(2);
  expect(got[0]).toMatch(/^command list_titles ok in \d+ms$/);
  expect(got[1]).toMatch(/^command search err indexing in \d+ms$/);
});
