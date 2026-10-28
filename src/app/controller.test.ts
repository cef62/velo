import { expect, test, vi } from "vitest";
import type { Page, TaskItem, TaskView } from "../api";
import { Controller, type KeyEventLike } from "./controller";
import { FakeEditor, FakePreview, deferred, fakeApi, fakeUi, hit, noMeta, settle } from "./fakes";
import { createStore, initialState } from "./store";
import { localToday, toggleTaskLine } from "../tasks";

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
  d.resolve({ hits: [hit("ab")], has_more: false, total: 1 });
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
    offset === 0 ? { hits: [hit("A"), hit("B")], has_more: true, total: 7 } : { hits: [hit("C")], has_more: false, total: 0 });
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
  api.openNote.mockResolvedValueOnce({ path: "/n/A.age", title: "A", text: "a", hash: "h", encrypted: true, meta: noMeta });
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

test("a slow auto-show doesn't replace the note Enter just opened", async () => {
  const { c, api, store } = setup();
  const d = deferred<ReturnType<typeof api.openNote> extends Promise<infer T> ? T : never>();
  api.openNote.mockImplementationOnce(() => d.promise);
  const auto = c.show(P("A"), "auto");
  await c.openTitle("B", "enter");
  d.resolve({ path: P("A"), title: "A", text: "a", hash: "h", encrypted: false, meta: noMeta });
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
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta });
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
  d.resolve({ path: P("A"), title: "A", text: "a", hash: "h", encrypted: false, meta: noMeta });
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
  api.openNote.mockResolvedValueOnce({ path: P("Z"), title: "Z", text: "a", hash: "h", encrypted: false, meta: noMeta });
  await c.commitRename("  Z ");
  expect(calls).toContainEqual(["confirm", "Update 2 links to the new title?", { title: "Rename", kind: "info" }]);
  expect(api.renameNote).toHaveBeenCalledWith(P("A"), "Z", true);
  expect(store.get()).toMatchObject({ renaming: false, title: "Z", openPath: P("Z") });
  c.startRename();
  await c.commitRename(null);
  expect(api.renameNote).toHaveBeenCalledTimes(1);
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
  expect(api.backlinkCount).not.toHaveBeenCalled();
  api.listRevisions.mockResolvedValue([{ id: "1", ts: 5, size: 1, agent: false }]);
  api.backlinkCount.mockResolvedValue(3);
  await c.toggleInfo();
  await settle();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ info_panel: true }));
  expect(store.get().info.backlinks).toBe(3);
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

const task = (title: string, line: number, line_text: string): TaskItem => ({ path: P(title), title, line, text: line_text.replace(/^- \[.\] /, ""), due: null, done: false, done_on: null, line_text });
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

test("search and tags are shared between modes", async () => {
  const { c, api } = setup();
  c.setPaneMode("tasks");
  c.setQuery("x");
  await settle();
  expect(api.tasks).toHaveBeenCalledWith("x", [], false);
  c.setTags(["work"]);
  await settle();
  expect(api.tasks).toHaveBeenCalledWith("x", ["work"], false);
  await c.toggleShowDone();
  expect(api.tasks).toHaveBeenCalledWith("x", ["work"], true);
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
  c.onKeyDown({ key: "x", code: "KeyX", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, inEditor: false, inSearchWithText: false, inDialog: false, inRename: false });
  expect(store.get().paneMode).toBe("tasks");
  await settle();
  expect(api.tasks).toHaveBeenCalledTimes(1);
  await c.onNotesChanged([]);
  expect(api.tasks).toHaveBeenCalledTimes(2);
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
  c.onKeyDown({ key: "D", code: "KeyD", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, inEditor: false, inSearchWithText: false, inDialog: false, inRename: false });
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

test("Enter in Tasks mode opens the first visible task, never creates a note", async () => {
  const { c, api, store, editor } = setup({ A: "x\n- [ ] a", B: "- [ ] b" });
  api.tasks.mockResolvedValue({ ...view(1), today: [task("B", 0, "- [ ] b")], no_date: [task("A", 1, "- [ ] a")] });
  c.setPaneMode("tasks");
  c.setQuery("zzz");
  await settle();
  await c.enter();
  await c.enter(true, true);
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("B"));
  expect(editor.revealed).toEqual([0, 0]);
});

test("Enter in Tasks mode with no tasks does nothing", async () => {
  const { c, api, editor } = setup();
  c.setPaneMode("tasks");
  c.setQuery("zzz");
  await settle();
  await c.enter(true);
  expect(api.openOrCreate).not.toHaveBeenCalled();
  expect(editor.revealed).toEqual([]);
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
  const secret: TaskItem = { path: "/n/S.md.age", title: "S", line: 0, text: "secret", due: localToday(), done: false, done_on: null, line_text: "- [ ] secret" };
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

test("typing a filter in Tasks mode never opens a note; back in Notes the list follows without opening", async () => {
  const { c, api, store } = setup({ A: "a", "milk run": "x" });
  c.setPaneMode("tasks");
  await settle();
  c.setQuery("milk");
  c.setTags(["home"]);
  await settle();
  expect(store.get().openPath).toBe(null);
  expect(api.openNote).not.toHaveBeenCalled();
  expect(api.tasks).toHaveBeenCalledWith("milk", ["home"], false);
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
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1 })); // the query matches Groceries only
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
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1 })); // the query matches Groceries only
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
  d.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
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
    api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1 }));
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
const taskOf = (path: string, line_text: string, line = 0): TaskItem => ({ path, title: "", line, text: line_text.slice(6), due: null, done: false, done_on: null, line_text });

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
  search.resolve({ hits: [hit("A"), hit("B")], has_more: false, total: 2 });
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
  d.resolve({ path: P("B"), title: "B", text: "b", hash: "h", encrypted: false, meta: noMeta });
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
    return { path, title: "A", text: "a", hash: "h", encrypted: false, meta: noMeta };
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
  api.openNote.mockImplementation(async (path: string) => ({ path, title: "A", text: notes.A, hash: `h:${notes.A}`, encrypted: false, meta: noMeta }));
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
  expect(c.busy).toBe(false);
  expect(api.agentWriteDone).toHaveBeenCalledWith(6, "ok");
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
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries")], has_more: false, total: 1 }));
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

