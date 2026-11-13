import { expect, test, vi } from "vitest";
import type { LinkTarget, Page, RenameResult, TaskItem, TaskView, TimelineRow } from "../api";
import { Controller, INVALID_TITLE, type KeyEventLike } from "./controller";
import { chipsFor } from "../searchChips";
import { emptyConnections, FakeEditor, FakePreview, deferred, fakeApi, fakeUi, hit, noMeta, settle } from "./fakes";
import { createStore, initialState } from "./store";
import { localToday, toggleTaskLine } from "../tasks";
import { getPos, setPos } from "../positions";
import { chipTags } from "../tags";

const lsStore = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => lsStore.get(k) ?? null, setItem: (k: string, v: string) => void lsStore.set(k, v) };

function setup(notes: Record<string, string> = { A: "a", B: "b", C: "c" }) {
  const { api } = fakeApi(notes);
  const { ui, calls, menus, answers } = fakeUi();
  const store = createStore(initialState(true));
  const c = new Controller(store, api, ui, { isMac: true, platform: "mac" });
  const editor = new FakeEditor();
  c.attachEditor(editor);
  c.attachPreview(new FakePreview());
  return { c, api, ui, calls, store, editor, notes, menus, answers };
}
const P = (t: string) => `/n/${t}.md`;

test("enter waits for the pending search", async () => {
  const { c, api, store } = setup({ ab: "x" });
  const d = deferred<Page>();
  api.search.mockImplementationOnce(() => d.promise);
  c.setQuery("ab");
  const entered = c.enter();
  d.resolve({ hits: [hit("ab")], has_more: false, total: 1, hidden: 0 });
  await entered;
  expect(api.openNote).toHaveBeenCalledWith(P("ab"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("ab"));
});

test("select refused snaps back", async () => {
  const { c, store, editor } = setup();
  await c.runSearch(true);
  await settle(); // row 0 (A) auto-opens
  expect(store.get().openPath).toBe(P("A"));
  editor.flushResult = false;
  expect(await c.select(1)).toBe(false);
  expect(store.get().sel).toBe(0);
  expect(store.get().openPath).toBe(P("A"));
});

test("an arrow visit is recorded in history", async () => {
  const { c, store } = setup();
  await c.runSearch(true);
  await settle();
  await c.select(0); // explicit A
  await c.step(1); // arrow: B
  expect(store.get().openPath).toBe(P("B"));
  await c.navigate("back");
  expect(store.get().openPath).toBe(P("A"));
  await c.navigate("forward");
  expect(store.get().openPath).toBe(P("B"));
});

test("an auto-shown note joins history on its first edit", async () => {
  const { c, store } = setup();
  await c.runSearch(true);
  await settle();
  await c.select(0);
  await c.select(1, "auto");
  c.editorOpts().onEdit();
  await c.navigate("back");
  await c.navigate("forward");
  expect(store.get().openPath).toBe(P("B"));
});

test("navigate skips a vanished note", async () => {
  const { c, store, notes } = setup();
  await c.runSearch(true);
  await settle();
  await c.select(0);
  await c.select(1);
  await c.ensureRows(2);
  await c.select(2);
  delete notes.B;
  await c.navigate("back");
  expect(store.get().openPath).toBe(P("A"));
  expect(store.get().err).toBe("");
  await c.navigate("forward"); // B dropped: straight to C
  expect(store.get().openPath).toBe(P("C"));
});

test("show while busy refuses with Busy message", async () => {
  const { c, api, store } = setup();
  c.busy = true;
  expect(await c.show(P("A"))).toBe(false);
  expect(store.get().err).toBe("Busy — try again in a moment");
  expect(api.openNote).not.toHaveBeenCalled();
});

test("no folder → phase setup", async () => {
  const { c, api, store } = setup();
  api.search.mockRejectedValue("no-folder");
  await c.start();
  expect(store.get().phase).toBe("setup");
});

test("start with a folder searches, opens row 0 and focuses search", async () => {
  const { c, store, calls } = setup();
  await c.start();
  await settle();
  expect(store.get().phase).toBe("ready");
  expect(store.get().openPath).toBe(P("A"));
  expect(calls.map((x) => x[0])).toEqual(["applyLook", "setWindowTheme", "focusSearch"]);
});

test("total from first page", async () => {
  const { c, api, store } = setup();
  api.search.mockImplementation(async (_q, _s, offset) =>
    offset === 0 ? { hits: [hit("A"), hit("B")], has_more: true, total: 7, hidden: 0 } : { hits: [hit("C")], has_more: false, total: 0, hidden: 0 });
  await c.runSearch(true);
  expect(store.get().total).toBe(7);
  await c.ensureRows(2);
  expect(store.get().count).toBe(3);
  expect(store.get().total).toBe(7);
});

test("exactTitleMatch follows the first page", async () => {
  const { c, store } = setup({ Alpha: "", Beta: "" });
  c.setQuery(" alpha ");
  await settle();
  expect(store.get().exactTitleMatch).toBe(true);
  c.setQuery("alp");
  await settle();
  expect(store.get().exactTitleMatch).toBe(false);
  c.setQuery("");
  await settle();
  expect(store.get().exactTitleMatch).toBe(false);
});

test("editor callbacks: save errors set errFromSave, other errors clear it", async () => {
  const { c, store } = setup();
  const o = c.editorOpts();
  o.onError("Save failed: disk full");
  expect(store.get()).toMatchObject({ err: "Save failed: disk full", errFromSave: true });
  c.busy = true;
  await c.show(P("A"));
  expect(store.get()).toMatchObject({ err: "Busy — try again in a moment", errFromSave: false });
  o.onConflict(P("A (conflict)"));
  o.onSaving(true);
  expect(store.get()).toMatchObject({ conflict: P("A (conflict)"), saving: true });
});

test("lock hand-off busy refuses show", async () => {
  const { c, api, store, editor } = setup();
  await c.runSearch(true);
  await settle(); // A open
  const d = deferred<string>();
  api.lockNote.mockImplementationOnce(() => d.promise);
  const locking = c.toggleLock();
  await settle();
  expect(editor.suspended).toBe(true);
  expect(await c.show(P("B"))).toBe(false);
  expect(store.get().err).toBe("Busy — try again in a moment");
  api.openNote.mockResolvedValueOnce({ path: "/n/A.age", title: "A", text: "a", hash: "h", encrypted: true, meta: noMeta, archived: false });
  d.resolve("/n/A.age");
  await locking;
  expect(editor.path).toBe("/n/A.age");
  expect(editor.suspended).toBe(false);
  expect(store.get()).toMatchObject({ openPath: "/n/A.age", encrypted: true, err: "" });
  expect(api.saveNote).not.toHaveBeenCalled();
  expect(c.busy).toBe(false);
});

test("lock asks for a passphrase with the note title when there is no identity", async () => {
  const { c, api, calls } = setup();
  await c.runSearch(true);
  await settle();
  api.hasIdentity.mockResolvedValue(false);
  api.identityFileExists.mockResolvedValue(false);
  await c.toggleLock(); // dialog answers false
  expect(calls.find((x) => x[0] === "passphrase")?.[1]).toMatchObject({ mode: "create", context: "A" });
  expect(api.lockNote).not.toHaveBeenCalled();
});

test("delete highlights neighbour without opening", async () => {
  const { c, api, store } = setup();
  await c.runSearch(true);
  await settle();
  await c.ensureRows(2);
  await c.select(2); // C, the last row
  api.openNote.mockClear();
  await c.deleteNote();
  expect(api.deleteNote).toHaveBeenCalledWith(P("C"));
  expect(store.get()).toMatchObject({ openPath: null, title: "", sel: 1 });
  await settle();
  expect(api.openNote).not.toHaveBeenCalled();
});

test("delete keeps the note's stored position until the backend confirms", async () => {
  const { c, api } = setup();
  await c.runSearch(true);
  await settle(); // A open
  setPos(P("A"), { h: 1, t: 0, m: 0 });
  api.deleteNote.mockRejectedValueOnce(new Error("io"));
  await c.deleteNote();
  expect(getPos(P("A"))).toBeDefined();
  await c.deleteNote();
  expect(getPos(P("A"))).toBeUndefined();
});

test("delete: a note opened during the flush keeps its unsaved edits", async () => {
  const { c, editor, notes, store } = setup();
  await c.runSearch(true);
  await settle(); // A open
  const flush = deferred<boolean>();
  editor.flush.mockImplementationOnce(() => flush.promise);
  const del = c.deleteNote();
  await vi.waitFor(() => expect(editor.flush).toHaveBeenCalled());
  const doc = { path: P("C"), title: "C", text: notes.C, hash: "h", encrypted: false, meta: noMeta, archived: false };
  editor.load(doc);
  (c as any).loadedDoc(doc); // what an in-flight show does when it lands
  editor.replaceText("typed in C");
  flush.resolve(true);
  await del;
  expect(editor.currentPath()).toBe(P("C"));
  expect(editor.text).toBe("typed in C");
  expect(editor.dirty).toBe(true);
  expect(getPos(P("A"))).toBeUndefined();
  expect(store.get()).toMatchObject({ openPath: P("C"), title: "C" });
});

test("delete: a failing backend call while another note is open leaves that note alone", async () => {
  const { c, api, editor, notes, store } = setup();
  await c.runSearch(true);
  await settle(); // A open
  const flush = deferred<boolean>();
  editor.flush.mockImplementationOnce(() => flush.promise);
  api.deleteNote.mockRejectedValueOnce(new Error("io"));
  const del = c.deleteNote();
  await vi.waitFor(() => expect(editor.flush).toHaveBeenCalled());
  const doc = { path: P("C"), title: "C", text: notes.C, hash: "h", encrypted: false, meta: noMeta, archived: false };
  editor.load(doc);
  (c as any).loadedDoc(doc); // what an in-flight show does when it lands
  flush.resolve(true); // C stays clean: a dirty C would hide a wrong reopen of A, whose load refuses over unsaved edits
  await del;
  expect(editor.currentPath()).toBe(P("C"));
  expect(store.get()).toMatchObject({ openPath: P("C"), title: "C", err: "Error: io" });
  expect(c.busy).toBe(false);
});

test("delete flush failure aborts", async () => {
  const { c, api, store, editor } = setup();
  await c.runSearch(true);
  await settle();
  editor.flushResult = false;
  await c.deleteNote();
  expect(store.get().err).toBe("Can't delete: unsaved changes couldn't be saved");
  expect(api.deleteNote).not.toHaveBeenCalled();
  expect(editor.path).toBe(P("A"));
});

test("tag prune highlights row 0 without opening", async () => {
  const { c, api, store } = setup();
  store.set({ selectedTags: ["gone"] });
  api.listTags.mockResolvedValueOnce([{ tag: "kept", count: 1 }] as never);
  await c.refreshTags();
  await settle();
  expect(store.get()).toMatchObject({ selectedTags: [], tags: [{ tag: "kept", count: 1 }], sel: 0, openPath: null });
  expect(api.openNote).not.toHaveBeenCalled();
});

test("opening a locked note with no key anywhere shows the copy-identity error and no dialog", async () => {
  const { c, api, store, calls } = setup();
  api.openNote.mockRejectedValueOnce("locked");
  api.hasIdentity.mockResolvedValue(false);
  api.identityFileExists.mockResolvedValue(false);
  await c.show(P("A"));
  expect(store.get().err).toBe(
    "This note was locked with a velo key that isn't on this computer. Copy `.velo/identity.age` from the other computer into this notes folder.",
  );
  expect(calls.some((x) => x[0] === "passphrase")).toBe(false);
});

test("a locked first hit while typing shows the error but never the passphrase dialog", async () => {
  const { c, api, store, calls } = setup();
  api.openNote.mockRejectedValueOnce("locked");
  api.hasIdentity.mockResolvedValue(false);
  await c.show(P("A"), "auto");
  expect(store.get().err).toBe("Note is locked");
  expect(calls.some((x) => x[0] === "passphrase")).toBe(false);
});

test("quick settings toggles don't write back each other's stale copy", async () => {
  const { c, api } = setup();
  let saved = await api.getSettings();
  api.getSettings.mockImplementation(async () => ({ ...saved }));
  api.setSettings.mockImplementation(async (s) => {
    await settle();
    saved = s;
  });
  await Promise.all([c.toggleInfo(), c.toggleSort()]);
  expect(saved).toMatchObject({ info_panel: true, sort: "title" });
});

test("setSort saves the order and re-sorts; toggleSort flips it", async () => {
  const { c, api, store } = setup();
  let saved = await api.getSettings(); // the fake api must hand back what was saved: toggleSort reads it
  api.getSettings.mockImplementation(async () => ({ ...saved }));
  api.setSettings.mockImplementation(async (s) => void (saved = s));
  await c.setSort("title");
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "title" }));
  expect(store.get().sort).toBe("title");
  await c.setSort("title"); // same value: still a save, never a toggle
  expect(store.get().sort).toBe("title");
  await c.toggleSort();
  expect(store.get().sort).toBe("modified");
  await Promise.all([c.toggleSort(), c.toggleSort()]); // two quick presses cancel out
  expect(store.get().sort).toBe("modified");
});

test("setStyle saves the editing style; toggleStyle flips it; hasSelection follows the editor", async () => {
  const { c, api, store } = setup();
  await c.setStyle("plain");
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ editor_style: "plain" }));
  expect(store.get().editorStyle).toBe("plain");
  await c.toggleStyle();
  expect(store.get().editorStyle).toBe("rich");
  expect(c.hasSelection()).toBe(false); // no note open
});

test("opening a locked note asks inline; a newer open under the field wins and cancels it", async () => {
  const { c, api, store, ui } = setup();
  const open = api.openNote.getMockImplementation()!;
  let lockedA = true;
  api.openNote.mockImplementation(async (p: string) => {
    if (p === P("A") && lockedA) throw "locked";
    return open(p);
  });
  api.hasIdentity.mockResolvedValue(false);
  api.identityFileExists.mockResolvedValue(true);
  let resolveUnlock!: (ok: boolean) => void;
  let cancelled = 0;
  ui.passphrase = async (req) => {
    expect(req).toMatchObject({ mode: "unlock", inline: true });
    return new Promise<boolean>((r) => (resolveUnlock = r));
  };
  ui.cancelPassphrase = () => void cancelled++;
  const a = c.show(P("A"));
  await settle();
  await c.show(P("B")); // clicked another note while the field was up
  expect(cancelled).toBeGreaterThan(0);
  expect(store.get().openPath).toBe(P("B"));
  lockedA = false; // the key is loaded now: a retry would open A
  const opened = api.openNote.mock.calls.length;
  resolveUnlock(true); // the stale prompt resolves anyway
  expect(await a).toBe(true);
  expect(store.get().openPath).toBe(P("B")); // A is not reopened over B
  expect(api.openNote.mock.calls.length).toBe(opened);
  expect(store.get().err).toBe("");
});

test("removeFilterChip drops the last chip, a saved chip as one; clearFilterChips clears the applied saved search's text too", async () => {
  const { c, store } = setup();
  store.set({ savedSearches: [{ name: "w", query: "todo", tags: ["work"], no_links: false }] });
  c.setTags(["work", "idea"]);
  c.setNoLinks(true);
  c.removeFilterChip(); // the last chip is No links
  expect(store.get()).toMatchObject({ selectedTags: ["work", "idea"], noLinks: false });
  c.removeFilterChip({ kind: "tag", label: "#work", tag: "work" });
  expect(store.get().selectedTags).toEqual(["idea"]);
  c.applySaved("w");
  expect(store.get()).toMatchObject({ query: "todo", selectedTags: ["work"], appliedSaved: "w" });
  c.setQuery("todo list"); // typing narrows the applied search: still one chip
  expect(chipsFor(store.get().savedSearches, store.get().appliedSaved, { query: "todo list", tags: ["work"], noLinks: false })).toHaveLength(1);
  c.setQuery(""); // its text erased: the chip is gone, the tag stays as a plain chip
  expect(chipsFor(store.get().savedSearches, store.get().appliedSaved, { query: "", tags: ["work"], noLinks: false })).toEqual([{ kind: "tag", label: "#work", tag: "work" }]);
  c.setQuery("todo");
  c.removeFilterChip(); // the saved chip clears as one, text included
  expect(store.get()).toMatchObject({ query: "", selectedTags: [], noLinks: false });
  c.applySaved("w");
  c.clearFilterChips();
  expect(store.get()).toMatchObject({ query: "", selectedTags: [] });
  c.setTags(["x"]);
  c.clearFilterChips();
  expect(store.get().selectedTags).toEqual([]);
  c.applySaved("w");
  c.setTags(["work", "idea"]); // a tag change ends the applied search
  expect(store.get().appliedSaved).toBeNull();
});

test("the palette opens and closes; a chosen action runs after the next frame and goes to Recent", async () => {
  const { c, store, ui, calls } = setup();
  c.openPalette();
  expect(store.get().palette).toBe(true);
  c.onKeyDown({ ...KEY_P, inDialog: true });
  expect(store.get().palette).toBe(true); // keys inside the dialog are its own
  c.closePalette();
  expect(store.get().palette).toBe(false);
  c.onKeyDown(KEY_P);
  expect(store.get().palette).toBe(true);
  let frame!: () => void;
  ui.nextFrame = () => new Promise<void>((r) => (frame = r));
  c.runPaletteAction("focus_search");
  expect(store.get()).toMatchObject({ palette: false, recentActions: ["focus_search"] });
  expect(calls.some((x) => x[0] === "focusSearch")).toBe(false); // not yet: the focus trap is still up
  frame();
  await settle();
  expect(calls.some((x) => x[0] === "focusSearch")).toBe(true);
  c.runPaletteAction("toggle_window"); // an OS-level action is not runnable here
  expect(store.get().recentActions).toEqual(["focus_search"]);
});

