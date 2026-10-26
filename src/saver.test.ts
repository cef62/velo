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

test("rebind keeps dirty edits and saves them to the new path", async () => {
  const { c, d } = mk();
  type(c, "typed");
  c.rebind("a.md", { ...doc, path: "a.md.age", hash: "h9" });
  expect(c.currentPath()).toBe("a.md.age");
  expect(c.isDirty()).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(d.saveNote).toHaveBeenCalledWith("a.md.age", "typed", "h9");
});

test("rebind on a clean editor loads the doc", () => {
  const { c } = mk();
  c.rebind("a.md", { ...doc, path: "a.md.age", hash: "h9", text: "new" });
  expect(text).toBe("new");
  expect(c.currentPath()).toBe("a.md.age");
});

test("suspended: timer, flush and external do not save", async () => {
  const { c, d } = mk();
  type(c, "x");
  c.suspend();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await c.flush()).toBe(true);
  c.external("a.md");
  expect(d.saveNote).not.toHaveBeenCalled();
  expect(d.openNote).not.toHaveBeenCalled();
});

test("lock hand-off: typing between flush and rebind never saves to the old path", async () => {
  const { c, d } = mk();
  expect(await c.flush()).toBe(true);
  c.suspend();
  type(c, "sneaky"); // would-be keystroke / blur / watcher during the hand-off
  await c.flush();
  c.external("a.md");
  await vi.advanceTimersByTimeAsync(5000);
  c.rebind("a.md", { ...doc, path: "a.md.age", hash: "h9" });
  c.resume();
  await vi.advanceTimersByTimeAsync(5000);
  expect(d.saveNote).not.toHaveBeenCalled();
  expect(c.currentPath()).toBe("a.md.age");
});

test("rebind from a stale path is a no-op: edits typed in another note stay in it", async () => {
  const { c, d } = mk();
  c.suspend(); // toggleLock on a.md
  expect(c.load({ ...doc, path: "b.md", hash: "hb", text: "B" })).toBe(true); // user selected b.md meanwhile
  type(c, "B edited");
  expect(c.rebind("a.md", { ...doc, path: "a.md.age", hash: "h9" })).toBe(false);
  expect(c.currentPath()).toBe("b.md");
  expect(text).toBe("B edited");
  await vi.advanceTimersByTimeAsync(500);
  expect(d.saveNote).toHaveBeenCalledTimes(1);
  expect(d.saveNote).toHaveBeenCalledWith("b.md", "B edited", "hb");
});

test("unload detaches: no further saves, editor emptied", async () => {
  const { c, d } = mk();
  expect(c.unload()).toBe(true);
  expect(text).toBe("");
  expect(c.currentPath()).toBeNull();
  type(c, "x");
  await vi.advanceTimersByTimeAsync(5000);
  expect(d.saveNote).not.toHaveBeenCalled();
});

test("unload refuses while dirty", () => {
  const { c } = mk();
  type(c, "x");
  expect(c.unload()).toBe(false);
  expect(c.currentPath()).toBe("a.md");
});

test("while indexing (saves rejected) a dirty editor is not clean, so closing asks", async () => {
  const { shouldClose } = await import("./close");
  const { c, d } = mk({ saveNote: vi.fn(async () => { throw "indexing"; }) });
  type(c, "unsaved");
  expect(await c.flush()).toBe(false);
  expect(d.onError).toHaveBeenCalledWith("Save failed: indexing");
  const ask = vi.fn(async () => false);
  expect(await shouldClose({ flush: () => c.flush(), ask, lastError: () => "Still indexing…" })).toBe(false);
  expect(ask).toHaveBeenCalledWith(expect.stringContaining("Still indexing…"));
});

test("discard detaches even while dirty and never saves the dropped edits", async () => {
  const { c, d } = mk();
  type(c, "edited");
  c.discard();
  expect(c.isDirty()).toBe(false);
  expect(c.currentPath()).toBeNull();
  expect(text).toBe("");
  await vi.advanceTimersByTimeAsync(5000);
  expect(d.saveNote).not.toHaveBeenCalled();
});

test("onSaved fires after a successful save, not after a rejected one", async () => {
  const onSaved = vi.fn();
  const ok = mk({ onSaved });
  type(ok.c, "x");
  await ok.c.flush();
  expect(onSaved).toHaveBeenCalledTimes(1);

  onSaved.mockClear();
  const bad = mk({ onSaved, saveNote: vi.fn(async () => { throw "indexing"; }) });
  type(bad.c, "y");
  await bad.c.flush();
  expect(onSaved).not.toHaveBeenCalled();
});

test("onSaved fires after a conflict-copy save", async () => {
  const onSaved = vi.fn();
  const { c } = mk({ onSaved, saveNote: vi.fn(async () => ({ kind: "conflict" as const, conflict_path: "c.md", disk_hash: "hd" })) });
  type(c, "mine");
  await c.flush();
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test("onSaving true during save, false after (also on rejection)", async () => {
  const seen: boolean[] = [];
  let fail!: (e: unknown) => void;
  const saveNote = vi.fn()
    .mockImplementationOnce(async () => { expect(seen).toEqual([true]); return { kind: "saved" as const, hash: "h1" }; })
    .mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)));
  const { c } = mk({ saveNote, onSaving: (on: boolean) => void seen.push(on) });
  type(c, "x");
  await c.flush();
  expect(seen).toEqual([true, false]);
  type(c, "y");
  const f = c.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([true, false, true]);
  fail("disk full");
  expect(await f).toBe(false);
  expect(seen).toEqual([true, false, true, false]);
});
