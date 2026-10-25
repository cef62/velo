import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SaveController } from "./saver";
import { latest } from "./latest";

const doc = { path: "a.md", title: "a", text: "base", hash: "h0", encrypted: false };
let text = "";
const mk = (over: Partial<ConstructorParameters<typeof SaveController>[0]> = {}) => {
  const d = {
    saveNote: vi.fn(async () => ({ kind: "saved" as const, hash: "h1" })),
    openNote: vi.fn(async () => ({ ...doc, text: "disk", hash: "hd" })),
    getText: () => text,
    setText: (t: string) => void (text = t),
    onConflict: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
  const c = new SaveController(d, 500);
  c.load(doc);
  return { c, d };
};
const type = (c: SaveController, t: string) => { text = t; c.edit(); };

beforeEach(() => { vi.useFakeTimers(); text = ""; });
afterEach(() => vi.useRealTimers());

test("autosave after 500ms", async () => {
  const { c, d } = mk();
  type(c, "x");
  await vi.advanceTimersByTimeAsync(500);
  expect(d.saveNote).toHaveBeenCalledWith("a.md", "x", "h0");
  expect(c.isDirty()).toBe(false);
});

test("conflict with late edit: no keystroke lost", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const saveNote = vi.fn()
    .mockImplementationOnce(async () => { await gate; return { kind: "conflict" as const, conflict_path: "a (conflict).md", disk_hash: "hd" }; })
    .mockImplementation(async () => ({ kind: "conflict" as const, conflict_path: "a (conflict 2).md", disk_hash: "hd" }));
  const { c, d } = mk({ saveNote });
  type(c, "first");
  const p = c.flush();
  type(c, "first+late");
  release();
  await p;
  expect(text).toBe("first+late"); // editor not overwritten
  expect(c.isDirty()).toBe(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(saveNote).toHaveBeenLastCalledWith("a.md", "first+late", "h0"); // latest text goes to another conflict note
  expect(d.onConflict).toHaveBeenCalledTimes(2);
});

test("conflict without late edit loads disk version", async () => {
  const { c, d } = mk({ saveNote: vi.fn(async () => ({ kind: "conflict" as const, conflict_path: "c.md", disk_hash: "hd" })) });
  type(c, "mine");
  await c.flush();
  expect(text).toBe("disk");
  expect(c.isDirty()).toBe(false);
  expect(d.onConflict).toHaveBeenCalledWith("c.md");
});

test("save rejection: stays dirty, error surfaced, retries", async () => {
  const saveNote = vi.fn().mockRejectedValueOnce("locked").mockResolvedValue({ kind: "saved", hash: "h1" });
  const { c, d } = mk({ saveNote });
  type(c, "x");
  await vi.advanceTimersByTimeAsync(500);
  expect(c.isDirty()).toBe(true);
  expect(d.onError).toHaveBeenCalledWith("Save failed: locked");
  await vi.advanceTimersByTimeAsync(1000);
  expect(saveNote).toHaveBeenCalledTimes(2);
  expect(c.isDirty()).toBe(false);
  expect(d.onError).toHaveBeenLastCalledWith(null);
});

test("stale clean reload ignored when edited during openNote", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { c } = mk({ openNote: vi.fn(async () => { await gate; return { ...doc, text: "disk", hash: "hd" }; }) });
  text = "base";
  c.external("a.md");
  type(c, "typed");
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(text).toBe("typed");
});

test("latest(): last request wins", () => {
  const g = latest();
  const a = g();
  const b = g();
  expect(a()).toBe(false);
  expect(b()).toBe(true);
});

test("failing save + switch: refused, text kept, still dirty", async () => {
  const { c } = mk({ saveNote: vi.fn().mockRejectedValue("locked") });
  type(c, "precious");
  expect(await c.flush()).toBe(false);
  expect(c.load({ ...doc, path: "b.md", text: "other" })).toBe(false);
  expect(text).toBe("precious");
  expect(c.currentPath()).toBe("a.md");
  expect(c.isDirty()).toBe(true);
});

test("no note open: typing is not dirty, flush is clean, load succeeds", async () => {
  const d = { saveNote: vi.fn(), openNote: vi.fn(), getText: () => text, setText: (t: string) => void (text = t), onConflict: vi.fn(), onError: vi.fn() };
  const c = new SaveController(d, 500);
  type(c, "orphan");
  expect(c.isDirty()).toBe(false);
  expect(await c.flush()).toBe(true);
  expect(c.load(doc)).toBe(true);
  expect(d.saveNote).not.toHaveBeenCalled();
});