test("a slow auto-show doesn't replace the note Enter just opened", async () => {
  const { c, api, store } = setup();
  const d = deferred<ReturnType<typeof api.openNote> extends Promise<infer T> ? T : never>();
  api.openNote.mockImplementationOnce(() => d.promise);
  const auto = c.show(P("A"), "auto");
  await c.openTitle("B", "enter");
  d.resolve({ path: P("A"), title: "A", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  await auto;
  expect(store.get().openPath).toBe(P("B"));
});

test("update install saves, freezes the editor, then installs", async () => {
  const { c, api, store, editor } = setup();
  c.onUpdateAvailable("0.6.1");
  await c.installUpdate();
  expect(editor.flush).toHaveBeenCalled();
  expect(editor.suspended).toBe(true);
  expect(api.installUpdate).toHaveBeenCalled();
  expect(store.get().update).toEqual({ version: "0.6.1", status: "installing", message: "Downloading velo 0.6.1…" });
});

test("update install banner shows download progress, then Installing", async () => {
  const { c, api, store } = setup();
  api.installUpdate.mockImplementationOnce(() => new Promise(() => {})); // relaunching
  c.onUpdateProgress(10, 100); // before the install started: ignored
  expect(store.get().update).toBeNull();
  c.onUpdateAvailable("0.6.1");
  void c.installUpdate();
  await settle();
  c.onUpdateProgress(425, 1000);
  expect(store.get().update?.message).toBe("Downloading velo 0.6.1… 42%");
  c.onUpdateProgress(2_500_000, null);
  expect(store.get().update?.message).toBe("Downloading velo 0.6.1… 2.5 MB");
  c.onUpdateInstalling();
  expect(store.get().update).toEqual({ version: "0.6.1", status: "installing", message: "Installing velo 0.6.1… velo restarts when it's done." });
});

test("update install refused by a failed save installs nothing", async () => {
  const { c, api, store, editor } = setup();
  c.onUpdateAvailable("0.6.1");
  editor.flushResult = false;
  await c.installUpdate();
  expect(api.installUpdate).not.toHaveBeenCalled();
  expect(store.get().update?.status).toBe("available");
});

test("a failed update install gives the editor back and says why", async () => {
  const { c, api, store, editor } = setup();
  api.installUpdate.mockRejectedValueOnce("signature mismatch");
  c.onUpdateAvailable("0.6.1");
  await c.installUpdate();
  expect(editor.suspended).toBe(false);
  expect(store.get().update).toEqual({ version: "0.6.1", status: "failed", message: "Update failed: signature mismatch" });
  c.onUpdateProgress(5, 10); // a late event doesn't bring back the busy state
  expect(store.get().update?.status).toBe("failed");
  c.dismissUpdate();
  expect(store.get().update).toBeNull();
});

test("manual update check: up to date names the current version", async () => {
  const { c, api, store } = setup();
  await c.checkUpdates();
  expect(store.get().update).toEqual({ version: "0.6.0", status: "current" });
  api.checkUpdate.mockResolvedValueOnce({ version: "0.6.1" });
  await c.checkUpdates();
  expect(store.get().update).toEqual({ version: "0.6.1", status: "available" });
});

test("a rename in flight blocks the update install (its reload would unfreeze the editor)", async () => {
  const { c, api, store, editor } = setup();
  await c.runSearch(true);
  await settle();
  const renamed = deferred<{ path: string; rewritten: number }>();
  api.renameNote.mockImplementationOnce(() => renamed.promise);
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  c.startRename();
  const rename = c.commitRename("Z");
  await settle();
  c.onUpdateAvailable("0.6.1");
  await c.installUpdate();
  expect(api.installUpdate).not.toHaveBeenCalled();
  expect(store.get().err).toBe("Busy — try again in a moment");
  renamed.resolve({ path: P("Z"), rewritten: 0 });
  await rename;
  expect(editor.suspended).toBe(false);
  expect(store.get().update?.status).toBe("available");
});

test("a rename committed during the update install is refused", async () => {
  const { c, api, store } = setup();
  await c.runSearch(true);
  await settle();
  api.installUpdate.mockImplementationOnce(() => new Promise(() => {})); // relaunching
  c.onUpdateAvailable("0.6.1");
  void c.installUpdate();
  await settle();
  c.startRename();
  await c.commitRename("Z");
  expect(api.renameNote).not.toHaveBeenCalled();
  expect(store.get().err).toBe("Busy — try again in a moment");
});

test("repeat clicks on Install or Check now are quiet", async () => {
  const { c, api, store } = setup();
  api.installUpdate.mockImplementationOnce(() => new Promise(() => {}));
  c.onUpdateAvailable("0.6.1");
  void c.installUpdate();
  await c.installUpdate();
  expect(api.installUpdate).toHaveBeenCalledTimes(1);
  expect(store.get().err).toBe("");
  const { c: c2, api: api2, store: store2 } = setup();
  api2.checkUpdate.mockRejectedValueOnce("An update check or install is already running");
  expect(await c2.checkUpdates()).toBe("Already checking…");
  expect(store2.get().err).toBe("");
});

test("an install refused because the daily check is running keeps the banner", async () => {
  const { c, api, store, editor } = setup();
  api.installUpdate.mockRejectedValueOnce("An update check or install is already running");
  c.onUpdateAvailable("0.6.1");
  await c.installUpdate();
  expect(editor.suspended).toBe(false);
  expect(store.get().update).toEqual({ version: "0.6.1", status: "available" });
  expect(store.get().err).toBe("Checking for updates — try again in a moment");
});

test("manual check returns its result as a line for Settings", async () => {
  const { c, api } = setup();
  expect(await c.checkUpdates()).toBe("velo is up to date (0.6.0)");
  api.checkUpdate.mockResolvedValueOnce({ version: "0.6.1" });
  expect(await c.checkUpdates()).toBe("velo 0.6.1 is available");
  api.checkUpdate.mockRejectedValueOnce("offline");
  expect(await c.checkUpdates()).toBe("offline");
});

test("Lock and Lock all during an update install say busy instead of doing nothing", async () => {
  const { c, api, store } = setup();
  await c.runSearch(true);
  await settle();
  api.installUpdate.mockImplementationOnce(() => new Promise(() => {}));
  c.onUpdateAvailable("0.6.1");
  void c.installUpdate();
  await settle();
  await c.lockEverything();
  expect(api.lockAll).not.toHaveBeenCalled();
  expect(store.get().err).toBe("Busy — try again in a moment");
  store.set({ err: "" });
  await c.toggleLock();
  expect(store.get().err).toBe("Busy — try again in a moment");
});

test("a note reply arriving during the update install doesn't unfreeze the editor", async () => {
  const { c, api, store, editor } = setup();
  const d = deferred<ReturnType<typeof api.openNote> extends Promise<infer T> ? T : never>();
  api.openNote.mockImplementationOnce(() => d.promise);
  api.installUpdate.mockImplementationOnce(() => new Promise(() => {}));
  const auto = c.show(P("A"), "auto");
  c.onUpdateAvailable("0.6.1");
  void c.installUpdate();
  await settle();
  d.resolve({ path: P("A"), title: "A", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  await auto;
  expect(editor.suspended).toBe(true);
  expect(store.get().openPath).toBeNull();
});

const key = (code: string, mods: { meta?: boolean; shift?: boolean } = {}, where: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: code.replace(/^Key/, "").toLowerCase(),
  code,
  metaKey: !!mods.meta,
  ctrlKey: false,
  altKey: false,
  shiftKey: !!mods.shift,
  repeat: false,
  inEditor: false,
  inSearchWithText: false,
  inDialog: false,
  inRename: false,
  ...where,
});

test("onKeyDown: none binding never fires; Backspace combo skipped in editor; arrows ignored in editor; menu key opens context menu for sel", async () => {
  const { c, store, calls, api } = setup();
  await c.runSearch(true);
  await settle();
  store.set({ keys: { ...store.get().keys, focus_search: "none" } });
  expect(c.onKeyDown(key("none"))).toBe(false); // an event whose binding string is "none" still doesn't fire it
  expect(calls.some((x) => x[0] === "focusSearch")).toBe(false);
  expect(c.onKeyDown(key("Backspace", { meta: true }, { inEditor: true }))).toBe(false);
  expect(c.onKeyDown(key("Backspace", { meta: true }, { inSearchWithText: true }))).toBe(false);
  expect(c.onKeyDown({ ...key("ArrowDown"), key: "ArrowDown", inEditor: true })).toBe(false);
  expect(c.onKeyDown({ ...key("KeyL", { meta: true }), inDialog: true })).toBe(false);
  expect(c.onKeyDown({ ...key("ContextMenu"), key: "ContextMenu" })).toBe(true);
  await settle();
  expect(calls.find((x) => x[0] === "popupMenu")).toBeTruthy();
  expect(calls.some((x) => x[0] === "rowAnchor")).toBe(true);
  expect(c.onKeyDown({ ...key("ArrowDown"), key: "ArrowDown" })).toBe(true);
  await settle();
  expect(store.get().openPath).toBe(P("B"));
  expect(c.onKeyDown(key("KeyS", { meta: true, shift: true }))).toBe(true); // toggle_sort
  await settle();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ sort: "title" }));
});

test("the context-menu key follows the saved context_menu binding; the ContextMenu key always works", async () => {
  const { c, store, calls } = setup();
  await c.runSearch(true);
  await settle();
  const menus = () => calls.filter((x) => x[0] === "popupMenu").length;
  const f10 = { ...key("F10", { shift: true }), key: "F10" };
  expect(c.onKeyDown(f10)).toBe(true); // default Shift+F10
  await settle();
  expect(menus()).toBe(1);
  store.set({ keys: { ...store.get().keys, context_menu: "Mod+KeyM" } });
  expect(c.onKeyDown(f10)).toBe(false);
  expect(c.onKeyDown(key("KeyM", { meta: true }))).toBe(true);
  await settle();
  expect(menus()).toBe(2);
  expect(c.onKeyDown(key("KeyM", { meta: true }, { inEditor: true }))).toBe(false); // never a command in the editor
  store.set({ keys: { ...store.get().keys, context_menu: "none" } });
  expect(c.onKeyDown(f10)).toBe(false);
  expect(c.onKeyDown({ ...key("ContextMenu"), key: "ContextMenu" })).toBe(true);
  await settle();
  expect(menus()).toBe(3);
});

test("saveSettings maps not-found to Folder not found", async () => {
  const { c, api } = setup();
  const s = await api.getSettings();
  api.setSettings.mockRejectedValueOnce("not-found");
  expect(await c.saveSettings({ ...s, notes_dir: "/gone" })).toBe("Folder not found");
  api.setSettings.mockRejectedValueOnce("hotkey taken");
  expect(await c.saveSettings(s)).toBe("hotkey taken");
});

test("saveSettings applies look, keys and sort, and closes the dialog", async () => {
  const { c, api, store, calls } = setup();
  await c.openSettings();
  const s = store.get().settings!;
  expect(s.notes_dir).toBe("/n");
  const next = { ...s, theme: "dark" as const, sort: "title" as const, shortcuts: { focus_search: "Mod+KeyP" } };
  expect(await c.saveSettings(next)).toBe(null);
  expect(api.setSettings).toHaveBeenCalledWith(next);
  expect(store.get()).toMatchObject({ settings: null, theme: "dark", sort: "title" });
  expect(store.get().keys.focus_search).toBe("Mod+KeyP");
  expect(calls).toContainEqual(["setWindowTheme", "dark"]);
});

test("previewLook restyles live; closeSettings reverts to the saved theme and palette", async () => {
  const { c, store, calls } = setup();
  await c.openSettings();
  c.previewLook({ theme: "dark", palette: "reef", layout: "horizontal", font_size: 30 } as never); // draft General edits stay out
  expect(calls).toContainEqual(["applyLook", { theme: "dark", palette: "reef", fontSize: 14, layout: "vertical" }]);
  expect(calls).toContainEqual(["setWindowTheme", "dark"]);
  c.closeSettings();
  expect(calls[calls.length - 2]).toEqual(["applyLook", expect.objectContaining({ theme: "system", palette: "clear" })]);
  expect(store.get()).toMatchObject({ settings: null, theme: "system" });
});

test("changing the notes folder closes the note from the old folder", async () => {
  const { c, api, store, editor } = setup();
  await c.show(P("A"));
  await c.openSettings();
  const s = store.get().settings!;
  api.search.mockResolvedValue({ hits: [], has_more: false, total: 0, hidden: 0 }); // the new folder is empty
  expect(await c.saveSettings({ ...s, notes_dir: "/other" })).toBe(null);
  expect(editor.currentPath()).toBe(null);
  expect(store.get().openPath).toBe(null);
});

test("changing the notes folder with unsaved edits saves them first, or refuses to switch", async () => {
  const { c, api, store, editor } = setup();
  await c.show(P("A"));
  await c.openSettings();
  const s = store.get().settings!;
  editor.dirty = true; // an agent write landed while Settings was open
  editor.flushResult = false;
  expect(await c.saveSettings({ ...s, notes_dir: "/other" })).toBe("Save the open note first");
  expect(api.setSettings).not.toHaveBeenCalled();
  expect(editor.currentPath()).toBe(P("A"));
  editor.flushResult = true; // saved; the fake stays dirty, so unload refuses and the saved text is discarded
  const flushes = editor.flush.mock.calls.length;
  let flushedBefore = 0;
  api.setSettings.mockImplementationOnce(async () => void (flushedBefore = editor.flush.mock.calls.length - flushes));
  expect(await c.saveSettings({ ...s, notes_dir: "/other" })).toBe(null);
  expect(flushedBefore).toBe(1); // saved into the old folder, before the switch
  expect(editor.currentPath()).toBe(null);
  expect(store.get().openPath).toBe(null);
});

test("conflict clears on dismiss and when the open note changes; openConflict opens it", async () => {
  const { c, store, notes } = setup();
  await c.runSearch(true);
  await settle();
  notes["A (conflict)"] = "x";
  c.editorOpts().onConflict(P("A (conflict)"));
  c.dismissConflict();
  expect(store.get().conflict).toBe(null);
  c.editorOpts().onConflict(P("A (conflict)"));
  await c.openConflict();
  expect(store.get()).toMatchObject({ openPath: P("A (conflict)"), conflict: null });
});

test("rename commits through flush, backlinks confirm and reload", async () => {
  const { c, api, store, calls } = setup();
  await c.runSearch(true);
  await settle();
  c.startRename();
  expect(store.get().renaming).toBe(true);
  api.backlinkCount.mockResolvedValueOnce(2);
  api.renameNote.mockResolvedValueOnce({ path: P("Z"), rewritten: 2 });
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  await c.commitRename("  Z ");
  expect(calls).toContainEqual(["confirm", "Update 2 links to the new title?", { title: "Rename", kind: "info" }]);
  expect(api.renameNote).toHaveBeenCalledWith(P("A"), "Z", true);
  expect(store.get()).toMatchObject({ renaming: false, title: "Z", openPath: P("Z") });
  c.startRename();
  await c.commitRename(null);
  expect(api.renameNote).toHaveBeenCalledTimes(1);
});

test("title rename while the note has unsaved edits keeps the edits and follows the note", async () => {
  const { c, api, store, editor } = setup();
  await c.runSearch(true);
  await settle();
  editor.dirty = true; // typed during the rename's awaits
  editor.text = "typed";
  api.renameNote.mockResolvedValueOnce({ path: P("Z"), rewritten: 0 });
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  c.startRename();
  await c.commitRename("Z");
  expect(editor.currentPath()).toBe(P("Z"));
  expect(editor.text).toBe("typed");
  expect(store.get()).toMatchObject({ title: "Z", openPath: P("Z") });
});

test("context menu: one popup per open (menuBusy), previous menu closed on the next open", async () => {
  const { c, menus } = setup();
  await c.runSearch(true);
  await settle();
  await Promise.all([c.openContextMenu(1), c.openContextMenu(1)]); // second call refused while the first is in flight
  expect(menus.length).toBe(1);
  await c.openContextMenu(0);
  expect(menus.length).toBe(2);
  expect(menus.filter((m) => !m.closed).length).toBe(1);
  expect(menus[0].closed).toBe(true);
});

test("listReset bumps on a fresh result set, not on refresh or paging", async () => {
  const { c, store } = setup();
  await c.runSearch(true);
  const r = store.get().listReset;
  expect(r).toBe(1);
  await c.runSearch(false);
  expect(store.get().listReset).toBe(r);
  c.setQuery("a");
  await settle();
  expect(store.get().listReset).toBeGreaterThan(r);
});

test("external change snapshots the old text before reload", async () => {
  const { c, api, editor } = setup();
  await c.runSearch(true);
  await settle(); // A open
  editor.text = "old A";
  await c.onNotesChanged([P("A")]);
  expect(api.snapshotText).toHaveBeenCalledWith(P("A"), "old A");
  expect(api.snapshotText.mock.invocationCallOrder[0]).toBeLessThan(editor.onExternalChange.mock.invocationCallOrder[0]);
  // a dirty editor goes the conflict way: no snapshot of unsaved text; a snapshot failure still reloads
  editor.dirty = true;
  await c.onNotesChanged([P("A")]);
  expect(api.snapshotText).toHaveBeenCalledTimes(1);
  editor.dirty = false;
  api.snapshotText.mockRejectedValueOnce("locked");
  await c.onNotesChanged([P("A")]);
  expect(editor.onExternalChange).toHaveBeenCalledTimes(3);
});

test("restore snapshots current text then replaces it as an edit", async () => {
  const { c, api, editor } = setup();
  await c.runSearch(true);
  await settle();
  editor.text = "now";
  api.readRevision.mockResolvedValueOnce("then");
  await c.restoreRevision("42");
  expect(editor.flush).toHaveBeenCalled();
  expect(api.readRevision).toHaveBeenCalledWith(P("A"), "42");
  expect(api.snapshotText).toHaveBeenCalledWith(P("A"), "now");
  expect(editor.text).toBe("then");
  expect(editor.dirty).toBe(true);
});

test("toggle_front_matter persists", async () => {
  const { c, api, store, editor } = setup();
  await c.start();
  expect(editor.showFrontMatter).toBe(false);
  store.set({ keys: { ...store.get().keys, toggle_front_matter: "Mod+KeyJ" } });
  expect(c.onKeyDown(key("KeyJ", { meta: true }))).toBe(true);
  await settle();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ show_front_matter: true }));
  expect(store.get().showFrontMatter).toBe(true);
  expect(editor.showFrontMatter).toBe(true);
});

test("restore snapshots keys typed during the revision read, and refuses while busy", async () => {
  const { c, api, editor, store } = setup();
  await c.runSearch(true);
  await settle();
  editor.text = "now";
  const rev = deferred<string>();
  api.readRevision.mockReturnValueOnce(rev.promise);
  const p = c.restoreRevision("42");
  await settle();
  editor.text = "now+typed";
  rev.resolve("then");
  await p;
  expect(api.snapshotText).toHaveBeenLastCalledWith(P("A"), "now+typed");
  expect(editor.text).toBe("then");

  c.busy = true;
  await c.restoreRevision("42");
  expect(store.get().err).toBe("Busy — try again in a moment");
  expect(api.readRevision).toHaveBeenCalledTimes(1);
});

test("info loads only while open", async () => {
  const { c, api, store } = setup();
  await c.runSearch(true);
  await settle();
  expect(api.listRevisions).not.toHaveBeenCalled();
  api.listRevisions.mockResolvedValue([{ id: "1", ts: 5, size: 1, agent: false }]);
  await c.toggleInfo();
  await settle();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ info_panel: true }));
  expect(store.get().info.revisions).toEqual([{ id: "1", ts: 5, size: 1, agent: false }]);
});

test("meta updates after save", async () => {
  const { c, store, editor } = setup({ A: "one two three" });
  store.set({ infoOpen: true });
  await c.runSearch(true);
  await settle();
  expect(store.get().info.words).toBe(3);
  editor.text = "---\nx: 1\n---\nfour words in #tag";
  c.editorOpts().onMeta({ ...noMeta, modified: 9, modified_src: "frontmatter", tags: ["fm"] });
  await settle();
  expect(store.get().info.meta?.modified).toBe(9);
  expect(store.get().info.words).toBe(4);
  expect(store.get().info.tags).toEqual(["fm", "tag"]);
});

test("restore asks for confirmation and does nothing when declined", async () => {
  const { c, api, editor, calls, answers } = setup();
  await c.runSearch(true);
  await settle();
  editor.text = "now";
  answers.confirm = false;
  await c.restoreRevision("42");
  expect(calls.find((x) => x[0] === "confirm")?.[2]).toEqual({ title: "Restore revision", okLabel: "Restore" });
  expect(String(calls.find((x) => x[0] === "confirm")?.[1])).toMatch(/^Replace the note with this version from .+\? The current text is kept as a revision\.$/);
  expect(api.readRevision).not.toHaveBeenCalled();
  expect(editor.text).toBe("now");
});

const task = (title: string, line: number, line_text: string): TaskItem => ({ path: P(title), title, line, text: line_text.replace(/^- \[.\] /, ""), due: null, done: false, done_on: null, line_text, archived: false });
const view = (due_count: number) => ({ overdue: [], today: [], upcoming: [], no_date: [], done: [], due_count });

test("tick on the open note goes through the editor", async () => {
  const { c, api, editor } = setup({ A: "x\n- [ ] buy" });
  await c.show(P("A"));
  await c.tickTask(task("A", 1, "- [ ] buy"));
  expect(editor.toggleTask).toHaveBeenCalledWith(1);
  expect(api.toggleTask).not.toHaveBeenCalled();
});

test("tick on the open note refuses a line the editor no longer has", async () => {
  const { c, api, editor, store } = setup({ A: "x\n- [ ] milk" });
  await c.show(P("A"));
  await c.tickTask(task("A", 1, "- [ ] buy"));
  expect(editor.toggleTask).not.toHaveBeenCalled();
  expect(api.tasks).toHaveBeenCalled();
  expect(store.get().err).toBe("This task changed — refreshed");
});

test("tick on a closed note calls the backend and offers undo", async () => {
  const { c, api, store } = setup();
  const ticked = toggleTaskLine("- [ ] buy", localToday())!;
  api.toggleTask.mockResolvedValueOnce({ line: 7, line_text: ticked }); // the save stamped front matter above it
  await c.tickTask(task("B", 2, "- [ ] buy"));
  expect(api.toggleTask).toHaveBeenCalledWith(P("B"), 2, "- [ ] buy");
  expect(store.get().tickUndo).toEqual({ path: P("B"), line: 7, lineText: ticked, unticked: false });
  await c.undoTick();
  expect(api.toggleTask).toHaveBeenLastCalledWith(P("B"), 7, ticked);
  expect(store.get().tickUndo).toBeNull();
});

