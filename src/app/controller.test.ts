import { expect, test } from "vitest";
import type { Page } from "../api";
import { Controller } from "./controller";
import { FakeEditor, FakePreview, deferred, fakeApi, fakeUi, hit, settle } from "./fakes";
import { createStore, initialState } from "./store";

function setup(notes: Record<string, string> = { A: "a", B: "b", C: "c" }) {
  const { api } = fakeApi(notes);
  const { ui, calls } = fakeUi();
  const store = createStore(initialState(true));
  const c = new Controller(store, api, ui, { isMac: true, platform: "mac" });
  const editor = new FakeEditor();
  c.attachEditor(editor);
  c.attachPreview(new FakePreview());
  return { c, api, ui, calls, store, editor, notes };
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

test("auto-shown note not in history until edited", async () => {
  const { c, api, store } = setup();
  await c.runSearch(true);
  await settle();
  await c.select(0); // explicit A
  await c.step(1); // arrow: B, auto
  expect(store.get().openPath).toBe(P("B"));
  await c.navigate("back");
  expect(store.get().openPath).toBe(P("A"));
  api.openNote.mockClear();
  await c.navigate("forward"); // B was never recorded
  expect(api.openNote).not.toHaveBeenCalled();
  expect(store.get().openPath).toBe(P("A"));
});

test("an auto-shown note joins history on its first edit", async () => {
  const { c, store } = setup();
  await c.runSearch(true);
  await settle();
  await c.select(0);
  await c.step(1);
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