test("a capture retry with corrected text replaces the unsaved line instead of adding a second (#8)", async () => {
  const { c, editor, store } = setup({ Inbox: "", B: "b" });
  await c.show(P("Inbox"));
  await c.startCapture();
  c.setQuery("buy mlik");
  editor.flushResult = false;
  await c.submitCapture("buy mlik");
  c.setQuery("buy milk");
  editor.flushResult = true;
  await c.submitCapture("buy milk");
  expect(editor.text).toBe("- [ ] buy milk");
  expect(store.get().capture).toBeNull();
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
  api.search.mockImplementation(async () => ({ hits: [hit("A"), hit("B"), hit("C")], has_more: false, total: 3 }));
  c.setTags(["work"]);
  await settle();
  await settle(); // A open, sel 0
  api.search.mockImplementation(async () => ({ hits: [hit("B"), hit("C")], has_more: false, total: 2 }));
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
    api.search.mockImplementation(async () => ({ hits: [hit("B"), hit("C")], has_more: false, total: 2 }));
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
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries"), hit("Y")], has_more: false, total: 2 }));
  c.setPaneMode("tasks");
  c.setQuery("g");
  await settle();
  c.setPaneMode("notes");
  await settle();
  expect(store.get().sel).toBe(0); // Groceries highlighted, X open and not listed
  api.search.mockImplementation(async () => ({ hits: [hit("Y"), hit("Groceries")], has_more: false, total: 2 }));
  await c.onNotesChanged([]);
  expect(store.get().sel).toBe(1);
  api.search.mockImplementation(async () => ({ hits: [hit("Groceries"), hit("Y")], has_more: false, total: 2 }));
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
    d1.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
    d2.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
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
  d1.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
  await settle();
  d2.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
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
  d1.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
  d2.resolve({ hits: [hit("Groceries")], has_more: false, total: 1 });
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

test("a task load started before a tick never restores the unticked row (#15 Copilot)", async () => {
  const { c, api, editor, store } = setup({ A: "- [ ] x" });
  api.tasks.mockResolvedValue({ ...view(0), no_date: [task("A", 0, "- [ ] x")] });
  await c.loadTasks();
  await c.show(P("A"));
  const d = deferred<TaskView>();
  api.tasks.mockImplementationOnce(() => d.promise);
  const loading = c.loadTasks(); // e.g. a watcher refresh, still in flight
  editor.toggleTask.mockImplementation(() => ((editor.text = "- [x] x ✅ 2026-10-27"), true));
  await c.tickTask(store.get().taskView!.no_date[0]);
  d.resolve({ ...view(0), no_date: [task("A", 0, "- [ ] x")] }); // read before the tick was saved
  await loading;
  expect(store.get().taskView!.no_date[0].done).toBe(true);
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