test("task-moved refreshes and says so", async () => {
  const { c, api, store } = setup();
  api.toggleTask.mockRejectedValueOnce("task-moved");
  await c.tickTask(task("B", 2, "- [ ] buy"));
  expect(api.tasks).toHaveBeenCalled();
  expect(store.get().err).toBe("This task changed — refreshed");
  expect(store.get().tickUndo).toBeNull();
});

test("loadTasks sets the badge", async () => {
  const { c, api, store } = setup();
  api.tasks.mockResolvedValue(view(3));
  await c.loadTasks();
  expect(api.setBadge).toHaveBeenCalledWith(3);
  expect(store.get().taskView?.due_count).toBe(3);
  expect(store.get().dueCount).toBe(3);
});

test("the badge ignores the search filter", async () => {
  const { c, api, store } = setup();
  api.tasks.mockImplementation(async (q) => view(q ? 1 : 4));
  c.setPaneMode("tasks");
  c.setQuery("x");
  await settle();
  expect(store.get().taskView?.due_count).toBe(1);
  expect(api.setBadge).toHaveBeenLastCalledWith(4);
  expect(store.get().dueCount).toBe(4);
});

test("typing a search in Tasks does one scan; the badge is recomputed only on note changes", async () => {
  const { c, api } = setup();
  c.setPaneMode("tasks");
  await settle();
  api.tasks.mockClear();
  c.setQuery("x");
  await settle();
  expect(api.tasks).toHaveBeenCalledTimes(1);
  await c.onNotesChanged([]);
  expect(api.tasks).toHaveBeenCalledTimes(3); // view + unfiltered badge scan
});

test("search and tags are shared between modes", async () => {
  const { c, api } = setup();
  c.setPaneMode("tasks");
  c.setQuery("x");
  await settle();
  expect(api.tasks).toHaveBeenCalledWith("x", [], false, false);
  c.setTags(["work"]);
  await settle();
  expect(api.tasks).toHaveBeenCalledWith("x", ["work"], false, false);
  await c.toggleShowDone();
  expect(api.tasks).toHaveBeenCalledWith("x", ["work"], true, false);
});

test("undo toast expires", async () => {
  vi.useFakeTimers();
  try {
    const { c, store } = setup();
    await c.tickTask(task("B", 2, "- [ ] buy"));
    expect(store.get().tickUndo).not.toBeNull();
    vi.advanceTimersByTime(4999);
    expect(store.get().tickUndo).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.get().tickUndo).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("openTask shows the note and reveals the line", async () => {
  const { c, editor, store } = setup({ A: "x\n- [ ] buy" });
  await c.openTask(task("A", 1, "- [ ] buy"));
  expect(store.get().openPath).toBe(P("A"));
  expect(editor.revealed).toEqual([1]);
});

test("toggle_tasks switches the pane and notes-changed refreshes tasks", async () => {
  const { c, api, store } = setup();
  c.onKeyDown({ key: "x", code: "KeyX", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, repeat: false, inEditor: false, inSearchWithText: false, inDialog: false, inRename: false });
  expect(store.get().paneMode).toBe("tasks");
  await settle();
  expect(api.tasks).toHaveBeenCalledTimes(1);
  await c.onNotesChanged([]);
  expect(api.tasks).toHaveBeenCalledTimes(2);
});

const KEY_C = { key: "c", code: "KeyC", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, repeat: false, inEditor: false, inSearchWithText: false, inDialog: false, inRename: false };
const KEY_P = { key: "p", code: "KeyP", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, inEditor: false, inSearchWithText: false, inDialog: false, inRename: false };

test("⌘⇧C opens the side panel on Related for the open note; again, it closes; ⌘I keeps the tab", async () => {
  const { c, api, store, editor } = setup();
  let saved = await api.getSettings(); // the fake api must hand back what was saved: toggleInfo reads it
  api.getSettings.mockImplementation(async () => ({ ...saved }));
  api.setSettings.mockImplementation(async (x) => void (saved = x));
  await c.show(P("A"));
  const order: string[] = [];
  editor.flush.mockImplementation(async () => (order.push("flush"), true));
  api.connections.mockImplementationOnce(async (p: string) => (order.push("connections"), { ...emptyConnections, centre: { ...emptyConnections.centre, path: p } }));
  c.onKeyDown(KEY_C);
  await settle();
  expect(store.get()).toMatchObject({ infoOpen: true, sideTab: "related", paneMode: "notes", focusRelated: 1 });
  expect(api.connections).toHaveBeenCalledWith(P("A"), false);
  expect(store.get().related).toMatchObject({ centre: P("A"), err: "" });
  expect(store.get().related?.data?.centre.path).toBe(P("A"));
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ info_panel: true }));
  c.onKeyDown(KEY_C);
  await settle();
  expect(store.get().infoOpen).toBe(false);
  await c.toggleInfo();
  expect(store.get()).toMatchObject({ infoOpen: true, sideTab: "related" });
});

test("the Related tab follows the open note, reloads when notes change, and is idle on the Info tab", async () => {
  const { c, api, store } = setup();
  await c.show(P("A"));
  await c.toggleRelated();
  api.connections.mockClear();
  await c.show(P("B"));
  await settle();
  expect(api.connections).toHaveBeenLastCalledWith(P("B"), false);
  expect(store.get().related?.centre).toBe(P("B"));
  api.connections.mockClear();
  await c.onNotesChanged([]);
  await settle();
  expect(api.connections).toHaveBeenCalledWith(P("B"), false);
  c.setSideTab("info");
  api.connections.mockClear();
  await c.show(P("A"));
  await settle();
  expect(api.connections).not.toHaveBeenCalled();
  c.setSideTab("related");
  await settle();
  expect(api.connections).toHaveBeenCalledWith(P("A"), false);
});

test("⌘⇧C without an open note shows the panel's empty state and loads nothing", async () => {
  const { c, api, store } = setup();
  c.onKeyDown(KEY_C);
  await settle();
  expect(store.get()).toMatchObject({ infoOpen: true, sideTab: "related", related: null });
  expect(api.connections).not.toHaveBeenCalled();
});

test("a locked note shows Note is locked in Related", async () => {
  const { c, api, store } = setup();
  await c.show(P("A"));
  api.connections.mockRejectedValueOnce("locked");
  await c.toggleRelated();
  expect(store.get().related).toMatchObject({ centre: P("A"), err: "Note is locked", data: null });
});

test("the trail row: previousPath is where back would go; createMissing opens a new note", async () => {
  const { c, api, store } = setup();
  expect(c.previousPath()).toBeNull();
  await c.show(P("A"));
  await c.show(P("B"));
  expect(c.previousPath()).toBe(P("A"));
  await c.createMissing("New one");
  expect(api.openOrCreate).toHaveBeenCalledWith("New one");
  expect(store.get().title).toBe("New one");
});


test("capture into the open Inbox appends through the editor", async () => {
  const { c, api, editor, store } = setup({ Inbox: "- [ ] old", B: "b" });
  await c.show(P("Inbox"));
  editor.dirty = true; // unsaved typing in the note: the editor stays the one writer
  await c.startCapture();
  expect(store.get().capture).toEqual({ target: "Inbox", err: "" });
  c.setQuery("buy milk");
  await c.submitCapture("buy milk");
  expect(api.captureTask).not.toHaveBeenCalled();
  expect(editor.appended).toEqual(["- [ ] buy milk"]);
  expect(api.captureDone).toHaveBeenCalledWith(true);
  expect(store.get().capture).toBeNull();
});

test("capture into a closed note calls the backend", async () => {
  const { c, api, editor, store } = setup();
  await c.show(P("A"));
  await c.startCapture();
  await c.submitCapture("buy milk");
  expect(api.captureTask).toHaveBeenCalledWith("buy milk");
  expect(editor.appended).toEqual([]);
  expect(api.captureDone).toHaveBeenCalledWith(true);
  expect(store.get().capture).toBeNull();
});

test("capture error keeps the text", async () => {
  const { c, api, store } = setup();
  api.captureTask.mockRejectedValueOnce("locked");
  await c.startCapture();
  c.setQuery("buy milk");
  await c.submitCapture("buy milk");
  expect(store.get().capture?.err).toBe("Inbox is locked");
  expect(store.get().query).toBe("buy milk");
  expect(api.captureDone).not.toHaveBeenCalled();
});

test("Esc and empty Enter leave capture mode and call captureDone", async () => {
  const { c, api, store } = setup();
  await c.startCapture();
  c.cancelCapture();
  expect(store.get().capture).toBeNull();
  expect(api.captureDone).toHaveBeenCalledTimes(1);
  await c.startCapture();
  await c.submitCapture("  ");
  expect(store.get().capture).toBeNull();
  expect(api.captureDone).toHaveBeenCalledTimes(2);
  expect(api.captureDone.mock.calls).toEqual([[true], [true]]);
  expect(api.captureTask).not.toHaveBeenCalled();
});

test("capture mode does not search while typing; blur keeps the text as the query", async () => {
  const { c, api, store } = setup();
  await c.startCapture();
  const n = api.search.mock.calls.length;
  c.setQuery("buy");
  expect(api.search.mock.calls.length).toBe(n);
  c.blurCapture();
  expect(store.get().capture).toBeNull();
  expect(store.get().query).toBe("buy");
  expect(api.search.mock.calls.length).toBe(n + 1);
  expect(api.captureDone.mock.calls).toEqual([[false]]); // the session ends, velo stays shown
});

test("a second Enter while a capture is in flight does nothing; text typed meanwhile survives", async () => {
  const { c, api, store } = setup();
  const d = deferred<string>();
  api.captureTask.mockImplementationOnce(() => d.promise);
  await c.startCapture();
  c.setQuery("buy milk");
  const first = c.submitCapture("buy milk");
  await settle();
  await c.submitCapture("buy milk");
  c.setQuery("buy milk and eggs");
  d.resolve("/n/Inbox.md");
  await first;
  expect(api.captureTask).toHaveBeenCalledTimes(1);
  expect(store.get().query).toBe("buy milk and eggs");
});

test("a blur during an in-flight capture: success does not hide velo", async () => {
  const { c, api, store } = setup();
  const d = deferred<string>();
  api.captureTask.mockImplementationOnce(() => d.promise);
  await c.startCapture();
  c.setQuery("buy milk");
  const p = c.submitCapture("buy milk");
  await settle();
  c.blurCapture();
  d.resolve("/n/Inbox.md");
  await p;
  expect(api.captureDone.mock.calls).toEqual([[false]]);
  expect(store.get().capture).toBeNull();
});

test("submit re-reads the target: a capture across midnight never writes yesterday's open daily note", async () => {
  const { c, api, editor } = setup({ "2026-10-26": "", B: "b" });
  await c.show(P("2026-10-26"));
  api.captureTargetTitle.mockResolvedValueOnce({ title: "2026-10-26", path: P("2026-10-26") }).mockResolvedValueOnce({ title: "2026-10-27", path: null });
  await c.startCapture();
  await c.submitCapture("buy milk");
  expect(editor.appended).toEqual([]);
  expect(api.captureTask).toHaveBeenCalledWith("buy milk");
});

test("daily_note opens today's note", async () => {
  const { c, api } = setup();
  c.onKeyDown({ key: "D", code: "KeyD", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, repeat: false, inEditor: false, inSearchWithText: false, inDialog: false, inRename: false });
  await settle();
  expect(api.openOrCreate).toHaveBeenCalledWith(localToday());
});

test("alt-enter creates a checklist note", async () => {
  const { c, api, editor, store } = setup();
  c.setQuery("groceries");
  await settle();
  await c.enter(true, true);
  expect(api.openOrCreate).toHaveBeenCalledWith("groceries");
  expect(store.get().openPath).toBe(P("groceries"));
  expect(editor.appended).toEqual(["- [ ] "]);
});

test("alt-enter on an existing title just opens it", async () => {
  const { c, editor, store } = setup();
  c.setQuery("B");
  await settle();
  await c.enter(true, true);
  expect(store.get().openPath).toBe(P("B"));
  expect(editor.appended).toEqual([]);
});

test("checklist append skips an existing note the title cache did not know", async () => {
  const { c, editor } = setup({ B: "has text" });
  await c.openTitle("B", "enter", true); // titles cache is empty: looks created
  expect(editor.appended).toEqual([]);
});

test("unticking a done task offers 'Unticked' undo", async () => {
  const { c, store } = setup();
  await c.tickTask({ ...task("B", 2, "- [x] buy ✅ 2026-10-20"), done: true });
  expect(store.get().tickUndo?.unticked).toBe(true);
});

test("Enter in Tasks mode opens the first visible task; Shift/Alt+Enter create the note as typed", async () => {
  const { c, api, store, editor } = setup({ A: "x\n- [ ] a", B: "- [ ] b" });
  api.tasks.mockResolvedValue({ ...view(1), today: [task("B", 0, "- [ ] b")], no_date: [task("A", 1, "- [ ] a")] });
  c.setPaneMode("tasks");
  c.setQuery("groceries");
  await settle();
  await c.enter();
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("B"));
  expect(editor.revealed).toEqual([0]);
  await c.enter(true, true);
  expect(api.openOrCreate).toHaveBeenCalledWith("groceries");
  expect(store.get().openPath).toBe(P("groceries"));
  expect(editor.appended).toEqual(["- [ ] "]);
});

test("Enter in Tasks mode with no matching task creates the note, or opens the exact title", async () => {
  const { c, api, store, editor } = setup({ B: "b" });
  c.setPaneMode("tasks");
  c.setQuery("  New one ");
  await settle();
  await c.enter();
  expect(api.openOrCreate).toHaveBeenLastCalledWith("New one");
  expect(store.get().openPath).toBe(P("New one"));
  c.setQuery("B");
  await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("B"));
  expect(editor.revealed).toEqual([]);
});

test("Enter in Tasks mode never creates a note from a view whose reload failed", async () => {
  const { c, api } = setup();
  c.setPaneMode("tasks");
  c.setQuery("groceriesX");
  await settle();
  api.tasks.mockRejectedValueOnce("disk error");
  c.setQuery("groceries");
  await settle();
  await c.enter();
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

test("Enter in Tasks mode with an empty search does nothing", async () => {
  const { c, api } = setup();
  c.setPaneMode("tasks");
  await settle();
  await c.enter();
  await c.enter(true);
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

test("refreshIfNewDay reloads tasks only after the day changed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(2026, 9, 27, 23, 0));
    const { c, api } = setup();
    await c.loadTasks();
    const n = api.tasks.mock.calls.length;
    c.refreshIfNewDay();
    expect(api.tasks.mock.calls.length).toBe(n);
    vi.setSystemTime(new Date(2026, 9, 28, 7, 0)); // woke from sleep past midnight
    c.refreshIfNewDay();
    expect(api.tasks.mock.calls.length).toBe(n + 1);
  } finally {
    vi.useRealTimers();
  }
});

test("capture without a notes folder says so", async () => {
  const { c, api, store } = setup();
  api.captureTask.mockRejectedValueOnce("no-folder");
  await c.startCapture();
  await c.submitCapture("buy milk");
  expect(store.get().capture?.err).toBe("No notes folder");
});

test("capture whose target is an alias of the open note appends through the editor", async () => {
  const { c, api, editor } = setup({ Todo: "---\naliases: [Inbox]\n---\n", B: "b" });
  await c.show(P("Todo"));
  api.captureTargetTitle.mockResolvedValue({ title: "Inbox", path: P("Todo") });
  await c.startCapture();
  await c.submitCapture("buy milk");
  expect(api.captureTask).not.toHaveBeenCalled();
  expect(editor.appended).toEqual(["- [ ] buy milk"]);
});

test("the daily-note shortcut in capture mode keeps the capture text", async () => {
  const { c, api, store } = setup({ A: "a" });
  await c.startCapture();
  c.setQuery("buy milk");
  c.onKeyDown(key("KeyD", { meta: true, shift: true }, { inSearchWithText: true }));
  await settle();
  expect(api.openOrCreate).toHaveBeenCalledWith(localToday());
  expect(store.get().query).toBe("buy milk");
  await c.submitCapture(store.get().query);
  expect(api.captureTask).toHaveBeenCalledWith("buy milk");
});

test("creating a note from a wikilink after a capture blur keeps the kept text", async () => {
  const { c, store } = setup({ A: "a" });
  await c.startCapture();
  c.setQuery("buy milk");
  c.blurCapture();
  await settle();
  await c.openTitle("New note", "wikilink");
  expect(store.get().query).toBe("buy milk");
  c.setQuery("x"); // once edited it is a normal search again
  await settle();
  await c.openTitle("Other", "wikilink");
  expect(store.get().query).toBe("Other");
});

test("Lock all reloads the tasks: decrypted rows, the due count and the badge go", async () => {
  const { c, api, store } = setup({ A: "a" });
  const secret: TaskItem = { path: "/n/S.md.age", title: "S", line: 0, text: "secret", due: localToday(), done: false, done_on: null, line_text: "- [ ] secret", archived: false };
  api.tasks.mockResolvedValue({ overdue: [], today: [secret], upcoming: [], no_date: [], done: [], due_count: 1 });
  c.setPaneMode("tasks");
  await settle();
  expect(store.get().dueCount).toBe(1);
  api.tasks.mockResolvedValue({ overdue: [], today: [], upcoming: [], no_date: [], done: [], due_count: 0 });
  await c.lockEverything();
  await settle();
  expect(store.get().taskView?.today).toEqual([]);
  expect(store.get().dueCount).toBe(0);
  expect(api.setBadge).toHaveBeenLastCalledWith(0);
});

test("Lock all reloads the Related tab and the link targets", async () => {
  const { c, api, store } = setup();
  await c.show(P("A"));
  c.onKeyDown(KEY_C);
  await settle();
  expect(store.get()).toMatchObject({ infoOpen: true, sideTab: "related" });
  api.connections.mockClear();
  api.listLinkTargets.mockClear();
  c.setSideTab("info"); // closed to Related: the stale tree (its missing link texts are plaintext) must go, not linger
  await c.lockEverything();
  await settle();
  expect(store.get().related).toBeNull();
  expect(api.listLinkTargets).toHaveBeenCalled();
  c.setSideTab("related");
  await settle();
  expect(api.connections).toHaveBeenCalledWith(P("A"), false);
});

test("typing a filter in Tasks mode never opens a note; back in Notes the list follows without opening", async () => {
  const { c, api, store } = setup({ A: "a", "milk run": "x" });
  c.setPaneMode("tasks");
  await settle();
  c.setQuery("milk");
  c.setTags(["home"]);
  await settle();
  expect(store.get().openPath).toBe(null);
  expect(api.openNote).not.toHaveBeenCalled();
  expect(api.tasks).toHaveBeenCalledWith("milk", ["home"], false, false);
  const n = api.search.mock.calls.length;
  c.setPaneMode("notes");
  await settle();
  expect(api.search.mock.calls.length).toBe(n + 1);
  expect(api.openNote).not.toHaveBeenCalled();
});

/** Real DOM: focusing the editor blurs the search field (and so ends capture mode). */
function setupBlurOnFocus(notes: Record<string, string>) {
  const t = setup(notes);
  t.editor.focus = () => { t.editor.focused++; t.c.blurCapture(); };
  return t;
}

test("⇧⌘D in capture mode: the editor focus blurs the field, the daily note stays open and the text is kept", async () => {
  const { c, store } = setupBlurOnFocus({ Groceries: "buy milk" });
  await c.startCapture();
  c.setQuery("buy milk");
  c.onKeyDown(key("KeyD", { meta: true, shift: true }, { inSearchWithText: true }));
  await settle();
  await settle();
  expect(store.get().capture).toBeNull();
  expect(store.get().query).toBe("buy milk");
  expect(store.get().openPath).toBe(P(localToday()));
});

test("clicking into the open note during capture keeps that note open; the kept text only lists", async () => {
  const { c, api, store } = setup({ Groceries: "buy milk", X: "x" });
  await c.show(P("X"));
  await c.startCapture();
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 })); // the query matches Groceries only
  c.setQuery("milk");
  const n = api.search.mock.calls.length;
  c.blurCapture();
  await settle();
  expect(api.search.mock.calls.length).toBe(n + 1);
  expect(store.get().openPath).toBe(P("X"));
  expect(store.get().sel).toBe(0); // X is not listed for "milk": row 0 highlighted, not opened
});

