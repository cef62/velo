import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { shouldClose } from "./close";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const mk = (clean: Promise<boolean>, answer = false) => {
  const ask = vi.fn(async () => answer);
  return { ask, run: () => shouldClose({ flush: () => clean, ask, lastError: () => "Save failed: locked" }) };
};

test("clean -> close, no prompt", async () => {
  const { ask, run } = mk(Promise.resolve(true));
  expect(await run()).toBe(true);
  expect(ask).not.toHaveBeenCalled();
});
test("dirty + user says no -> stay", async () => {
  const { ask, run } = mk(Promise.resolve(false), false);
  expect(await run()).toBe(false);
  expect(ask).toHaveBeenCalledWith(expect.stringContaining("Save failed: locked"));
});
test("dirty + user says yes -> close", async () => {
  expect(await mk(Promise.resolve(false), true).run()).toBe(true);
});
test("flush never resolves -> asks after timeout", async () => {
  const { ask, run } = mk(new Promise(() => {}), true);
  const p = run();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await p).toBe(true);
  expect(ask).toHaveBeenCalledTimes(1);
});
