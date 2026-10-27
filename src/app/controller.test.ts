import { expect, test } from "vitest";
import type { Page } from "../api";
import { Controller, type KeyEventLike } from "./controller";
import { FakeEditor, FakePreview, deferred, fakeApi, fakeUi, hit, noMeta, settle } from "./fakes";
import { createStore, initialState } from "./store";

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
  expect(store.get().update).toEqual({ version: "0.6.1", status: "installing" });
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
  expect(store.get().update).toBeNull();
  expect(store.get().err).toBe("Update failed: signature mismatch");
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
  api.listRevisions.mockResolvedValue([{ id: "1", ts: 5, size: 1 }]);
  api.backlinkCount.mockResolvedValue(3);
  await c.toggleInfo();
  await settle();
  expect(api.setSettings).toHaveBeenCalledWith(expect.objectContaining({ info_panel: true }));
  expect(store.get().info.backlinks).toBe(3);
  expect(store.get().info.revisions).toEqual([{ id: "1", ts: 5, size: 1 }]);
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