test("back to Notes after a Tasks filter never changes the open note", async () => {
  const { c, api, store } = setup({ Groceries: "a", X: "x" });
  await c.show(P("X"));
  c.setPaneMode("tasks");
  await settle();
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 })); // the query matches Groceries only
  c.setQuery("groc");
  await settle();
  c.setPaneMode("notes");
  await settle();
  expect(store.get().openPath).toBe(P("X"));
  expect(api.openNote).toHaveBeenCalledTimes(1);
  expect(store.get().sel).toBe(0); // row 0 highlighted, not opened
});

test("back to Notes, Enter opens the listed match (never creates a stray note), even before the refresh lands", async () => {
  const { c, api, store } = setup({ Groceries: "a", X: "x" });
  await c.show(P("X"));
  c.setPaneMode("tasks");
  await settle();
  c.setQuery("groc");
  await settle();
  const d = deferred<Page>();
  api.search.mockImplementationOnce(() => d.promise);
  c.setPaneMode("notes");
  const entered = c.enter(); // the refresh is still in flight
  d.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
  await entered;
  await settle();
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("Groceries"));
});

test("a pruned tag filter never changes the open note, in Notes or Tasks mode", async () => {
  for (const mode of ["notes", "tasks"] as const) {
    const { c, api, store } = setup({ Groceries: "a", X: "x" });
    await c.show(P("X"));
    c.setPaneMode(mode);
    api.listTags.mockResolvedValue([{ tag: "work", count: 1 }]);
    c.setTags(["work"]);
    await c.refreshTags();
    await settle();
    api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 }));
    api.listTags.mockResolvedValue([]); // the last #work went away
    await c.refreshTags(true);
    await settle();
    expect(store.get().selectedTags).toEqual([]);
    expect(store.get().openPath).toBe(P("X"));
    expect(api.openNote).toHaveBeenCalledTimes(1);
  }
});

/** Holds api.openNote's next reply until the returned gate opens. */
function holdOpen(api: ReturnType<typeof setup>["api"]) {
  const gate = deferred<void>();
  const real = api.openNote.getMockImplementation()!;
  api.openNote.mockImplementationOnce(async (p: string) => {
    await gate.promise;
    return real(p);
  });
  return gate;
}
const taskOf = (path: string, line_text: string, line = 0): TaskItem => ({ path, title: "", line, text: line_text.slice(6), due: null, done: false, done_on: null, line_text, archived: false });

test("a tick while its note is loading waits for the load and goes through the editor", async () => {
  const { c, api, editor } = setup({ A: "- [ ] x", B: "b" });
  const gate = holdOpen(api);
  const shown = c.show(P("A"));
  await settle();
  editor.toggleTask.mockReturnValue(true);
  const ticked = c.tickTask(taskOf(P("A"), "- [ ] x"));
  await settle();
  expect(api.toggleTask).not.toHaveBeenCalled();
  gate.resolve();
  await shown;
  await ticked;
  expect(api.toggleTask).not.toHaveBeenCalled(); // a backend write would leave the editor on pre-write text and hash
  expect(editor.toggleTask).toHaveBeenCalledWith(0);
});

test("a capture while the target note is loading waits and appends through the editor", async () => {
  const { c, api, editor, store } = setup({ Inbox: "", B: "b" });
  await c.startCapture();
  c.setQuery("buy");
  const gate = holdOpen(api);
  const shown = c.show(P("Inbox"));
  await settle();
  const sent = c.submitCapture("buy");
  await settle();
  gate.resolve();
  await shown;
  await sent;
  expect(api.captureTask).not.toHaveBeenCalled();
  expect(editor.appended).toEqual(["- [ ] buy"]);
  expect(store.get().capture).toBeNull();
});

test("opening a note waits for a backend write to it in flight", async () => {
  const { c, api } = setup({ A: "- [ ] x", B: "b" });
  await c.show(P("B"));
  const w = deferred<{ line: number; line_text: string }>();
  api.toggleTask.mockImplementationOnce(() => w.promise);
  const ticked = c.tickTask(taskOf(P("A"), "- [ ] x"));
  await settle();
  const shown = c.show(P("A"));
  await settle();
  expect(api.openNote).not.toHaveBeenCalledWith(P("A")); // its reply would hold pre-write text and hash
  w.resolve({ line: 0, line_text: "- [x] x" });
  await ticked;
  await shown;
  expect(api.openNote).toHaveBeenCalledWith(P("A"));
});

test("capture into the open note: a failed save keeps capture mode, a retry re-saves without appending twice", async () => {
  const { c, api, editor, store } = setup({ Inbox: "", B: "b" });
  await c.show(P("Inbox"));
  await c.startCapture();
  c.setQuery("buy");
  editor.flushResult = false;
  await c.submitCapture("buy");
  expect(store.get().capture?.err).toMatch(/wasn't saved/);
  expect(store.get().query).toBe("buy");
  expect(api.captureDone).not.toHaveBeenCalled();
  editor.flushResult = true;
  await c.submitCapture("buy");
  expect(editor.appended).toEqual(["- [ ] buy"]);
  expect(store.get().capture).toBeNull();
  expect(api.captureDone).toHaveBeenCalledTimes(1);
});

test("Lock all drops the undo payload and a tasks reply that was in flight", async () => {
  const { c, api, store } = setup({ A: "a", B: "b" });
  await c.show(P("B"));
  await c.tickTask(taskOf(P("A"), "- [ ] secret"));
  expect(store.get().tickUndo).not.toBeNull();
  const stale = deferred<TaskView>();
  api.tasks.mockImplementationOnce(() => stale.promise);
  c.setPaneMode("tasks"); // this reply still holds the decrypted rows
  await settle();
  const search = deferred<Page>();
  api.search.mockImplementationOnce(() => search.promise); // Lock all's list refresh is still pending
  const locked = c.lockEverything();
  await settle();
  stale.resolve({ overdue: [], today: [], upcoming: [], no_date: [taskOf(P("A"), "- [ ] secret")], done: [], due_count: 1 });
  await settle();
  expect(store.get().tickUndo).toBeNull();
  expect(store.get().taskView?.no_date ?? []).toEqual([]);
  search.resolve({ hits: [hit("A"), hit("B")], has_more: false, total: 2, hidden: 0 });
  await locked;
  await settle();
  expect(store.get().taskView?.no_date).toEqual([]);
  expect(store.get().dueCount).toBe(0);
});

test("agent write to the open note goes through the editor and replies with the hash", async () => {
  const { c, api, editor } = setup({ A: "hello world" });
  await c.show(P("A"));
  const atSnapshot: string[] = [];
  api.snapshotAgent.mockImplementation(async () => (atSnapshot.push(editor.text), "1.md"));
  await c.onAgentWrite({ id: 7, path: P("A"), kind: "replace", insert: "hello there world", base: "h", summary: "s" });
  expect(editor.changes).toEqual([{ from: 6, to: 6, insert: "there " }]); // only the changed span: a small undo step
  expect(editor.text).toBe("hello there world");
  expect(api.snapshotAgent).toHaveBeenCalledWith(P("A"), "s");
  expect(atSnapshot).toEqual(["hello world"]); // snapshot of the text before the change
  expect(editor.flush).toHaveBeenCalled();
  expect(api.agentWriteDone).toHaveBeenCalledWith(7, { hash: "h" });
  expect(api.dropAgentSnapshot).not.toHaveBeenCalled(); // applied: its revision stays
});

test("agent append to the open note uses appendLine", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 1, path: P("A"), kind: "append", insert: "- [ ] milk", summary: "s" });
  expect(editor.appended).toEqual(["- [ ] milk"]);
  expect(api.agentWriteDone).toHaveBeenCalledWith(1, { hash: "h" });
});

test("agent write refused when the editor is read-only", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  editor.readOnly = true;
  await c.onAgentWrite({ id: 2, path: P("A"), kind: "replace", insert: "b", base: "h", summary: "s" });
  expect(editor.text).toBe("a");
  expect(api.agentWriteDone).toHaveBeenCalledWith(2, "refused");
});

test("agent write refused while busy", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  c.busy = true;
  await c.onAgentWrite({ id: 3, path: P("A"), kind: "replace", insert: "b", base: "h", summary: "s" });
  expect(editor.text).toBe("a");
  expect(api.agentWriteDone).toHaveBeenCalledWith(3, "refused");
});

test("an agent write waits for a note load in flight before saying not-open", async () => {
  const { c, api, editor } = setup({ A: "a", B: "b" });
  const d = deferred<ReturnType<typeof api.openNote> extends Promise<infer T> ? T : never>();
  api.openNote.mockImplementationOnce(() => d.promise);
  const shown = c.show(P("B"));
  await settle();
  const write = c.onAgentWrite({ id: 5, path: P("B"), kind: "append", insert: "- [ ] x", summary: "s" });
  d.resolve({ path: P("B"), title: "B", text: "b", hash: "h", encrypted: false, meta: noMeta, archived: false });
  await shown;
  await write;
  expect(api.agentWriteDone).toHaveBeenCalledWith(5, { hash: "h" }); // applied in the editor, not written behind it
  expect(editor.appended).toEqual(["- [ ] x"]);
});

test("a keystroke during the agent snapshot drops that snapshot", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  api.snapshotAgent.mockImplementationOnce(async () => { editor.text = "a typed"; editor.dirty = true; return "5.md"; });
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "replace", insert: "b", base: "h", summary: "s" });
  expect(api.agentWriteDone).toHaveBeenCalledWith(6, "conflict");
  expect(api.dropAgentSnapshot).toHaveBeenCalledWith(P("A"), "5.md"); // the write never happened: no revision for it
});

test("an agent write waits for a show still flushing the previous note", async () => {
  const { c, api, editor } = setup({ A: "a", B: "b" });
  await c.show(P("A"));
  const d = deferred<boolean>();
  editor.flush.mockImplementationOnce(() => d.promise);
  const shown = c.show(P("B"));
  await settle();
  const write = c.onAgentWrite({ id: 8, path: P("B"), kind: "append", insert: "- [ ] y", summary: "s" });
  await settle();
  d.resolve(true);
  await shown;
  await write;
  expect(api.agentWriteDone).toHaveBeenCalledWith(8, { hash: "h" }); // B ended up open: applied in the editor
  expect(editor.appended).toEqual(["- [ ] y"]);
});

test("a failed agent trash after the editor closed the note says so", async () => {
  const { c, api, store } = setup({ A: "a" });
  await c.onAgentWrite({ id: 9, path: P("A"), kind: "trash-failed", title: "A", error: "Trash unavailable" });
  expect(store.get().err).toBe("The agent couldn't move “A” to the Trash: Trash unavailable");
  expect(api.agentWriteDone).toHaveBeenCalledWith(9, "ok");
});

test("agent write gets not-open for another note", async () => {
  const { c, api, editor } = setup({ A: "a", B: "b" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 4, path: P("B"), kind: "replace", insert: "x", base: "h", summary: "s" });
  expect(api.agentWriteDone).toHaveBeenCalledWith(4, "not-open");
  expect(api.snapshotAgent).not.toHaveBeenCalled();
  expect(editor.text).toBe("a");
});

test("agent write conflicts when the saved note moved on from its base", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 5, path: P("A"), kind: "replace", insert: "b", base: "stale", summary: "s" });
  expect(editor.text).toBe("a");
  expect(api.agentWriteDone).toHaveBeenCalledWith(5, "conflict");
});

test("agent write conflicts when the user typed during the round trip", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  api.openNote.mockImplementationOnce(async (path: string) => {
    editor.text = "a typed";
    editor.dirty = true;
    return { path, title: "A", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false };
  });
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "replace", insert: "b", base: "h", summary: "s" });
  expect(editor.text).toBe("a typed"); // the keystroke survives
  expect(api.agentWriteDone).toHaveBeenCalledWith(6, "conflict");
});

test("agent write the backend gave up on (claim refused) changes nothing and sends no reply", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  api.agentWriteClaim.mockResolvedValueOnce(false);
  await c.onAgentWrite({ id: 8, path: P("A"), kind: "append", insert: "- [ ] late", summary: "s" });
  expect(editor.appended).toEqual([]);
  expect(api.snapshotAgent).not.toHaveBeenCalled();
  expect(api.agentWriteDone).not.toHaveBeenCalled();
});

test("agent write conflicts when an autosave left the editor newer than its read", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  editor.text = "a saved later"; // clean, but not what the agent's text was computed from
  await c.onAgentWrite({ id: 9, path: P("A"), kind: "replace", insert: "b", base: "h", summary: "s" });
  expect(editor.text).toBe("a saved later");
  expect(api.snapshotAgent).not.toHaveBeenCalled(); // no agent revision for a refused write
  expect(api.agentWriteDone).toHaveBeenCalledWith(9, "conflict");
});

test("two interleaved agent writes: the second, based on the old text, conflicts", async () => {
  const { c, api, editor, notes } = setup({ A: "hello world" });
  await c.show(P("A"));
  api.openNote.mockImplementation(async (path: string) => ({ path, title: "A", text: notes.A, hash: `h:${notes.A}`, encrypted: false, meta: noMeta, archived: false }));
  editor.flush.mockImplementation(async () => ((notes.A = editor.text), (editor.dirty = false), true));
  const one = c.onAgentWrite({ id: 1, path: P("A"), kind: "replace", insert: "hello there world", base: "h:hello world", summary: "s" });
  const two = c.onAgentWrite({ id: 2, path: P("A"), kind: "replace", insert: "hello world!", base: "h:hello world", summary: "s" });
  await Promise.all([one, two]);
  expect(editor.text).toBe("hello there world");
  expect(api.agentWriteDone).toHaveBeenCalledWith(1, { hash: "h:hello there world" });
  expect(api.agentWriteDone).toHaveBeenCalledWith(2, "conflict");
});

test("agent trash of the open note saves and closes it first", async () => {
  const { c, api, editor, store } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 3, path: P("A"), kind: "trash", summary: "s" });
  expect(editor.flush).toHaveBeenCalled();
  expect(editor.currentPath()).toBe(null);
  expect(store.get().openPath).toBe(null);
  expect(api.agentWriteDone).toHaveBeenCalledWith(3, "closed");
});

test("agent trash keeps the note's stored position when the backend then fails to trash it", async () => {
  const { c, editor } = setup({ A: "a" });
  await c.show(P("A"));
  setPos(P("A"), { h: 1, t: 0, m: 0 });
  await c.onAgentWrite({ id: 3, path: P("A"), kind: "trash", summary: "s" });
  expect(editor.currentPath()).toBe(null);
  await c.onAgentWrite({ id: 4, path: P("A"), kind: "trash-failed", title: "A", error: "Trash unavailable" });
  expect(getPos(P("A"))).toBeDefined();
});

test("agent trash refused when the open note can't be saved", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  editor.dirty = true;
  editor.flushResult = false;
  await c.onAgentWrite({ id: 4, path: P("A"), kind: "trash", summary: "s" });
  expect(editor.currentPath()).toBe(P("A"));
  expect(api.agentWriteDone).toHaveBeenCalledWith(4, "refused");
});

test("agent rename freezes the open note, then follows it to the new path", async () => {
  const { c, api, editor, store, notes } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 5, path: P("A"), kind: "rename", summary: "s" });
  expect(api.agentWriteDone).toHaveBeenCalledWith(5, "ready");
  expect(editor.suspended).toBe(true);
  expect(c.busy).toBe(true);
  notes.B = notes.A; // the backend renamed A.md to B.md
  delete notes.A;
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "renamed", to: P("B") });
  expect(editor.currentPath()).toBe(P("B"));
  expect(store.get().openPath).toBe(P("B"));
  expect(store.get().title).toBe("B");
  expect(editor.suspended).toBe(false); // rebind alone keeps the freeze: resume() must end it
  expect(c.busy).toBe(false);
  expect(api.agentWriteDone).toHaveBeenCalledWith(6, "ok");
});

test("agent rename racing a notes-folder change: the header never names a note the editor does not hold", async () => {
  const { c, api, store, editor, notes } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 5, path: P("A"), kind: "rename", summary: "s" });
  await c.saveSettings({ ...(await api.getSettings()), notes_dir: "/other" }); // ignores busy: unloads the editor
  notes.B = notes.A;
  delete notes.A;
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "renamed", to: P("B") });
  expect(editor.currentPath()).toBeNull();
  expect(store.get().openPath).toBeNull();
  expect(store.get().title).toBe("");
  expect(c.busy).toBe(false);
});

test("agent rename failing to reopen after another note was opened keeps that note's unsaved edits", async () => {
  const { c, api, editor, notes } = setup({ A: "a", C: "c" });
  await c.show(P("A"));
  const claim = deferred<boolean>();
  api.agentWriteClaim.mockImplementationOnce(() => claim.promise);
  const rename = c.onAgentWrite({ id: 5, path: P("A"), kind: "rename", summary: "s" });
  await vi.waitFor(() => expect(api.agentWriteClaim).toHaveBeenCalled());
  const open = deferred<any>();
  api.openNote.mockImplementationOnce(() => open.promise);
  const showing = c.show(P("C")); // busy is still false: passes the guard
  claim.resolve(true);
  await rename; // "ready": A suspended, busy
  open.resolve({ path: P("C"), text: "c", hash: "h:c", locked: false });
  await showing;
  expect(editor.currentPath()).toBe(P("C"));
  editor.replaceText("typed in C"); // the user edits C
  notes.B = notes.A;
  delete notes.A;
  api.openNote.mockRejectedValueOnce(new Error("io"));
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "renamed", to: P("B") });
  expect(editor.currentPath()).toBe(P("C"));
  expect(editor.text).toBe("typed in C");
  expect(c.busy).toBe(false);
});

test("agent rename that failed unfreezes the note where it was", async () => {
  const { c, editor } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 5, path: P("A"), kind: "rename", summary: "s" });
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "renamed", to: null });
  expect(editor.suspended).toBe(false);
  expect(editor.currentPath()).toBe(P("A"));
  expect(c.busy).toBe(false);
});

test("agent flush before a link rewrite saves the open note, or refuses", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 1, path: "", kind: "flush", paths: [P("B")] });
  expect(api.agentWriteDone).toHaveBeenLastCalledWith(1, "not-open");
  await c.onAgentWrite({ id: 2, path: "", kind: "flush", paths: [P("A")] });
  expect(api.agentWriteDone).toHaveBeenLastCalledWith(2, "flushed");
  editor.dirty = true;
  editor.flushResult = false;
  await c.onAgentWrite({ id: 3, path: "", kind: "flush", paths: [P("A")] });
  expect(api.agentWriteDone).toHaveBeenLastCalledWith(3, "refused");
});

test("agent write applied but not saved replies unsaved, never a retryable status", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  editor.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // saved before, not after the apply
  await c.onAgentWrite({ id: 10, path: P("A"), kind: "append", insert: "- [ ] once", summary: "s" });
  expect(editor.appended).toEqual(["- [ ] once"]);
  expect(api.agentWriteDone).toHaveBeenCalledWith(10, "unsaved");
});

test("agent write applied, then the hash read fails: unsaved, not refused", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  const open = api.openNote.getMockImplementation()!;
  api.openNote.mockImplementationOnce(open).mockRejectedValueOnce(new Error("io"));
  await c.onAgentWrite({ id: 11, path: P("A"), kind: "append", insert: "- [ ] once", summary: "s" });
  expect(editor.appended).toEqual(["- [ ] once"]);
  expect(api.agentWriteDone).toHaveBeenCalledWith(11, "unsaved");
});

test("notes-changed for the open note during an agent rename takes no snapshot and no reload", async () => {
  const { c, api, editor } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 5, path: P("A"), kind: "rename", summary: "s" });
  await c.onNotesChanged([P("A")]);
  expect(api.snapshotText).not.toHaveBeenCalled();
  expect(editor.onExternalChange).not.toHaveBeenCalled();
});

