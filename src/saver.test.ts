import { afterEach, beforeEach, expect, test, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { setDebugLog } from "./log";
import { SaveController } from "./saver";
import { latest } from "./latest";
import { noMeta } from "./app/fakes";
import { stampChange } from "./frontmatter";

const doc = { path: "a.md", title: "a", text: "base", hash: "h0", encrypted: false, meta: noMeta, archived: false };
let text = "";
const mk = (over: Partial<ConstructorParameters<typeof SaveController>[0]> = {}) => {
  const d = {
    saveNote: vi.fn(async () => ({ kind: "saved" as const, hash: "h1", front_matter: null, meta: noMeta, archived: false })),
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
  expect(await c.flush()).toBe(true); // clean: only onConflict, called before flush resolves, tells it was a conflict copy (#114)
  expect(text).toBe("disk");
  expect(c.isDirty()).toBe(false);
  expect(d.onConflict).toHaveBeenCalledWith("c.md");
});

test("save rejection: stays dirty, error surfaced, retries", async () => {
  const saveNote = vi.fn().mockRejectedValueOnce("locked").mockResolvedValue({ kind: "saved", hash: "h1", front_matter: null, meta: noMeta, archived: false });
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

test("a reload whose setText throws leaves baseHash old, so the next save conflicts instead of overwriting the disk text", async () => {
  const setText = vi.fn().mockImplementationOnce((t: string) => void (text = t)).mockImplementationOnce(() => { throw new RangeError("boom"); }).mockImplementation((t: string) => void (text = t));
  const { c, d } = mk({ setText });
  text = "base";
  c.external("a.md");
  await vi.advanceTimersByTimeAsync(0);
  expect(setText).toHaveBeenCalledTimes(2); // load, then the reload whose throw was swallowed
  type(c, "typed");
  await c.flush();
  expect(d.saveNote).toHaveBeenCalledWith("a.md", "typed", "h0"); // not "hd": the outside change was never applied
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
    .mockImplementationOnce(async () => { expect(seen).toEqual([true]); return { kind: "saved" as const, hash: "h1", front_matter: null, meta: noMeta, archived: false }; })
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

// The editor side of applyFrontMatter: splice without calling edit() (a non-user change).
const applyFm = (block: string, sent: string | null) => {
  const c = stampChange(text, block, sent);
  if (c) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
};
const FM = "---\ncreated: 1\nmodified: 2\n---\n";

test("stamp applies only to an unchanged block, late body edits kept", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const saveNote = vi.fn()
    .mockImplementationOnce(async () => { await gate; return { kind: "saved" as const, hash: "h1", front_matter: FM, meta: noMeta, archived: false }; })
    .mockImplementation(async () => ({ kind: "saved" as const, hash: "h2", front_matter: null, meta: noMeta, archived: false }));
  const onMeta = vi.fn();
  const { c } = mk({ saveNote, applyFrontMatter: applyFm, onMeta });
  type(c, "body");
  const p = c.flush();
  type(c, "body+late");
  release();
  await p;
  expect(text).toBe(FM + "body+late"); // block inserted, late keystrokes kept
  expect(onMeta).toHaveBeenCalledWith(noMeta);
  expect(c.isDirty()).toBe(true);
  await c.flush();
  expect(saveNote).toHaveBeenLastCalledWith("a.md", FM + "body+late", "h1");

  // block edited during the save: the stamp is skipped, the edit stays dirty
  let release2!: () => void;
  const gate2 = new Promise<void>((r) => (release2 = r));
  saveNote.mockImplementationOnce(async () => { await gate2; return { kind: "saved" as const, hash: "h3", front_matter: FM.replace("2", "3"), meta: noMeta, archived: false }; });
  type(c, FM + "more");
  const p2 = c.flush();
  type(c, FM.replace("created: 1", "created: 0") + "more");
  release2();
  await p2;
  expect(text).toBe(FM.replace("created: 1", "created: 0") + "more");
  expect(c.isDirty()).toBe(true);
});

test("stamp application doesn't mark dirty or trigger another save", async () => {
  const saveNote = vi.fn(async () => ({ kind: "saved" as const, hash: "h1", front_matter: FM, meta: noMeta, archived: false }));
  const { c } = mk({ saveNote, applyFrontMatter: applyFm });
  type(c, "x");
  await vi.advanceTimersByTimeAsync(500);
  expect(text).toBe(FM + "x");
  expect(c.isDirty()).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(saveNote).toHaveBeenCalledTimes(1);
  type(c, FM + "xy");
  await vi.advanceTimersByTimeAsync(500);
  expect(saveNote).toHaveBeenLastCalledWith("a.md", FM + "xy", "h1"); // base hash from the save result
});

/** A backend like `Store::save`: a save whose base hash is not the disk's goes to a new conflict copy. */
const backend = () => {
  const be = { disk: "base", hash: "h0", copies: [] as string[] };
  const saveNote = vi.fn(async (_p: string, t: string, base: string) => {
    await Promise.resolve();
    if (base !== be.hash) {
      be.copies.push(t);
      return { kind: "conflict" as const, conflict_path: `a (conflict ${be.copies.length}).md`, disk_hash: be.hash };
    }
    be.disk = t;
    be.hash = `h:${t}`;
    return { kind: "saved" as const, hash: be.hash, front_matter: null, meta: noMeta, archived: false };
  });
  const openNote = vi.fn(async () => ({ ...doc, text: be.disk, hash: be.hash }));
  return { be, saveNote, openNote };
};

test("a save queued behind one that ended in a conflict copy is not sent: the outside change stays (#114)", async () => {
  const { be, saveNote, openNote } = backend();
  const { c, d } = mk({ saveNote, openNote });
  type(c, "mine");
  be.disk = "outside";
  be.hash = "hX";
  c.external("a.md"); // the watcher: dirty, so it flushes
  expect(await c.flush()).toBe(true); // a second flush of the same text (blur, agent write, show)
  await vi.runAllTimersAsync();
  expect(be.disk).toBe("outside"); // main: "mine", written over the outside change
  expect(be.copies).toEqual(["mine"]);
  expect(text).toBe("outside");
  expect(saveNote).toHaveBeenCalledTimes(1);
  expect(d.onConflict).toHaveBeenCalledTimes(1);
});

test("two overlapping flushes of the same text send one save, and both resolve after it (#114)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const saveNote = vi.fn(async () => { await gate; return { kind: "saved" as const, hash: "h1", front_matter: null, meta: noMeta, archived: false }; });
  const { c } = mk({ saveNote });
  type(c, "x");
  const done: boolean[] = [];
  const a = c.flush().then((r) => done.push(r));
  const b = c.flush().then((r) => done.push(r));
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toEqual([]); // neither settles before the save it waits for
  release();
  await Promise.all([a, b]);
  expect(done).toEqual([true, true]);
  expect(saveNote).toHaveBeenCalledTimes(1);
});

test("typing during a save that conflicts, with a second flush queued: every text ends in the note or a copy (#114)", async () => {
  const { be, saveNote, openNote } = backend();
  const { c } = mk({ saveNote, openNote });
  type(c, "one");
  const first = c.flush();
  be.disk = "outside";
  be.hash = "hX";
  type(c, "one two"); // typed while "one" is in flight
  const second = c.flush();
  await first;
  await second;
  await vi.runAllTimersAsync();
  expect(be.disk).toBe("outside");
  expect(be.copies).toEqual(["one", "one two"]);
  expect(text).toBe("outside");
  expect(c.isDirty()).toBe(false);
});

test("flushOutcome reports the conflict copy its own text went to, and null once the note holds it (#114)", async () => {
  const { be, saveNote, openNote } = backend();
  const { c } = mk({ saveNote, openNote });
  type(c, "mine");
  be.hash = "hX";
  expect(await c.flushOutcome()).toEqual({ clean: true, copy: "a (conflict 1).md" });
  type(c, "again");
  expect(await c.flushOutcome()).toEqual({ clean: true, copy: null });
  expect(be.disk).toBe("again");
});

test("flushOutcome after a conflict reload, with nothing new to save, reports no copy (#114)", async () => {
  const { be, saveNote, openNote } = backend();
  const { c } = mk({ saveNote, openNote });
  type(c, "mine");
  be.hash = "hX";
  expect((await c.flushOutcome()).copy).toBe("a (conflict 1).md");
  expect(await c.flushOutcome()).toEqual({ clean: true, copy: null }); // 87ffb42: the old copy again
  expect(saveNote).toHaveBeenCalledTimes(1);
});

test("a conflict copy of one note is not reported for a flush of another note at the same version (#114)", async () => {
  const { be, saveNote, openNote } = backend();
  const { c } = mk({ saveNote, openNote });
  type(c, "mine");
  be.hash = "hX";
  expect((await c.flushOutcome()).copy).toBe("a (conflict 1).md");
  expect(c.load({ ...doc, path: "b.md", text: "B", hash: "hb" })).toBe(true); // the version number stays
  expect(await c.flushOutcome()).toEqual({ clean: true, copy: null });
});

test("debug records name the note and sizes, never its text", async () => {
  setDebugLog(true);
  const saveNote = vi.fn()
    .mockResolvedValueOnce({ kind: "saved", hash: "h1", front_matter: null, meta: noMeta })
    .mockResolvedValueOnce({ kind: "conflict", conflict_path: "/n/a (conflict).md", disk_hash: "hd" });
  const openNote = vi.fn().mockResolvedValueOnce({ ...doc, text: "disk", hash: "hd" }).mockResolvedValueOnce({ ...doc, text: "newer", hash: "h2" });
  const { c } = mk({ saveNote, openNote });
  type(c, "secret body");
  await c.flush();
  type(c, "secret body 2");
  await c.flush();
  c.external("a.md"); // clean: reloads the disk text
  await vi.advanceTimersByTimeAsync(0);
  setDebugLog(false);
  expect(invoke.mock.calls.map((x) => (x[1] as { text: string }).text)).toEqual([
    "saver: saved a.md (11 chars)",
    "saver: conflict on a.md: edits went to a (conflict).md, reloaded from disk",
    "saver: a.md changed on disk: reloaded (5 chars)",
  ]);
});

test("the conflict record says the editor kept the text when a keystroke lands while the disk text loads", async () => {
  setDebugLog(true);
  invoke.mockClear();
  let release!: () => void;
  const openNote = vi.fn(() => new Promise<typeof doc>((r) => (release = () => r({ ...doc, text: "disk", hash: "hd" }))));
  const { c } = mk({ saveNote: vi.fn(async () => ({ kind: "conflict" as const, conflict_path: "a (conflict).md", disk_hash: "hd" })), openNote });
  type(c, "mine");
  const p = c.flush();
  await vi.advanceTimersByTimeAsync(0);
  type(c, "mine+late"); // during the reload's await
  release();
  await p;
  setDebugLog(false);
  expect((invoke.mock.calls[0][1] as { text: string }).text).toBe("saver: conflict on a.md: edits went to a (conflict).md, kept typing, saving again");
});