test("agent renamed: a failing history update still unfreezes the editor", async () => {
  const { c, editor } = setup({ A: "a" });
  await c.show(P("A"));
  await c.onAgentWrite({ id: 5, path: P("A"), kind: "rename", summary: "s" });
  (c as unknown as { history: { rename: () => void } }).history.rename = () => { throw new Error("boom"); };
  await c.onAgentWrite({ id: 6, path: P("A"), kind: "renamed", to: P("B") });
  expect(editor.suspended && editor.currentPath() !== null).toBe(false);
  expect(c.busy).toBe(false);
});

test("copyAgentSetup copies the command and returns the result for the Settings dialog", async () => {
  const { c, api, calls, store } = setup();
  expect(await c.copyAgentSetup()).toBe("Copied");
  expect(calls).toContainEqual(["copyText", "claude mcp add velo -- /velo --mcp"]);
  api.agentSetupCommand.mockRejectedValueOnce("no exe path");
  expect(await c.copyAgentSetup()).toBe("no exe path");
  expect(store.get().err).toBe(""); // the dialog covers the banner: the error is shown in the dialog instead
});

test("a background refresh keeps the row-0 highlight, so Enter opens the listed match (#8)", async () => {
  const { c, api, store } = setup({ Groceries: "a", X: "x" });
  await c.show(P("X"));
  c.setPaneMode("tasks");
  await settle();
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 }));
  c.setQuery("groc");
  await settle();
  c.setPaneMode("notes");
  await settle();
  expect(store.get().sel).toBe(0);
  await c.onNotesChanged([P("Other")]); // a sync touched another note
  expect(store.get().sel).toBe(0);
  await c.enter();
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("Groceries"));
});

test("capture into the open Inbox whose save lands in a conflict copy says so (#8)", async () => {
  const { c, editor, store } = setup({ Inbox: "", B: "b" });
  await c.show(P("Inbox"));
  await c.startCapture();
  c.setQuery("buy milk");
  editor.flush.mockImplementationOnce(async () => {
    c.editorOpts().onConflict("/n/Inbox (conflict).md"); // the saver wrote the text to a conflict copy and reloaded the disk text
    return true;
  });
  await c.submitCapture("buy milk");
  expect(store.get().err).toBe("Saved to a conflict copy — check Inbox");
});

test("Enter in Tasks mode waits for the task load in flight (#8)", async () => {
  const { c, api, store } = setup({ A: "- [ ] a", B: "- [ ] b" });
  api.tasks.mockResolvedValue({ ...view(0), no_date: [task("A", 0, "- [ ] a")] });
  c.setPaneMode("tasks");
  await settle();
  const d = deferred<TaskView>();
  api.tasks.mockImplementationOnce(() => d.promise);
  c.setQuery("b");
  const entered = c.enter();
  d.resolve({ ...view(0), no_date: [task("B", 0, "- [ ] b")] });
  await entered;
  expect(store.get().openPath).toBe(P("B"));
});

test("Tasks reload with the restored query when capture mode ends (#8)", async () => {
  for (const how of ["capture", "cancel"] as const) {
    const { c, api, store } = setup();
    api.tasks.mockImplementation(async (q) => ({ ...view(0), no_date: q === "q0" ? [task("A", 0, "- [ ] a")] : [] }));
    c.setPaneMode("tasks");
    c.setQuery("q0");
    await settle();
    await c.startCapture();
    c.setQuery("buy milk");
    await c.onNotesChanged([]); // a watcher refresh mid-capture reads the capture text
    if (how === "capture") await c.submitCapture("buy milk");
    else {
      c.setQuery(""); // an emptied field brings the earlier search back
      c.cancelCapture();
    }
    await settle();
    expect(store.get().taskView?.no_date, how).toHaveLength(1);
  }
});

test("pruning the last selected tag reloads the tasks without it (#8)", async () => {
  const { c, api, store } = setup();
  api.tasks.mockImplementation(async (_q, tags) => ({ ...view(0), no_date: tags.length ? [] : [task("A", 0, "- [ ] a")] }));
  c.setTags(["work"]);
  await settle();
  api.listTags.mockResolvedValue([]); // the last #work went away
  await c.onNotesChanged([]);
  await settle();
  expect(store.get().selectedTags).toEqual([]);
  expect(store.get().taskView?.no_date).toHaveLength(1);
});

test("alt-enter never adds a checklist to an existing empty note the title cache missed (#8)", async () => {
  const { c, editor } = setup({ B: "" });
  await c.openTitle("B", "enter", true);
  expect(editor.appended).toEqual([]);
});

test("a tick shows on the task row at once, before the reload (#8)", async () => {
  const { c, api, editor, store } = setup({ A: "- [ ] x", B: "- [ ] y" });
  api.tasks.mockResolvedValue({ ...view(0), no_date: [task("A", 0, "- [ ] x"), task("B", 0, "- [ ] y")] });
  await c.loadTasks();
  api.tasks.mockImplementation(() => new Promise(() => {})); // the reloads have not landed yet
  await c.show(P("A"));
  editor.toggleTask.mockImplementation(() => ((editor.text = "- [x] x ✅ 2026-10-27"), true));
  await c.tickTask(store.get().taskView!.no_date[0]);
  api.toggleTask.mockResolvedValueOnce({ line: 0, line_text: "- [x] y" });
  await c.tickTask(store.get().taskView!.no_date[1]);
  expect(store.get().taskView!.no_date.map((t) => [t.done, t.line_text])).toEqual([
    [true, "- [x] x ✅ 2026-10-27"],
    [true, "- [x] y"],
  ]);
});

test("own edit removes the filtered tag: the list highlights nothing, never another note (#15 F1)", async () => {
  const { c, api, store } = setup({ A: "a #work", B: "b #work", C: "c #work" });
  api.listTags.mockResolvedValue([{ tag: "work", count: 3 }]);
  api.search.mockImplementation(async () => ({ hits: [hit("A"), hit("B"), hit("C")], has_more: false, total: 3, hidden: 0 }));
  c.setTags(["work"]);
  await settle();
  await settle(); // A open, sel 0
  api.search.mockImplementation(async () => ({ hits: [hit("B"), hit("C")], has_more: false, total: 2, hidden: 0 }));
  c.editorOpts().onSaved(); // the user deleted #work from A; autosave landed
  await new Promise((r) => setTimeout(r, 350));
  await settle();
  expect([store.get().openPath, store.get().sel]).toEqual([P("A"), -1]);
});

test("a watcher refresh that drops the open note: arrows and Enter never act on the shifted row (#15 F1)", async () => {
  for (const act of ["step", "enter"] as const) {
    const { c, api, store } = setup();
    await c.runSearch(true);
    await settle(); // A open, sel 0
    api.search.mockImplementation(async () => ({ hits: [hit("B"), hit("C")], has_more: false, total: 2, hidden: 0 }));
    await c.onNotesChanged([P("A")]);
    expect(store.get().sel, act).toBe(-1);
    if (act === "step") {
      await c.step(1);
      expect(store.get().openPath, act).toBe(P("B"));
    } else {
      await c.enter();
      expect(store.get().openPath, act).toBe(P("A")); // empty query, nothing highlighted: nothing happens
    }
  }
});

test("a highlight follows its note through a refresh or a re-sort (#15 F1)", async () => {
  const { c, api, store } = setup({ Groceries: "a", X: "x", Y: "y" });
  await c.show(P("X"));
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries"), hit("Y")], has_more: false, total: 2, hidden: 0 }));
  c.setPaneMode("tasks");
  c.setQuery("g");
  await settle();
  c.setPaneMode("notes");
  await settle();
  expect(store.get().sel).toBe(0); // Groceries highlighted, X open and not listed
  api.search.mockImplementation(async () => ({ hits: [hit("Y"), hit("Groceries")], has_more: false, total: 2, hidden: 0 }));
  await c.onNotesChanged([]);
  expect(store.get().sel).toBe(1);
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries"), hit("Y")], has_more: false, total: 2, hidden: 0 }));
  await c.toggleSort();
  expect(store.get().sel).toBe(0);
  await c.enter();
  expect(store.get().openPath).toBe(P("Groceries"));
});

test("Enter in Tasks mode waits for every task load in flight, not only the first (#15 F2)", async () => {
  const { c, api, store } = setup({ A: "- [ ] a", B: "- [ ] b" });
  api.tasks.mockResolvedValue({ ...view(0), no_date: [task("A", 0, "- [ ] a")] });
  c.setPaneMode("tasks");
  await settle();
  const d1 = deferred<TaskView>();
  const d2 = deferred<TaskView>();
  api.tasks.mockImplementationOnce(() => d1.promise).mockImplementation(async (q) => (q === "b" ? d2.promise : view(0)));
  c.setQuery("b");
  const entered = c.enter();
  void c.loadTasks(); // a watcher or save refresh starts a newer load
  d1.resolve({ ...view(0), no_date: [task("B", 0, "- [ ] b")] });
  await settle();
  d2.resolve({ ...view(0), no_date: [task("B", 0, "- [ ] b")] });
  await entered;
  expect(store.get().openPath).toBe(P("B"));
});

test("a refresh landing while a typed query's search is in flight keeps its first match, so Enter opens it (#15 N1)", async () => {
  for (const how of ["typed", "pane switch"] as const) {
    const { c, api, store } = setup({ Groceries: "g", X: "x", Y: "y" });
    await c.show(P("X"));
    if (how === "typed") {
      await c.runSearch(true, true);
      await settle();
    } else {
      c.setPaneMode("tasks");
      c.setQuery("gro");
      await settle();
    }
    const d1 = deferred<Page>();
    const d2 = deferred<Page>();
    api.search.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise);
    if (how === "typed") c.setQuery("gro");
    else c.setPaneMode("notes"); // a "highlight" reset
    const w = c.onNotesChanged([]); // the watcher refresh overtakes it
    d1.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
    d2.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
    await w;
    await settle();
    await c.enter();
    expect(api.openOrCreate, how).not.toHaveBeenCalled();
    expect(store.get().openPath, how).toBe(P("Groceries"));
  }
});

test("Notes-mode Enter waits for the refresh that overtook the typed search (#15 M1)", async () => {
  const { c, api, store } = setup({ X: "x", Y: "y", Z: "z", Groceries: "g" });
  await c.runSearch(true, true);
  await settle();
  await c.show(P("Z")); // e.g. a wikilink to a note not on the first page
  store.set({ sel: -1 });
  const d1 = deferred<Page>();
  const d2 = deferred<Page>();
  api.search.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise);
  c.setQuery("gro");
  const entered = c.enter();
  void c.onNotesChanged([]);
  d1.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
  await settle();
  d2.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
  await entered;
  await settle();
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("Groceries"));
});

test("a sort toggle overtaking a typed search keeps its first match (#15 M2)", async () => {
  const { c, api, store } = setup({ Groceries: "g", X: "x", Y: "y" });
  await c.show(P("X"));
  await c.runSearch(true, true);
  await settle();
  const d1 = deferred<Page>();
  const d2 = deferred<Page>();
  api.search.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise);
  c.setQuery("gro");
  const sorted = c.toggleSort();
  await settle();
  d1.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
  d2.resolve({ hits: [hit("Groceries")], has_more: false, total: 1, hidden: 0 });
  await sorted;
  await settle();
  await c.enter();
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("Groceries"));
});

test("a capture retry never edits a line it did not write: after a conflict reload the older identical task stays (#15 Copilot)", async () => {
  for (const retry of ["buy milk", "buy mlik"]) {
    const { c, editor, store } = setup({ Inbox: "- [ ] buy mlik", B: "b" }); // the older task has the same text
    await c.show(P("Inbox"));
    await c.startCapture();
    c.setQuery("buy mlik");
    editor.flushResult = false;
    await c.submitCapture("buy mlik");
    editor.text = "- [ ] buy mlik"; // an autosave retry conflicted: the line went to a conflict copy, the editor reloaded the disk text
    c.setQuery(retry);
    editor.flushResult = true;
    await c.submitCapture(retry);
    expect(editor.text, retry).toBe(`- [ ] buy mlik\n- [ ] ${retry}`);
    expect(store.get().capture, retry).toBeNull();
  }
});

test("a backend tick still reloads the view after the optimistic patch (#15 Copilot)", async () => {
  const { c, api, store } = setup({ A: "a", B: "- [ ] y" });
  api.tasks.mockResolvedValue({ ...view(0), no_date: [task("B", 0, "- [ ] y")] });
  await c.loadTasks();
  api.toggleTask.mockResolvedValueOnce({ line: 0, line_text: "- [x] y ✅ 2026-10-27" });
  const d = deferred<TaskView>();
  api.tasks.mockImplementation(() => d.promise); // the reloads land after the tick returned
  await c.tickTask(store.get().taskView!.no_date[0]);
  d.resolve({ ...view(0), done: [{ ...task("B", 0, "- [x] y ✅ 2026-10-27"), done: true }] });
  await settle();
  expect(store.get().taskView!.no_date).toEqual([]);
  expect(store.get().taskView!.done).toHaveLength(1);
});

test("a tick through the editor never drops a filter load in flight (#15 r5 m1)", async () => {
  const { c, api, editor, store } = setup({ A: "- [ ] x", B: "- [ ] foo" });
  c.setPaneMode("tasks");
  api.tasks.mockResolvedValue({ ...view(0), no_date: [task("A", 0, "- [ ] x"), task("B", 0, "- [ ] foo")] });
  await c.loadTasks();
  await c.show(P("A"));
  const d = deferred<TaskView>();
  api.tasks.mockImplementationOnce(() => d.promise);
  c.setQuery("foo");
  editor.toggleTask.mockImplementation(() => ((editor.text = "- [x] x ✅ 2026-10-27"), true));
  await c.tickTask(store.get().taskView!.no_date[0]);
  d.resolve({ ...view(0), no_date: [task("B", 0, "- [ ] foo")] });
  await c.enter();
  expect(store.get().taskView!.no_date.map((t) => t.path)).toEqual([P("B")]);
  expect(store.get().openPath).toBe(P("B"));
});

test("a corrected capture after a failed save is a new capture: the earlier line stays and is saved with the note (#8)", async () => {
  const { c, editor, store } = setup({ Inbox: "", B: "b" });
  await c.show(P("Inbox"));
  await c.startCapture();
  c.setQuery("buy mlik");
  editor.flushResult = false;
  await c.submitCapture("buy mlik");
  c.setQuery("buy milk");
  editor.flushResult = true;
  await c.submitCapture("buy milk");
  expect(editor.text).toBe("- [ ] buy mlik\n- [ ] buy milk"); // no line edited or replaced
  expect(store.get().capture).toBeNull();
});

test("the saver's own retry saved the capture line (front matter restamped): a same-text Enter closes without a duplicate (#15 simplification)", async () => {
  const { c, editor, store, api } = setup({ Inbox: "---\nmodified: 1\n---\n- [ ] buy milk", B: "b" }); // an older identical task
  await c.show(P("Inbox"));
  await c.startCapture();
  c.setQuery("buy milk");
  editor.flushResult = false;
  await c.submitCapture("buy milk");
  expect(store.get().capture?.err).toMatch(/wasn't saved/);
  editor.text = editor.text.replace("modified: 1", "modified: 2"); // the saver's 1 s retry landed and restamped the block
  editor.flushResult = true;
  await c.submitCapture("buy milk");
  expect(editor.text).toBe("---\nmodified: 2\n---\n- [ ] buy milk\n- [ ] buy milk"); // the older task and this capture, once each
  expect(editor.appended).toEqual(["- [ ] buy milk"]);
  expect(store.get().capture).toBeNull();
  expect(api.captureDone).toHaveBeenLastCalledWith(true);
});

test("filter results are never replaced by an older load's reply (#15 simplification)", async () => {
  const { c, api, store } = setup({ A: "- [ ] a", B: "- [ ] b" });
  c.setPaneMode("tasks");
  await settle();
  const d1 = deferred<TaskView>();
  const d2 = deferred<TaskView>();
  api.tasks.mockImplementation(async (q) => (q === "a" ? d1.promise : q === "b" ? d2.promise : view(0)));
  c.setQuery("a");
  c.setQuery("b");
  d2.resolve({ ...view(0), no_date: [task("B", 0, "- [ ] b")] });
  await settle();
  d1.resolve({ ...view(0), no_date: [task("A", 0, "- [ ] a")] });
  await settle();
  expect(store.get().taskView!.no_date.map((t) => t.path)).toEqual([P("B")]);
});

const mention = (title: string, count = 1) => ({ node: { ...emptyConnections.centre, path: P(title), title }, name: title, count, context: "" });

test("link it on the open note goes through the editor", async () => {
  const { c, api, store, editor } = setup({ A: "see Bee here" });
  await c.show(P("A"));
  await c.toggleRelated();
  editor.replaceText("typed see Bee here"); // unsaved typing
  api.linkMention.mockImplementationOnce(async (_p, _t, _n, text) => text!.replace("Bee", "[[Bee]]"));
  api.connections.mockClear();
  await c.linkMention(mention("Bee"));
  expect(api.linkMention).toHaveBeenCalledWith(P("A"), "Bee", 1, "typed see Bee here", false);
  expect(editor.changes).toHaveLength(1);
  expect(editor.getText()).toBe("typed see [[Bee]] here"); // the typed text is kept
  expect(api.saveNote).not.toHaveBeenCalled();
  expect(store.get().conflict).toBeNull();
  expect(api.connections).toHaveBeenCalledTimes(1);
});

test("mention-moved refreshes silently, other errors show", async () => {
  const { c, api, store } = setup();
  await c.show(P("A"));
  await c.toggleRelated();
  api.linkMention.mockRejectedValueOnce("mention-moved");
  api.connections.mockClear();
  await c.linkMention(mention("B"));
  expect(api.connections).toHaveBeenCalledTimes(1);
  expect(store.get().related?.err).toBe("");
  api.linkMention.mockRejectedValueOnce("conflict");
  await c.linkMention(mention("B"));
  expect(store.get().related?.err).not.toBe("");
});

test("link it never runs on a locked note, nor when the panel shows another note", async () => {
  const { c, api, store } = setup();
  await c.show(P("A"));
  await c.toggleRelated();
  store.set((s) => ({ related: { ...s.related!, data: { ...emptyConnections, centre: { ...emptyConnections.centre, locked: true } } } }));
  await c.linkMention(mention("B"));
  expect(api.linkMention).not.toHaveBeenCalled();
  store.set((s) => ({ related: { ...s.related!, centre: P("Z") } }));
  await c.linkMention(mention("B"));
  expect(api.linkMention).not.toHaveBeenCalled();
});

test("no links chip filters the list", async () => {
  const { c, api, store } = setup();
  c.setNoLinks(true);
  await settle();
  expect(api.search).toHaveBeenLastCalledWith("", "modified", 0, [], true, false);
  c.setTags(["x"]);
  c.clearFilters();
  await settle();
  expect(store.get().noLinks).toBe(false);
  expect(store.get().selectedTags).toEqual([]);
  expect(api.search).toHaveBeenLastCalledWith("", "modified", 0, [], false, false);
});

test("link it flushes the editor before Related reloads", async () => {
  const { c, api, editor } = setup({ A: "see Bee here" });
  await c.show(P("A"));
  await c.toggleRelated();
  api.linkMention.mockImplementationOnce(async (_p, _t, _n, text) => text!.replace("Bee", "[[Bee]]"));
  const order: string[] = [];
  editor.flush.mockImplementationOnce(async () => (order.push("flush"), true));
  api.connections.mockImplementationOnce(async (p: string) => (order.push("connections"), { ...emptyConnections, centre: { ...emptyConnections.centre, path: p } }));
  await c.linkMention(mention("Bee"));
  expect(order).toEqual(["flush", "connections"]);
});

test("link it is an isolated undo step and skips a different note with the same text", async () => {
  const { c, api, editor } = setup({ A: "see Bee", B: "see Bee" });
  await c.show(P("A"));
  await c.toggleRelated();
  api.linkMention.mockImplementationOnce(async (_p, _t, _n, text) => {
    await c.show(P("B")); // switch notes during the call: identical text
    return text!.replace("Bee", "[[Bee]]");
  });
  await c.linkMention(mention("Bee"));
  expect(editor.changes).toEqual([]);
  await settle(); // the panel now follows B
  api.linkMention.mockImplementationOnce(async (_p, _t, _n, text) => text!.replace("Bee", "[[Bee]]"));
  await c.linkMention(mention("Bee"));
  expect(editor.isolated).toEqual([true]);
});

test("link targets load on refreshTitles, not on every editor focus", async () => {
  const { c, api } = setup();
  await c.start();
  await settle();
  expect(api.listLinkTargets).toHaveBeenCalledTimes(1);
  expect(c.editorOpts()).not.toHaveProperty("onFocus");
});

test("every path that changes titles refreshes link targets", async () => {
  const { c, api } = setup({ A: "a", B: "b" });
  await c.runSearch(true);
  await settle();
  const refreshed = async (what: () => Promise<unknown>) => {
    api.listLinkTargets.mockClear();
    await what();
    await settle();
    expect(api.listLinkTargets).toHaveBeenCalled();
  };
  await refreshed(() => c.createLinked("New"));
  await refreshed(() => c.onNotesChanged([]));
  await refreshed(async () => {
    await c.select(0);
    api.lockNote.mockResolvedValueOnce(P("A") + ".age");
    await c.toggleLock();
  });
  await refreshed(async () => {
    await c.select(1);
    c.startRename();
    api.renameNote.mockResolvedValueOnce({ path: P("Z"), rewritten: 0 });
    api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "b", hash: "h", encrypted: false, meta: noMeta, archived: false });
    await c.commitRename("Z");
  });
});

test("createLinked creates an empty note and keeps the open note", async () => {
  const { c, api, editor } = setup();
  await c.runSearch(true);
  await settle();
  const open = editor.currentPath();
  api.listLinkTargets.mockClear();
  await c.createLinked("Brand new idea");
  expect(api.createFromSelection).toHaveBeenCalledWith("Brand new idea", "");
  expect(editor.currentPath()).toBe(open);
  expect(api.listLinkTargets).toHaveBeenCalled();
});

test("createLinked shows invalid-title", async () => {
  const { c, api, store } = setup();
  api.createFromSelection.mockRejectedValueOnce("invalid-title");
  await c.createLinked("a/b");
  expect(store.get().err).toBe(INVALID_TITLE);
});

test("rename refreshes titles", async () => {
  const { c, api } = setup();
  await c.runSearch(true);
  await settle();
  api.listTitles.mockClear();
  api.listLinkTargets.mockClear();
  api.renameNote.mockResolvedValueOnce({ path: P("Z"), rewritten: 0 });
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  c.startRename();
  await c.commitRename("Z");
  await settle();
  expect(api.listTitles).toHaveBeenCalled();
  expect(api.listLinkTargets).toHaveBeenCalled();
});

test("refreshTags feeds the tag completion source", async () => {
  const { c, api } = setup({ A: "a" });
  api.listTags.mockResolvedValue([{ tag: "Project", count: 3 }]);
  await c.refreshTags();
  expect(c.editorOpts().complete.tags()).toHaveLength(1);
});

async function extractSetup(text = "Big idea\nbody", sel: [number, number] = [0, text.length]) {
  const s = setup({ A: text });
  await s.c.runSearch(true);
  await settle();
  s.editor.selection = { from: sel[0], to: sel[1] };
  return s;
}

test("extract creates the note then links the selection", async () => {
  const { c, api, editor, store, notes } = await extractSetup();
  let linkedAfterCreate = false;
  api.createFromSelection.mockImplementationOnce(async (t: string, x: string) => {
    linkedAfterCreate = editor.changes.length === 0;
    notes[t] = x;
    return P(t);
  });
  c.startExtract();
  expect(store.get().extract).toEqual({ title: "Big idea", err: "" });
  await c.commitExtract("Big idea");
  expect(api.createFromSelection).toHaveBeenCalledWith("Big idea", "Big idea\nbody");
  expect(linkedAfterCreate).toBe(true);
  expect(editor.changes).toEqual([{ from: 0, to: 13, insert: "[[Big idea]]" }]);
  expect(editor.isolated).toEqual([true]);
  expect(editor.currentPath()).toBe(P("A"));
  expect(store.get().extract).toBeNull();
});

test("extract refuses encrypted, empty selection, front matter, busy", async () => {
  const refused = async (arrange: (s: Awaited<ReturnType<typeof extractSetup>>) => void) => {
    const s = await extractSetup("---\nt: 1\n---\nbody", [14, 18]);
    arrange(s);
    s.c.startExtract();
    expect(s.store.get().extract).toBeNull();
    expect(s.store.get().err).not.toBe("");
    expect(s.api.createFromSelection).not.toHaveBeenCalled();
  };
  await refused((s) => s.store.set({ encrypted: true }));
  await refused((s) => (s.editor.selection = null));
  await refused((s) => (s.editor.selection = { from: 0, to: 12 })); // starts inside the front matter
  await refused((s) => (s.c.busy = true));
  await refused((s) => s.store.set({ indexing: { done: 0, total: 1 } }));
});

test("extract existing title keeps the dialog open", async () => {
  const { c, api, editor, store } = await extractSetup();
  api.createFromSelection.mockRejectedValueOnce("already-exists");
  c.startExtract();
  await c.commitExtract("Big idea");
  expect(store.get().extract?.err).toBe("A note with this title exists");
  expect(editor.changes).toEqual([]);
  api.createFromSelection.mockRejectedValueOnce("invalid-title");
  await c.commitExtract("a/b");
  expect(store.get().extract?.err).toBe(INVALID_TITLE);
  await c.commitExtract("  ");
  expect(store.get().extract?.err).toBe("Title required");
  await c.commitExtract(null);
  expect(store.get().extract).toBeNull();
});

test("extract failure leaves the source untouched", async () => {
  const { c, api, editor } = await extractSetup();
  api.createFromSelection.mockRejectedValueOnce("boom");
  c.startExtract();
  await c.commitExtract("Big idea");
  expect(editor.changes).toEqual([]);
  expect(editor.text).toBe("Big idea\nbody");
});

test("extract after the text moved never replaces the wrong range", async () => {
  const { c, editor, store, notes } = await extractSetup();
  c.startExtract();
  editor.text = "XX" + editor.text;
  await c.commitExtract("Big idea");
  expect(editor.changes).toEqual([]);
  expect(store.get().err).toContain("left in place");
  expect(notes["Big idea"]).toBe("Big idea\nbody");
  expect(store.get().extract).toBeNull();
});

async function mergeSetup(open = "S") {
  const s = setup({ S: "s", T: "t", U: "u" });
  s.api.listLinkTargets.mockResolvedValue([
    { name: "S", title: "S", path: P("S"), modified: 3, locked: false },
    { name: "T", title: "T", path: P("T"), modified: 1, locked: false },
    { name: "U", title: "U", path: P("U"), modified: 2, locked: false },
    { name: "Tee", title: "T", path: P("T"), modified: 1, locked: false }, // alias row
    { name: "L", title: "L", path: P("L"), modified: 9, locked: true },
  ]);
  await s.c.refreshTitles();
  await s.c.show(P(open));
  return s;
}
const T_ROW = { name: "T", title: "T", path: P("T"), modified: 1, locked: false };
const historyOf = (c: Controller) => (c as unknown as { history: { e: string[] } }).history.e;

test("merge candidates skip source, aliases and locked", async () => {
  const { c, store } = await mergeSetup();
  await c.startMerge();
  expect(store.get().merge).toEqual({ source: P("S"), sourceTitle: "S", query: "", target: null, err: "" });
  expect(c.mergeCandidates("").map((t) => t.name)).toEqual(["U", "T"]);
  expect(c.mergeCandidates("t").map((t) => t.name)).toEqual(["T"]);
});

test("merge of the open source ends on the target", async () => {
  const { c, api, editor, store } = await mergeSetup();
  api.backlinkCount.mockResolvedValueOnce(2);
  let detached = false;
  api.mergeNotes.mockImplementationOnce(async (_s: string, t: string) => {
    detached = editor.currentPath() === null;
    return { path: t, rewritten: 2, trash_error: null };
  });
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  expect(api.backlinkCount).toHaveBeenCalledWith("S");
  expect(store.get().merge?.target).toEqual({ path: P("T"), title: "T", count: 2 });
  await c.commitMerge();
  expect(editor.flush).toHaveBeenCalled();
  expect(detached).toBe(true);
  expect(api.mergeNotes).toHaveBeenCalledWith(P("S"), P("T"));
  expect(editor.currentPath()).toBe(P("T"));
  expect(historyOf(c)).not.toContain(P("S"));
  expect(store.get().merge).toBeNull();
  expect(c.busy).toBe(false);
});

test("merge: a note opened during the flush keeps its unsaved edits", async () => {
  const { c, api, editor, store } = await mergeSetup();
  setPos(P("S"), { h: 1, t: 0, m: 0 });
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  const flush = deferred<boolean>();
  editor.flush.mockImplementationOnce(() => flush.promise);
  api.mergeNotes.mockResolvedValueOnce({ path: P("T"), rewritten: 1, trash_error: null });
  const merge = c.commitMerge();
  await vi.waitFor(() => expect(editor.flush).toHaveBeenCalled());
  const doc = { path: P("U"), title: "U", text: "u", hash: "h", encrypted: false, meta: noMeta, archived: false };
  editor.load(doc);
  (c as any).loadedDoc(doc); // what an in-flight show does when it lands
  editor.replaceText("typed in U");
  flush.resolve(true);
  await merge;
  expect(api.mergeNotes).toHaveBeenCalled();
  expect(editor.currentPath()).toBe(P("U"));
  expect(editor.text).toBe("typed in U");
  expect(getPos(P("S"))).toBeUndefined();
  expect(store.get()).toMatchObject({ openPath: P("U"), title: "U" });
});

test("merge: a failing backend call while another note is open leaves that note alone", async () => {
  const { c, api, editor, store } = await mergeSetup();
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  const flush = deferred<boolean>();
  editor.flush.mockImplementationOnce(() => flush.promise);
  api.mergeNotes.mockRejectedValueOnce("conflict");
  const merge = c.commitMerge();
  await vi.waitFor(() => expect(editor.flush).toHaveBeenCalled());
  const doc = { path: P("U"), title: "U", text: "u", hash: "h", encrypted: false, meta: noMeta, archived: false };
  editor.load(doc);
  (c as any).loadedDoc(doc); // what an in-flight show does when it lands
  flush.resolve(true); // U stays clean, see the delete twin
  await merge;
  expect(editor.currentPath()).toBe(P("U"));
  expect(store.get()).toMatchObject({ openPath: P("U"), title: "U" });
  expect(c.busy).toBe(false);
  expect(store.get().merge).toMatchObject({ err: "conflict", pending: false });
});

test("merge keeps both stored positions on failure; success drops only the source's", async () => {
  const { c, api } = await mergeSetup();
  setPos(P("S"), { h: 1, t: 0, m: 0 });
  setPos(P("T"), { h: 2, t: 0, m: 0 });
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  api.mergeNotes.mockRejectedValueOnce("conflict");
  await c.commitMerge();
  expect(getPos(P("S"))).toBeDefined();
  expect(getPos(P("T"))).toBeDefined();
  api.mergeNotes.mockResolvedValueOnce({ path: P("T"), rewritten: 1, trash_error: null });
  await c.commitMerge();
  expect(getPos(P("S"))).toBeUndefined();
  expect(getPos(P("T"))).toBeDefined();
});

test("merge with the target open reloads it", async () => {
  const { c, api, editor, store } = await mergeSetup("T"); // S picked from the list's menu earlier; T is open now
  store.set({ merge: { source: P("S"), sourceTitle: "S", query: "", target: { path: P("T"), title: "T", count: 1 }, err: "" } });
  api.mergeNotes.mockResolvedValueOnce({ path: P("T"), rewritten: 1, trash_error: null });
  api.openNote.mockClear();
  await c.commitMerge();
  expect(editor.flush).toHaveBeenCalled();
  expect(api.mergeNotes).toHaveBeenCalledWith(P("S"), P("T"));
  expect(api.openNote).toHaveBeenCalledWith(P("T"));
  expect(editor.currentPath()).toBe(P("T"));
});

test("merge refused when the flush fails", async () => {
  const { c, api, editor, store } = await mergeSetup();
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  editor.flushResult = false;
  await c.commitMerge();
  expect(api.mergeNotes).not.toHaveBeenCalled();
  expect(store.get().merge?.err).not.toBe("");
  expect(editor.currentPath()).toBe(P("S"));
  expect(c.busy).toBe(false);
});

test("merge failure puts the note back", async () => {
  const { c, api, editor, store } = await mergeSetup();
  api.mergeNotes.mockRejectedValueOnce("conflict");
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  await c.commitMerge();
  expect(editor.currentPath()).toBe(P("S"));
  expect(store.get().merge?.err).toBe("conflict");
  expect(c.busy).toBe(false);
  api.mergeNotes.mockRejectedValueOnce("locked");
  await c.commitMerge();
  expect(store.get().merge?.err).toBe("Can't merge a locked note");
  api.mergeNotes.mockRejectedValueOnce("same-note");
  await c.commitMerge();
  expect(store.get().merge?.err).toBe("Pick another note");
});

test("cancel and back are ignored while a merge is in flight", async () => {
  const { c, api, store } = await mergeSetup();
  let reject!: (e: unknown) => void;
  api.mergeNotes.mockImplementationOnce(() => new Promise((_r, rj) => (reject = rj)));
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  const done = c.commitMerge();
  await vi.waitFor(() => expect(api.mergeNotes).toHaveBeenCalled());
  expect(store.get().merge?.pending).toBe(true);
  c.cancelMerge();
  c.backMerge();
  expect(store.get().merge?.target?.path).toBe(P("T"));
  reject("conflict");
  await done;
  expect(store.get().merge?.err).toBe("conflict");
  expect(store.get().merge?.pending).toBe(false);
});

test("merge trash failure shows what was not done", async () => {
  const { c, api, editor, store } = await mergeSetup();
  api.mergeNotes.mockResolvedValueOnce({ path: P("T"), rewritten: 0, trash_error: "denied" });
  await c.startMerge();
  await c.chooseMergeTarget(T_ROW);
  await c.commitMerge();
  expect(store.get().err).toContain("couldn't be moved to the Trash");
  expect(store.get().err).toContain("denied");
  expect(editor.currentPath()).toBe(P("T"));
  expect(store.get().merge).toBeNull();
});

test("merge refuses encrypted", async () => {
  const { c, store, editor } = await mergeSetup();
  store.set({ encrypted: true });
  await c.startMerge();
  expect(store.get().merge).toBeNull();
  expect(store.get().err).toBe("Can't merge a locked note");
  c.busy = true;
  store.set({ encrypted: false });
  await c.startMerge();
  expect(store.get().merge).toBeNull();
  c.busy = false;
  editor.discard(); // no open note
  await c.startMerge();
  expect(store.get().merge).toBeNull();
  expect(store.get().err).toBe("Open a note to merge");
});

async function savedSetup() {
  const t = setup();
  let saved = await t.api.getSettings();
  t.api.getSettings.mockImplementation(async () => ({ ...saved }));
  t.api.setSettings.mockImplementation(async (s) => void (saved = s));
  return { ...t, saved: () => saved.saved_searches };
}

test("save search does nothing without filters", () => {
  const { c, store } = setup();
  c.startSaveSearch();
  expect(store.get().saveSearch).toBeNull();
});

test("a saved search applies query, tags and No links", async () => {
  const { c, api, store, saved } = await savedSetup();
  c.setQuery("velo");
  c.setTags(["proj"]);
  c.setNoLinks(true);
  c.startSaveSearch();
  expect(store.get().saveSearch).toEqual({ name: "velo", err: "", confirmReplace: false });
  await c.commitSaveSearch("w");
  expect(store.get().saveSearch).toBeNull();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ saved_searches: [{ name: "w", query: "velo", tags: ["proj"], no_links: true }] }));
  expect(saved()).toHaveLength(1);
  c.clearFilters();
  c.setQuery("");
  c.applySaved("w");
  await settle();
  expect(store.get()).toMatchObject({ query: "velo", selectedTags: ["proj"], noLinks: true });
  expect(api.search).toHaveBeenLastCalledWith("velo", "modified", 0, ["proj"], true, false);
});

test("saving over an existing name asks first", async () => {
  const { c, api, store, saved } = await savedSetup();
  c.setQuery("a");
  c.startSaveSearch();
  await c.commitSaveSearch("Velo");
  c.setQuery("b");
  c.startSaveSearch();
  api.setSettings.mockClear();
  await c.commitSaveSearch("velo");
  expect(store.get().saveSearch).toMatchObject({ name: "velo", confirmReplace: true });
  expect(api.setSettings).not.toHaveBeenCalled();
  await c.commitSaveSearch("velo");
  expect(store.get().saveSearch).toBeNull();
  expect(saved()).toEqual([{ name: "velo", query: "b", tags: [], no_links: false }]);
});

test("a blank or long name is refused", async () => {
  const { c, api, store } = setup();
  c.setQuery("a");
  c.startSaveSearch();
  await c.commitSaveSearch("   ");
  expect(store.get().saveSearch?.err).toBe("Name required");
  await c.commitSaveSearch("x".repeat(61));
  expect(store.get().saveSearch?.err).toBe("Name too long (60 characters at most)");
  expect(api.setSettings).not.toHaveBeenCalled();
});

test("applying the current saved search clears the filters", async () => {
  const { c, store } = await savedSetup();
  c.setQuery("velo");
  c.setTags(["proj"]);
  c.startSaveSearch();
  await c.commitSaveSearch("w");
  c.applySaved("w");
  expect(store.get()).toMatchObject({ query: "", selectedTags: [], noLinks: false });
});

test("saved search menu renames and deletes", async () => {
  const { c, store, menus, answers, calls, saved } = await savedSetup();
  c.setQuery("a");
  c.startSaveSearch();
  await c.commitSaveSearch("w");
  await c.savedMenu("w", true);
  expect(calls.some((x) => x[0] === "focusAnchor")).toBe(true); // keyboard: anchored at the chip
  const items = menus[menus.length - 1].items as { text: string; action: () => void }[];
  expect(items.map((m) => m.text)).toEqual(["Rename…", "Delete"]);
  items[0].action();
  expect(store.get().saveSearch).toEqual({ name: "w", err: "", confirmReplace: false, renaming: "w" });
  await c.commitSaveSearch("x");
  expect(saved()).toEqual([{ name: "x", query: "a", tags: [], no_links: false }]);
  answers.confirm = false;
  await c.deleteSaved("x");
  expect(saved()).toHaveLength(1);
  answers.confirm = true;
  await c.deleteSaved("x");
  expect(calls.some((x) => x[0] === "confirm")).toBe(true);
  expect(saved()).toEqual([]);
  expect(store.get().savedSearches).toEqual([]);
});

const trow = (title: string): TimelineRow => ({ path: P(title), title, date: 0, snippet: "", locked: false, archived: false });

test("the timeline loads with the filters, the saved sort and no range", async () => {
  const { c, api, store } = setup();
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), timeline_sort: "created" });
  await c.start();
  c.setQuery("a");
  c.setTags(["t"]);
  c.setNoLinks(true);
  api.timeline.mockResolvedValue([trow("A")]);
  c.setPaneMode("timeline");
  await settle();
  expect(api.timeline).toHaveBeenLastCalledWith("a", ["t"], true, "created", null, false);
  expect(store.get()).toMatchObject({ paneMode: "timeline", timeline: { rows: [trow("A")], by: "created", range: "all", err: "" } });
  c.setTimelineRange("7");
  await settle();
  expect(api.timeline.mock.lastCall?.[4]).toBeTypeOf("number");
});

test("a filter change in timeline mode reloads the timeline, not the list", async () => {
  const { c, api, store, editor } = setup();
  c.setPaneMode("timeline");
  await settle();
  api.search.mockClear();
  c.setQuery("b");
  await settle();
  expect(api.timeline).toHaveBeenLastCalledWith("b", [], false, "updated", null, false);
  expect(api.search).not.toHaveBeenCalled();
  api.timeline.mockResolvedValue([trow("B")]);
  c.setQuery("bb");
  const focused = editor.focused;
  await c.enter(); // the stale list is never used: the first timeline row opens
  expect(store.get().openPath).toBe(P("B"));
  expect(editor.focused).toBe(focused + 1); // like Tasks: focus moves to the opened note
});

test("an older timeline reply landing last is dropped", async () => {
  const { c, api, store } = setup();
  const d1 = deferred<TimelineRow[]>();
  const d2 = deferred<TimelineRow[]>();
  api.timeline.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise);
  c.setPaneMode("timeline");
  c.setQuery("b");
  d2.resolve([trow("B")]);
  await settle();
  d1.resolve([trow("A")]);
  await settle();
  expect(store.get().timeline.rows).toEqual([trow("B")]);
});

test("the timeline sort is saved and reloads", async () => {
  const { c, api, store } = await savedSetup();
  c.setPaneMode("timeline");
  await c.setTimelineBy("created");
  await settle();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ timeline_sort: "created" }));
  expect(store.get().timeline.by).toBe("created");
  expect(api.timeline).toHaveBeenLastCalledWith("", [], false, "created", null, false);
});

test("a note saved, renamed or deleted reloads the timeline", async () => {
  const { c, api } = setup();
  await c.runSearch(true);
  await settle();
  c.setPaneMode("timeline");
  await settle();
  api.timeline.mockClear();
  c.editorOpts().onSaved();
  await new Promise((r) => setTimeout(r, 350));
  expect(api.timeline).toHaveBeenCalledTimes(1);
  api.renameNote.mockResolvedValueOnce({ path: P("Z"), rewritten: 0 });
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta, archived: false });
  c.startRename();
  await c.commitRename("Z");
  expect(api.timeline).toHaveBeenCalledTimes(2);
  await c.deleteNote();
  expect(api.timeline).toHaveBeenCalledTimes(3);
});

const counts = (notes: number) => ({ notes, open: 0, done: 0, locked: 0, over_limit: 0, no_tasks: 0, unreadable: 0 });

test("export from the notes pane switches to the timeline and previews its date and range", async () => {
  const { c, api, store } = setup();
  api.exportPreview.mockResolvedValue(counts(3));
  c.setQuery("a");
  await c.setTimelineRange("7");
  store.set({ paneMode: "notes" });
  await c.startExport();
  expect(store.get().paneMode).toBe("timeline");
  expect(api.exportPreview).toHaveBeenCalledTimes(1);
  expect(api.exportPreview.mock.lastCall?.[0]).toMatchObject({ query: "a", tags: [], no_links: false, by: "updated", tasks_only: false, title: "a" });
  expect(api.exportPreview.mock.lastCall?.[0].since_ms).toBeTypeOf("number");
  expect(store.get().exporting).toEqual({ counts: counts(3), format: "md", tasksOnly: false, err: "", pending: false });
});

test("Markdown export asks where to save, then writes there; a cancelled save writes nothing", async () => {
  const { c, api, ui, store } = setup();
  api.exportPreview.mockResolvedValue(counts(2));
  store.set({ selectedTags: ["proj"] });
  c.setQuery("velo");
  await c.startExport();
  const save = vi.spyOn(ui, "saveFile").mockResolvedValueOnce(null);
  await c.commitExport(true);
  expect(save).toHaveBeenCalledWith(`#proj velo ${localToday()}.md`);
  expect(api.exportMarkdown).not.toHaveBeenCalled();
  expect(store.get().exporting).toMatchObject({ pending: false });
  save.mockResolvedValueOnce("/out/x.md");
  await c.commitExport(true);
  expect(api.exportMarkdown).toHaveBeenCalledWith("/out/x.md", expect.objectContaining({ query: "velo", tags: ["proj"], tasks_only: false, title: "#proj velo" }));
  expect(store.get().exporting).toBeNull();
});

test("nothing to export: Export does nothing", async () => {
  const { c, api, calls, store } = setup();
  api.exportPreview.mockResolvedValue({ ...counts(0), locked: 2 });
  await c.startExport();
  await c.commitExport(true);
  expect(calls.some(([n]) => n === "saveFile")).toBe(false);
  expect(api.exportMarkdown).not.toHaveBeenCalled();
  expect(store.get().exporting).not.toBeNull();
});

test("the export title is the saved search's name when the filters equal it, else All notes", async () => {
  const { c, api, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  await c.startExport();
  expect(api.exportPreview.mock.lastCall?.[0].title).toBe("All notes");
  store.set({ savedSearches: [{ name: "Weekly", query: "velo", tags: ["proj"], no_links: false }], selectedTags: ["proj"], exporting: null });
  c.setQuery("velo ");
  await c.startExport();
  expect(api.exportPreview.mock.lastCall?.[0].title).toBe("Weekly");
});

test("toggling Tasks only fetches the preview again", async () => {
  const { c, api, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  await c.startExport();
  await c.setExportOptions({ format: "pdf" });
  expect(api.exportPreview).toHaveBeenCalledTimes(1);
  await c.setExportOptions({ tasksOnly: true });
  expect(api.exportPreview).toHaveBeenCalledTimes(2);
  expect(api.exportPreview.mock.lastCall?.[0].tasks_only).toBe(true);
  expect(store.get().exporting).toMatchObject({ tasksOnly: true, format: "pdf", counts: counts(1) });
});

test("the export action opens the export dialog", async () => {
  const { c, api, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  store.set({ keys: { ...store.get().keys, export: "Mod+KeyE" } });
  expect(c.onKeyDown(key("KeyE", { meta: true }))).toBe(true);
  await settle();
  expect(store.get().exporting?.counts).toEqual(counts(1));
});

test("PDF export renders the export into the print container, prints once, closes, and keeps the container until the next export", async () => {
  const { c, api, ui, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  api.exportText.mockResolvedValueOnce("# Hi\n\nSee [[B]] #proj");
  await c.startExport();
  await c.setExportOptions({ format: "pdf" });
  let atFrame: string | null = null;
  let atPrint: string | null = null;
  vi.spyOn(ui, "nextFrame").mockImplementationOnce(async () => void (atFrame = store.get().printHtml));
  api.printPage.mockImplementationOnce(async () => void (atPrint = store.get().printHtml));
  await c.commitExport(true);
  expect(api.exportText).toHaveBeenCalledWith(expect.objectContaining({ tasks_only: false, title: "All notes" }));
  expect(atFrame).toBe(atPrint);
  expect(atPrint).toContain("<h1>Hi</h1>");
  expect(atPrint).toContain('<span class="wikilink" data-title="B">B</span>');
  expect(atPrint).toContain('<span class="tag" data-tag="proj">#proj</span>');
  expect(atPrint).not.toContain('href="#"');
  expect(api.printPage).toHaveBeenCalledTimes(1);
  expect(api.exportMarkdown).not.toHaveBeenCalled();
  // macOS print() returns while the sheet is still laying out: the container must outlive it
  expect(store.get().printHtml).toBe(atPrint);
  expect(store.get().exporting).toBeNull();
  await c.startExport();
  expect(store.get().printHtml).toBeNull();
});

test("PDF export cancelled while the text loads prints nothing", async () => {
  const { c, api, calls, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  const d = deferred<string>();
  api.exportText.mockImplementationOnce(() => d.promise);
  await c.startExport();
  await c.setExportOptions({ format: "pdf" });
  const go = c.commitExport(true);
  await c.commitExport(false);
  d.resolve("# Hi");
  await go;
  expect(store.get().printHtml).toBeNull();
  expect(calls.some(([n]) => n === "nextFrame")).toBe(false);
  expect(api.printPage).not.toHaveBeenCalled();
});

test("PDF export: a print failure keeps the dialog open with the error and clears the print container", async () => {
  const { c, api, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  api.exportText.mockResolvedValueOnce("x");
  api.printPage.mockRejectedValueOnce("no printer");
  await c.startExport();
  await c.setExportOptions({ format: "pdf" });
  await c.commitExport(true);
  expect(store.get().printHtml).toBeNull();
  expect(store.get().exporting).toMatchObject({ err: "no printer", pending: false, format: "pdf" });
});

for (const layout of ["vertical", "horizontal"] as const) {
  test(`Enter in timeline mode with preview on (${layout} layout) opens the note in the editor with focus, like Tasks`, async () => {
    const { c, api, store, editor } = setup();
    const preview = new FakePreview();
    c.attachPreview(preview);
    preview.on = true;
    store.set({ layout });
    api.timeline.mockResolvedValue([trow("B")]);
    c.setPaneMode("timeline");
    const focused = editor.focused;
    await c.enter();
    expect(store.get().openPath).toBe(P("B"));
    expect(preview.on).toBe(false); // the editor is display:none under preview in both layouts
    expect(editor.focused).toBe(focused + 1);
  });
}

test("Enter in notes mode with preview on in the horizontal layout leaves preview too", async () => {
  const { c, store, editor } = setup({ ab: "x" });
  const preview = new FakePreview();
  c.attachPreview(preview);
  preview.on = true;
  store.set({ layout: "horizontal" });
  c.setQuery("ab");
  const focused = editor.focused;
  await c.enter();
  expect(store.get().openPath).toBe(P("ab"));
  expect(preview.on).toBe(false);
  expect(editor.focused).toBe(focused + 1);
});

test("PDF export cancelled, reopened and exported again prints only the second export", async () => {
  const { c, api, store } = setup();
  api.exportPreview.mockResolvedValue(counts(1));
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  api.exportText.mockImplementationOnce(() => d1.promise).mockImplementationOnce(() => d2.promise);
  await c.startExport();
  await c.setExportOptions({ format: "pdf" });
  const first = c.commitExport(true);
  await c.commitExport(false);
  await c.startExport();
  await c.setExportOptions({ format: "pdf" });
  const second = c.commitExport(true);
  d1.resolve("# One");
  await first;
  expect(api.printPage).not.toHaveBeenCalled();
  d2.resolve("# Two");
  await second;
  expect(api.printPage).toHaveBeenCalledTimes(1);
  expect(store.get().printHtml).toContain("Two");
});

test("export does nothing while capturing: the field holds capture text, not a filter", async () => {
  const { c, api, store } = setup({ Inbox: "", B: "b" });
  await c.startCapture();
  c.setQuery("buy milk");
  await c.startExport();
  expect(store.get().exporting).toBeNull();
  expect(api.exportPreview).not.toHaveBeenCalled();
});

test("re-entering the timeline shows loading, not the previous filters' rows", async () => {
  const { c, api, store } = setup();
  api.timeline.mockResolvedValue([trow("A")]);
  c.setPaneMode("timeline");
  await settle();
  c.setPaneMode("notes");
  c.setQuery("b");
  await settle();
  const d = deferred<TimelineRow[]>();
  api.timeline.mockImplementationOnce(() => d.promise);
  c.setPaneMode("timeline");
  expect(store.get().timeline.rows).toBeNull();
  d.resolve([trow("B")]);
  await settle();
  expect(store.get().timeline.rows).toEqual([trow("B")]);
});

test("the timeline shows no error while the vault indexes", async () => {
  const { c, api, store } = setup();
  api.timeline.mockRejectedValueOnce("indexing");
  c.setPaneMode("timeline");
  await settle();
  expect(store.get().timeline).toMatchObject({ rows: null, err: "" });
});

test("↑/↓ from the search field move the timeline selection; Enter opens it", async () => {
  const { c, api, store } = setup();
  api.timeline.mockResolvedValue([trow("A"), trow("B"), trow("C")]);
  c.setPaneMode("timeline");
  await settle();
  const down = { ...key("ArrowDown"), key: "ArrowDown", inSearch: true };
  const up = { ...key("ArrowUp"), key: "ArrowUp", inSearch: true };
  expect(store.get().timeline.sel).toBeNull(); // none: Enter and the arrows start from the first row
  expect(c.onKeyDown(down)).toBe(true);
  expect(store.get().timeline.sel).toBe(P("B"));
  c.onKeyDown(down);
  c.onKeyDown(down); // stops at the last row
  expect(store.get().timeline.sel).toBe(P("C"));
  c.onKeyDown(up);
  expect(store.get().timeline.sel).toBe(P("B"));
  expect(store.get().openPath).toBeNull(); // moving never opens: a locked row would ask for the passphrase
  await c.enter();
  expect(store.get().openPath).toBe(P("B"));
  // arrows outside the search field (segment groups, rows) keep their own meaning
  expect(c.onKeyDown({ ...key("ArrowDown"), key: "ArrowDown" })).toBe(false);
  expect(c.onKeyDown({ ...down, inEditor: true, inSearch: false })).toBe(false);
});

test("Enter in timeline mode falls back to the first row when the selection is gone", async () => {
  const { c, api, store } = setup();
  api.timeline.mockResolvedValue([trow("A"), trow("B")]);
  c.setPaneMode("timeline");
  await settle();
  c.setTimelineSel(P("B"));
  api.timeline.mockResolvedValue([trow("C"), trow("A")]);
  c.setQuery("x");
  await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("C"));
});

test("re-entering the timeline clears its selection", async () => {
  const { c, api, store } = setup();
  api.timeline.mockResolvedValue([trow("A"), trow("B")]);
  c.setPaneMode("timeline");
  await settle();
  c.setTimelineSel(P("B"));
  c.setPaneMode("notes");
  c.setPaneMode("timeline");
  expect(store.get().timeline.sel).toBeNull();
});

test("a filter, date or range change in timeline mode clears the selection: Enter opens the new first row", async () => {
  const { c, api, store } = setup();
  api.timeline.mockResolvedValue([trow("A"), trow("B"), trow("C")]);
  c.setPaneMode("timeline");
  await settle();
  c.setTimelineSel(P("C"));
  api.timeline.mockResolvedValue([trow("A"), trow("C")]); // C still matches, A is first
  c.setQuery("foo");
  await settle();
  expect(store.get().timeline.sel).toBeNull();
  await c.enter();
  expect(store.get().openPath).toBe(P("A"));
  for (const change of [() => c.setTags(["t"]), () => c.setNoLinks(true), () => c.setTimelineRange("7"), () => c.setTimelineBy("created")]) {
    c.setTimelineSel(P("C"));
    void change();
    expect(store.get().timeline.sel).toBeNull();
  }
  await settle();
});

test("listings pass show_archived from the settings", async () => {
  const { c, api } = setup();
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  expect(api.search.mock.calls[api.search.mock.calls.length - 1]?.[5]).toBe(true);
  expect(api.tasks.mock.calls.length).toBeGreaterThan(0);
  expect(api.tasks.mock.calls.every((a) => a[3] === true)).toBe(true);
  expect(api.listTags).toHaveBeenLastCalledWith(true);
  expect(api.listLinkTargets).toHaveBeenLastCalledWith(true);
});

test("merge picker follows the switch; an archived title still exists for Create", async () => {
  const { c, api, store } = setup({ A: "a", B: "b" });
  await c.start(); await settle();
  await api.setArchived("/n/B.md", true); await c.refreshTitles(); await settle();
  expect(c.mergeCandidates("").map((t) => t.title)).not.toContain("B");
  expect(c.editorOpts().complete.exists!("b")).toBe(true);
  c.setQuery("B"); await settle();
  expect(store.get().exactTitleMatch).toBe(true); // no ⇧↩ Create for a hidden archived title
  store.set({ showArchived: true }); await c.loadLinkTargets();
  expect(c.mergeCandidates("").map((t) => t.title)).toContain("B");
});

test("a list-write failure is shown, even when it lands before the rename resolves", async () => {
  const { c, api, store, notes } = setup();
  await c.start(); await settle();
  notes.Z = "a"; // what the fake opens after the rename
  const d = deferred<RenameResult>(); api.renameNote.mockImplementationOnce(() => d.promise);
  c.startRename(); const done = c.commitRename("Z");
  c.onArchiveError("permission denied");
  d.resolve({ path: "/n/Z.md", rewritten: 0 }); await done; await settle();
  expect(store.get().err).toBe("The archived-notes list could not be updated: permission denied");
});

test("a stale link-target response is dropped", async () => {
  const { c, api } = setup({ A: "a", B: "b" });
  const first = deferred<LinkTarget[]>(), second = deferred<LinkTarget[]>();
  api.listLinkTargets.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const p1 = c.loadLinkTargets(), p2 = c.loadLinkTargets();
  second.resolve([{ name: "B", title: "B", path: "/n/B.md", modified: 0, locked: false }]); await p2;
  first.resolve([{ name: "A", title: "A", path: "/n/A.md", modified: 0, locked: false }]); await p1;
  expect(c.mergeCandidates("").map((t) => t.title)).toEqual(["B"]);
});

test("link mention and the Related panel read the same switch", async () => {
  const { c, api, store, editor } = setup({ A: "see Bee here" });
  store.set({ showArchived: true });
  await c.show(P("A"));
  await c.toggleRelated();
  editor.replaceText("see Bee here");
  api.linkMention.mockImplementationOnce(async (_p, _t, _n, text) => text!.replace("Bee", "[[Bee]]"));
  await c.linkMention(mention("Bee"));
  expect(api.connections).toHaveBeenLastCalledWith(P("A"), true);
  expect(api.linkMention).toHaveBeenCalledWith(P("A"), "Bee", 1, "see Bee here", true);
});

test("exactTitleMatch follows the title cache: a renamed-away title offers Create again", async () => {
  const { c, api, store, notes } = setup({ A: "a", B: "b" });
  await c.start(); await settle();
  c.setQuery("A"); await settle();
  expect(store.get().exactTitleMatch).toBe(true);
  delete notes.A; notes.Z = "a";
  await c.runSearch(false); await c.refreshTitles(); await settle();
  expect(api.listTitles).toHaveBeenCalled();
  expect(store.get().exactTitleMatch).toBe(false);
});

test("exactTitleMatch: a hidden note renamed to the query counts once the title cache loads", async () => {
  const { c, api, store, notes } = setup({ A: "a", B: "b" });
  await c.start(); await settle();
  c.setQuery("Q"); await settle();
  expect(store.get().exactTitleMatch).toBe(false);
  await api.setArchived("/n/B.md", true);
  delete notes.B; notes.Q = "b"; await api.setArchived("/n/Q.md", true); // renamed to Q, still archived: not in the list
  await c.runSearch(false); await c.refreshTitles(); await settle();
  expect(store.get().exactTitleMatch).toBe(true);
});

test("archiving the open note with the switch off keeps it open and clears the selection", async () => {
  const { c, api, store, editor } = setup();
  await c.start(); await settle();
  const path = store.get().openPath!;
  await c.toggleArchive();
  expect(api.setArchived).toHaveBeenCalledWith(path, true);
  expect(store.get()).toMatchObject({ openPath: path, archived: true, sel: -1 });
  expect(editor.currentPath()).toBe(path);
  expect(c.row(0)?.path).not.toBe(path);
  await c.toggleArchive(); // unarchive: one step away
  expect(api.setArchived).toHaveBeenLastCalledWith(path, false);
  expect(store.get().archived).toBe(false);
});

test("no open note: archive says why", async () => {
  const { c, store, api } = setup({});
  await c.start(); await settle();
  await c.toggleArchive();
  expect(store.get().err).toBe("Open a note to archive");
  expect(api.setArchived).not.toHaveBeenCalled();
});

test("a failed archive shows the error and leaves the flag", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  api.setArchived.mockRejectedValueOnce("permission denied");
  await c.toggleArchive();
  expect(store.get()).toMatchObject({ err: "permission denied", archived: false });
});

test("the archive result applies to the note it was for, not the one open afterwards", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  const a = store.get().openPath!;
  const d = deferred<undefined>(); api.setArchived.mockImplementationOnce(() => d.promise);
  const done = c.toggleArchive();
  await c.select(1); await settle();
  const b = store.get().openPath!;
  store.set({ infoOpen: true, sideTab: "related" });
  const related = api.connections.mock.calls.length;
  d.resolve(undefined); await done; await settle();
  expect(api.setArchived).toHaveBeenCalledWith(a, true);
  expect(store.get()).toMatchObject({ openPath: b, archived: false });
  expect(api.connections.mock.calls.length).toBeGreaterThan(related); // b's Related reloads without a
});

for (const act of ["toggleArchive", "setShowArchived"] as const)
  test(`${act} never opens row 0 while a fresh first page is pending`, async () => {
    const { c, api, store, editor } = setup();
    await c.start(); await settle();
    await c.select(1); await settle(); // the open note is not row 0
    const open = store.get().openPath!;
    const d = deferred<Page>(); const real = api.search.getMockImplementation()!;
    api.search.mockImplementationOnce(() => d.promise);
    c.setQuery("x"); // fresh first page in flight (pendingFirst = false: would open row 0)
    await (act === "toggleArchive" ? c.toggleArchive() : c.setShowArchived(true));
    d.resolve(await real("x", "modified", 0, [], false, false)); await settle();
    expect(editor.currentPath()).toBe(open);
  });

test("the hidden-matches line turns the switch on and persists it", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  await c.toggleArchive(); c.setQuery("a"); await settle();
  expect(store.get().hiddenArchived).toBe(1);
  await c.setShowArchived(true); await settle();
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ show_archived: true }));
  expect(store.get().showArchived).toBe(true);
  expect(api.search.mock.lastCall?.[5]).toBe(true);
});

test("switching show archived off keeps an open archived note open", async () => {
  const { c, api, store, editor } = setup();
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  const path = store.get().openPath!;
  await c.toggleArchive(); await settle(); // archived, still listed (switch on)
  const opens = api.openNote.mock.calls.length;
  await c.setShowArchived(false); await settle();
  expect(editor.currentPath()).toBe(path);
  expect(store.get()).toMatchObject({ openPath: path, archived: true, sel: -1 });
  expect(api.openNote.mock.calls.length).toBe(opens); // row 0 was not opened in its place
});

test("two fast toggles of the switch end where they started", async () => {
  const { c, api, store } = setup();
  let cur = { ...(await api.getSettings()) };
  api.getSettings.mockImplementation(async () => ({ ...cur }));
  const gate = deferred<void>(); let first = true;
  api.setSettings.mockImplementation(async (s) => { if (first) { first = false; await gate.promise; } cur = s; });
  await c.start(); await settle();
  const a = c.toggleShowArchived(), b = c.toggleShowArchived();
  gate.resolve(); await Promise.all([a, b]); await settle();
  expect(cur.show_archived).toBe(false);
  expect(store.get().showArchived).toBe(false);
});

test("changing the switch reloads every listing", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  store.set({ paneMode: "timeline", infoOpen: true, sideTab: "related" });
  const n = { tags: api.listTags.mock.calls.length, tasks: api.tasks.mock.calls.length, targets: api.listLinkTargets.mock.calls.length, tl: api.timeline.mock.calls.length, rel: api.connections.mock.calls.length };
  await c.setShowArchived(true); await settle();
  expect(api.listTags.mock.calls.length).toBeGreaterThan(n.tags);
  expect(api.listTags.mock.lastCall).toEqual([true]);
  expect(api.tasks.mock.calls.length).toBeGreaterThan(n.tasks);
  expect(api.tasks.mock.lastCall?.[3]).toBe(true);
  expect(api.listLinkTargets.mock.lastCall).toEqual([true]);
  expect(api.timeline.mock.calls.length).toBeGreaterThan(n.tl);
  expect(api.connections.mock.calls.length).toBeGreaterThan(n.rel);
  const searches = api.search.mock.calls.length;
  c.setPaneMode("notes"); await settle(); // the hidden Notes list was marked stale
  expect(api.search.mock.calls.length).toBeGreaterThan(searches);
  expect(api.search.mock.lastCall?.[5]).toBe(true);
});

test("a list-write failure that lands after the operation is shown once", async () => {
  const { c, store } = setup();
  await c.start(); await settle();
  c.onArchiveError("permission denied");
  expect(store.get().err).toBe("The archived-notes list could not be updated: permission denied");
  await c.select(1); await settle(); // clears the error
  expect(store.get().err).toBe("");
});

test("the archive action flips the store flag the palette label reads", async () => {
  const { c, store } = setup();
  await c.start(); await settle();
  await c.toggleArchive();
  expect(store.get().archived).toBe(true);
  c.runAction("archive_note"); await settle();
  expect(store.get().archived).toBe(false);
});

test("the check_updates action calls the update check once", async () => {
  const { c, api } = setup();
  await c.start(); await settle();
  const n = api.checkUpdate.mock.calls.length;
  c.runAction("check_updates"); await settle();
  expect(api.checkUpdate.mock.calls.length - n).toBe(1);
});

test("the quit action calls quitApp once", async () => {
  const { c, api } = setup();
  await c.start(); await settle();
  c.runAction("quit"); await settle();
  expect(api.quitApp).toHaveBeenCalledTimes(1);
});

test("the reset_window action calls resetWindow once", async () => {
  const { c, api } = setup();
  await c.start(); await settle();
  c.runAction("reset_window"); await settle();
  expect(api.resetWindow).toHaveBeenCalledTimes(1);
});

test("a list-write failure during openTitle is shown once", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  const d = deferred<any>(); const real = api.openOrCreate.getMockImplementation()!;
  api.openOrCreate.mockImplementationOnce(() => d.promise);
  const done = c.openTitle("A", "enter");
  c.onArchiveError("permission denied");
  d.resolve(await real("A")); await done; await settle();
  expect(store.get().err).toBe("The archived-notes list could not be updated: permission denied");
  await c.select(1); await settle();
  expect(store.get().err).toBe("");
});

test("a list-write failure during a merge is shown once", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  const d = deferred<any>();
  api.mergeNotes.mockImplementationOnce(() => d.promise);
  await c.startMerge();
  store.set((s) => ({ merge: { ...s.merge!, target: { path: P("B"), title: "B", count: 0 } } }));
  const done = c.commitMerge();
  await settle();
  c.onArchiveError("permission denied");
  d.resolve({ path: P("B"), trash_error: null }); await done; await settle();
  expect(store.get().err).toBe("The archived-notes list could not be updated: permission denied");
  await c.select(1); await settle();
  expect(store.get().err).toBe("");
});

test("two archive presses before the first resolves send one request", async () => {
  const { c, api } = setup();
  await c.start(); await settle();
  const d = deferred<undefined>(); api.setArchived.mockImplementationOnce(() => d.promise);
  const a = c.toggleArchive(), b = c.toggleArchive();
  d.resolve(undefined); await Promise.all([a, b]);
  expect(api.setArchived).toHaveBeenCalledTimes(1);
});

// "solo" is carried only by B. listTags and search follow the switch and B's archived flag, as the backend does.
function soloSetup() {
  const s = setup({ A: "a", B: "b #solo" });
  let bArchived = false;
  const realSet = s.api.setArchived.getMockImplementation()!;
  s.api.setArchived.mockImplementation(async (path: string, on: boolean) => { if (path === P("B")) bArchived = on; return realSet(path, on); });
  s.api.listTags.mockImplementation(async (incl: boolean) => (incl || !bArchived ? [{ tag: "solo", count: 1 }] : []));
  const real = s.api.search.getMockImplementation()!;
  s.api.search.mockImplementation(async (q, sort, off, tags, nl, incl) => {
    if (!tags.length) return real(q, sort, off, tags, nl, incl);
    const show = incl || !bArchived;
    return { hits: show ? [{ ...hit("B"), archived: bArchived }] : [], has_more: false, total: show ? 1 : 0, hidden: show ? 0 : 1 };
  });
  return { ...s, archiveB: (on: boolean) => void (bArchived = on) };
}

test("archiving the only note with the selected tag keeps the filter and shows the hidden line", async () => {
  const { c, store } = soloSetup();
  await c.start(); await settle();
  await c.select(1); await settle(); // B
  c.toggleTagFilter("solo"); await settle();
  await c.toggleArchive(); await settle();
  expect(store.get().selectedTags).toEqual(["solo"]);
  expect(store.get()).toMatchObject({ total: 0, hiddenArchived: 1 });
  expect(chipTags(store.get().tags, store.get().selectedTags)).toEqual([{ tag: "solo", count: 0 }]); // stays in the panel, selected, so it can be cleared
});

test("switching show archived off keeps a selected tag only archived notes carry", async () => {
  const { c, api, store, archiveB } = soloSetup();
  archiveB(true);
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  c.toggleTagFilter("solo"); await settle();
  expect(store.get().total).toBe(1);
  await c.setShowArchived(false); await settle();
  expect(store.get().selectedTags).toEqual(["solo"]);
  expect(store.get()).toMatchObject({ total: 0, hiddenArchived: 1 });
  expect(chipTags(store.get().tags, store.get().selectedTags)).toEqual([{ tag: "solo", count: 0 }]);
});

test("a saved search with a tag only archived notes carry keeps it", async () => {
  const { c, api, store, archiveB } = soloSetup();
  archiveB(true);
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), saved_searches: [{ name: "Solo", query: "", tags: ["solo"], no_links: false }] });
  await c.start(); await settle();
  c.applySaved("Solo"); // no panel reopen, no await: the chip is derived from the state of this update
  expect(chipTags(store.get().tags, store.get().selectedTags)).toEqual([{ tag: "solo", count: 0 }]);
  await settle();
  expect(store.get().selectedTags).toEqual(["solo"]);
  expect(store.get()).toMatchObject({ total: 0, hiddenArchived: 1 });
  expect(chipTags(store.get().tags, store.get().selectedTags)).toEqual([{ tag: "solo", count: 0 }]);
});

test("deselecting a zero-count chip removes it in the same update", async () => {
  const { c, api, store, archiveB } = soloSetup();
  archiveB(true);
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  c.toggleTagFilter("solo"); await settle();
  await c.setShowArchived(false); await settle();
  c.toggleTagFilter("solo");
  expect(store.get().tags).toEqual([]); // no zero-count entry cached in the store
  expect(chipTags(store.get().tags, store.get().selectedTags)).toEqual([]);
});

test("chip counts exclude archived notes when show archived is off and include them when on", async () => {
  const { c, api, store, archiveB } = soloSetup();
  archiveB(true);
  await c.start(); await settle();
  await c.refreshTags(); await settle();
  expect(store.get().tags).toEqual([]); // "solo" is only on archived B
  await c.setShowArchived(true); await settle();
  expect(store.get().tags).toEqual([{ tag: "solo", count: 1 }]);
  expect(api.listTags).toHaveBeenLastCalledWith(true);
  await c.setShowArchived(false); await settle();
  expect(store.get().tags).toEqual([]);
});

test("a selected tag that no note carries any more is still dropped", async () => {
  const { c, api, store } = soloSetup();
  await c.start(); await settle();
  c.toggleTagFilter("solo"); await settle();
  api.listTags.mockImplementation(async () => []);
  await c.refreshTags(); await settle();
  expect(store.get().selectedTags).toEqual([]);
});

test("archive toggle in Tasks mode marks the Notes list stale instead of refreshing it", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  c.setPaneMode("tasks"); await settle();
  const searches = api.search.mock.calls.length;
  await c.toggleArchive(); await settle();
  expect(api.search.mock.calls.length).toBe(searches); // the hidden list is not reloaded now
  c.setPaneMode("notes"); await settle();
  expect(api.search.mock.calls.length).toBeGreaterThan(searches); // it reloads when shown
  expect(store.get().hiddenArchived).toBe(1);
});

// #87: Enter on the exact title of an archived note hidden by the switch
async function withHiddenB() {
  const t = setup();
  await t.api.setArchived("/n/B.md", true);
  await t.c.start(); await settle();
  return t;
}

test("Enter on the exact title of a hidden archived note opens it by path, creates nothing, keeps the switch off (#87)", async () => {
  const { c, api, store, notes } = await withHiddenB();
  c.setQuery("B"); await settle();
  expect(c.row(0)?.title).toBe("A"); // row 0 is not the note typed
  await c.enter();
  expect(store.get().openPath).toBe(P("B"));
  expect(store.get()).toMatchObject({ archived: true, showArchived: false });
  expect(Object.keys(notes)).toEqual(["A", "B", "C"]);
  expect(api.openNote).toHaveBeenLastCalledWith(P("B"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

test("Enter on an exact alias of a hidden archived note opens that note (#87)", async () => {
  const { c, api, store, notes } = await withHiddenB();
  api.listTitles.mockResolvedValue(["A", "B", "C", "Bee"]);
  api.listLinkTargets.mockResolvedValue(["A", "B", "C"].map((t) => ({ name: t, title: t, path: P(t), modified: 0, locked: false })).concat([{ name: "Bee", title: "B", path: P("B"), modified: 0, locked: false }]));
  await c.refreshTitles();
  c.setQuery("Bee"); await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("B"));
  expect(Object.keys(notes)).toEqual(["A", "B", "C"]);
});

test("Enter on an exact title hidden only by a tag filter opens row 0, as before (#87)", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  api.search.mockImplementation(async (_q, _s, _o, tags) => ({ hits: (tags.length ? ["A", "C"] : ["A", "B", "C"]).map(hit), has_more: false, total: 3, hidden: 0 }));
  store.set({ selectedTags: ["x"] });
  c.setQuery("B"); await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("A"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

test("a stale title-cache entry with rows listed opens row 0 and creates nothing (#87)", async () => {
  const { c, api, store, notes } = await withHiddenB();
  api.listTitles.mockResolvedValue(["A", "B", "C", "Ghost"]);
  await c.refreshTitles();
  c.setQuery("Ghost"); await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("A"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(Object.keys(notes)).toEqual(["A", "B", "C"]);
});

test("a row the user arrowed to beats a hidden exact title (#87)", async () => {
  const { c, store } = await withHiddenB();
  c.setQuery("B"); await settle();
  await c.step(1); await settle();
  expect(store.get().sel).toBe(1);
  await c.enter();
  expect(store.get().openPath).toBe(P("C"));
});

test("a locked hidden archived title goes through the normal open path (passphrase prompt) (#87)", async () => {
  const { c, api, calls, store } = await withHiddenB();
  c.setQuery("B"); await settle();
  api.openNote.mockRejectedValueOnce("locked");
  await c.enter();
  expect(calls.some((x) => x[0] === "passphrase")).toBe(true);
  expect(store.get().err).not.toBe("locked");
});

test("a query change during the confirming search voids that Enter; a second Enter opens once (#87)", async () => {
  const { c, api, store } = await withHiddenB();
  c.setQuery("B"); await settle();
  const d = deferred<Page>();
  api.search.mockImplementationOnce(() => d.promise);
  const first = c.enter();
  const second = c.enter();
  await settle();
  c.setQuery("zzz");
  d.resolve({ hits: [{ ...hit("B"), archived: true }], has_more: false, total: 1, hidden: 0 });
  await Promise.all([first, second]); await settle();
  expect(api.openNote).not.toHaveBeenCalledWith(P("B"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).not.toBe(P("B"));
});

test("two quick Enters on a hidden archived title open it once (#87)", async () => {
  const { c, api } = await withHiddenB();
  c.setQuery("B"); await settle();
  await Promise.all([c.enter(), c.enter()]);
  expect(api.openNote.mock.calls.filter((x) => x[0] === P("B"))).toHaveLength(1);
});

test("Shift+Enter on the exact title of a hidden archived note still opens it (#87)", async () => {
  const { c, store, notes } = await withHiddenB();
  c.setQuery("B"); await settle();
  await c.enter(true);
  expect(store.get().openPath).toBe(P("B"));
  expect(Object.keys(notes)).toEqual(["A", "B", "C"]);
});

test("Enter on a visible note's exact title keeps opening the selected row (#87)", async () => {
  const { c, store, api } = await withHiddenB();
  c.setQuery("C"); await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("A")); // row 0, as before
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

test("Enter with no matching title still creates the note (#87)", async () => {
  const { c, store, notes } = await withHiddenB();
  c.setQuery("zzz"); await settle();
  await c.enter(true);
  expect(store.get().openPath).toBe(P("zzz"));
  expect(Object.keys(notes)).toContain("zzz");
});

test("Enter with the switch on is unchanged: the archived note is listed, so the selected row opens (#87)", async () => {
  const { c, store, api } = await withHiddenB();
  await c.setShowArchived(true); await settle();
  c.setQuery("B"); await settle();
  await c.enter();
  expect(store.get().openPath).toBe(P("A"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

// #89: a held bound key fires once
test("a held Archive shortcut toggles once; a second press toggles again (#89)", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  store.set({ keys: { ...store.get().keys, archive_note: "Mod+KeyY" } });
  expect(c.onKeyDown(key("KeyY", { meta: true }))).toBe(true);
  await settle();
  expect(api.setArchived).toHaveBeenCalledTimes(1);
  expect(c.onKeyDown({ ...key("KeyY", { meta: true }), repeat: true })).toBe(true); // handled: no browser default
  await settle();
  expect(api.setArchived).toHaveBeenCalledTimes(1);
  expect(c.onKeyDown(key("KeyY", { meta: true }))).toBe(true);
  await settle();
  expect(api.setArchived).toHaveBeenCalledTimes(2);
});

test("a held Back shortcut keeps stepping (#89)", async () => {
  const { c } = setup();
  const nav = vi.spyOn(c, "navigate").mockResolvedValue(undefined);
  c.onKeyDown({ ...key("KeyJ", { meta: true }), repeat: true }); // back's default
  expect(nav).toHaveBeenCalledWith("back");
});

test("an unlock field left up after Enter on a locked hidden archived title does not freeze Enter (#87)", async () => {
  const { c, api, ui, store } = await withHiddenB();
  c.setQuery("B"); await settle();
  api.openNote.mockRejectedValueOnce("locked");
  (ui as any).passphrase = () => new Promise(() => {}); // the field stays up
  void c.enter();
  await settle();
  c.setQuery("C"); await settle();
  const opens = api.openNote.mock.calls.length;
  await c.enter();
  await settle();
  expect(api.openNote.mock.calls.length).toBeGreaterThan(opens); // Enter opens the selected row, as on main
  expect(store.get().openPath).toBe(P("A"));
});

const noHits = async (): Promise<Page> => ({ hits: [], has_more: false, total: 0, hidden: 0 });

test("a stale title-cache entry with no results behaves as on main: Enter creates the typed title (#87)", async () => {
  const { c, api, store, notes } = await withHiddenB();
  api.listTitles.mockResolvedValue(["A", "B", "C", "Ghost"]);
  await c.refreshTitles();
  api.search.mockImplementation(noHits);
  c.setQuery("Ghost"); await settle();
  await c.enter();
  expect(api.openOrCreate).toHaveBeenCalledWith("Ghost");
  expect(store.get().openPath).toBe(P("Ghost"));
  expect(Object.keys(notes)).toContain("Ghost");
});

test("a failing confirm search with the query unchanged falls back to row 0 (#87)", async () => {
  const { c, api, store } = await withHiddenB();
  c.setQuery("B"); await settle();
  api.search.mockRejectedValueOnce("boom");
  await c.enter();
  expect(store.get().openPath).toBe(P("A"));
  expect(api.openOrCreate).not.toHaveBeenCalled();
});

test("a failing confirm search after the query changed voids that Enter: nothing opens, nothing is created (#87)", async () => {
  const { c, api, store, notes } = await withHiddenB();
  c.setQuery("B"); await settle();
  const d = deferred<Page>();
  api.search.mockImplementationOnce(() => d.promise);
  const entered = c.enter();
  await settle();
  api.search.mockImplementation(noHits);
  c.setQuery("zzz"); await settle();
  d.reject("boom");
  await entered; await settle();
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(Object.keys(notes)).toEqual(["A", "B", "C"]);
  expect(store.get().openPath).not.toBe(P("zzz"));
});

test("arrowing to another row during the confirm search voids that Enter; the arrowed row stays open (#87)", async () => {
  const { c, api, store } = await withHiddenB();
  c.setQuery("B"); await settle();
  const d = deferred<Page>();
  api.search.mockImplementationOnce(() => d.promise);
  const entered = c.enter();
  await settle();
  await c.step(1); await settle(); // step() opens the row itself
  d.resolve({ hits: [{ ...hit("B"), archived: true }], has_more: false, total: 1, hidden: 0 });
  await entered; await settle();
  expect(api.openNote).not.toHaveBeenCalledWith(P("B"));
  expect(store.get().openPath).toBe(P("C"));
});
