import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mountEditor } from "./editor";
import { Results, mountList } from "./list";
import { shouldClose } from "./close";
import { latest } from "./latest";
import { History } from "./history";
import { errText } from "./errtext";
import { enterAction, fold, moveSelection } from "./search";
import { filterLabel, pruneSelection, toggleTag } from "./tags";
import { afterOpen, mountPreview, shouldAutoEdit } from "./preview";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { isMenuKey, linkFor, menuModel, type MenuAction } from "./contextmenu";
import { askPassphrase, isLockedPath } from "./passphrase";
import { applyLook, fixedKeyRefusal, recorderStep, toSettings } from "./settingsform";
import { DEFAULTS, LABELS, formatBinding, matches, resolve, validateBinding, type Action } from "./shortcuts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = $<HTMLInputElement>("q");
const titleEl = $<HTMLSpanElement>("title");
const errEl = $<HTMLSpanElement>("err");
const statusEl = $<HTMLSpanElement>("status");

const isMac = navigator.platform.startsWith("Mac");

let sel = -1;
let searchSeq = 0;
let selectedTags: string[] = []; // session-only tag filter (AND), display spellings
let allTags: api.TagCount[] = [];
let sort: api.Settings["sort"] = "modified"; // mirrors settings.sort; set from settings before the first search

/** Row height in px: the CSS --row-h (scales with the font size), measured so CSS and JS cannot drift. */
function rowHeight(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:var(--row-h)";
  document.body.append(probe);
  const h = Math.round(probe.getBoundingClientRect().height);
  probe.remove();
  return h || 44;
}
const results = new Results((offset) => api.search(q.value, sort, offset, selectedTags));
const list = mountList($("list"), { results, rowH: rowHeight(), onSelect: (i) => void select(i), onContextMenu: (i) => void openContextMenu(i) });
const sortBtn = $<HTMLButtonElement>("sort");

// Set while a lock/unlock hand-off is in flight: the open note's file is moving, so navigation is refused.
let busy = false;
const BUSY_MSG = "Busy — try again in a moment";
// One-shot notice (e.g. keychain unavailable) that survives the next errEl reset.
let notice = "";
const clearErr = () => {
  errEl.textContent = notice;
  notice = "";
};

/** Search field and editor are read-only while the backend indexes; commands reject with "indexing" meanwhile. */
function setIndexing(on: boolean, done = 0, total = 0) {
  statusEl.textContent = on ? `Indexing… ${done.toLocaleString()} / ${total.toLocaleString()}` : "";
  // Not editor.suspend(): the saver stays live, so a flush still tries, fails with "indexing" and stays dirty (close asks).
  editor.setReadOnly(on);
  q.disabled = on;
}
const history = new History();

let titles = new Set<string>(); // folded titles of all notes, for wikilink existence
const newShow = latest();
const editor = mountEditor($("editor"), {
  onEscape: focusSearch,
  onError: (m) => (errEl.textContent = m ? errText(m) : ""),
  onChange: () => preview.refresh(),
  onEdit: () => history.edited(editor.currentPath()),
  onSaved: () => scheduleTagRefresh(),
});
const preview = mountPreview($("preview"), {
  getText: () => editor.getText(),
  toggleLabel: () => formatBinding(keys.toggle_preview, isMac),
  exists: (t) => titles.has(fold(t)),
  onWikilink: (t) => void openTitle(t, "wikilink"),
  onTag: (t) => {
    showTags(true);
    if (!selectedTags.some((s) => fold(s) === fold(t))) setTags(toggleTag(selectedTags, t));
  },
  openExternal: (u) => void openUrl(u).catch((e) => (errEl.textContent = String(e))),
  onToggle: (on) => {
    $("app").classList.toggle("preview-on", on);
    $("preview-badge").hidden = !on;
  },
});
$("preview-badge").onclick = () => preview.setMode(false);

async function refreshTitles() {
  try {
    titles = new Set((await api.listTitles()).map(fold));
    preview.refresh();
  } catch (e) {
    console.error("title cache refresh failed", e);
  }
}

function focusSearch() {
  q.focus();
  q.select();
}

/**
 * false = refused: unsaved edits could not be saved (error stays visible), nothing changed.
 * "missing" (only when `nav`, i.e. a history step, which does not record a visit) = the file is gone; no error shown.
 */
async function show(path: string, how: "explicit" | "auto" | "nav" = "explicit", retried = false): Promise<boolean | "missing"> {
  if (busy) {
    errEl.textContent = BUSY_MSG;
    return false;
  }
  const current = newShow();
  try {
    if (!(await editor.flush())) return false;
    const doc = await api.openNote(path);
    if (!current()) return true;
    if (!editor.load(doc)) return false;
    titleEl.textContent = doc.title;
    clearErr();
    if (shouldAutoEdit({ created: false, body: doc.text, previewOn: preview.isOn() })) preview.setMode(false);
    history.loaded(doc.path, how);
  } catch (e) {
    if (how === "nav" && e === "not-found") return "missing";
    if (e === "locked" && !retried && (await promptPassphrase())) return show(path, how, true);
    errEl.textContent = e === "locked" ? "Note is locked" : errText(e);
    if (how === "nav") return false; // history cursor must be restored
  }
  return true;
}

/** Passphrase dialog; true once the identity is available. Wording depends on identity.age existing. */
async function promptPassphrase(): Promise<boolean> {
  try {
    return await askPassphrase(await api.identityFileExists(), async (pw) => {
      if ((await api.setupPassphrase(pw)) === "keychain-unavailable") {
        notice = "Keychain unavailable — you'll be asked for your passphrase each launch";
        errEl.textContent = notice;
      }
    });
  } catch (e) {
    errEl.textContent = errText(e);
    return false;
  }
}

/**
 * Lock/unlock the open note. The editor is suspended (read-only, no saves) from after the flush until
 * it is rebound to the new path, so no autosave/blur/watcher save can recreate the old path.
 */
async function toggleLock() {
  if (busy) return;
  const path = editor.currentPath();
  if (!path) return;
  busy = true;
  try {
    await lockHandoff(path);
  } finally {
    busy = false;
  }
}

async function lockHandoff(path: string) {
  try {
    if (!(await api.hasIdentity()) && !(await promptPassphrase())) return;
    if (!(await editor.flush())) return; // error already visible
  } catch (e) {
    errEl.textContent = errText(e);
    return;
  }
  if (editor.currentPath() !== path) return; // belt and braces: the open note changed during the awaits
  editor.suspend();
  let np: string;
  try {
    np = isLockedPath(path) ? await api.unlockNote(path) : await api.lockNote(path);
  } catch (e) {
    editor.resume(); // nothing moved: old path is still valid
    errEl.textContent = e === "already-exists" ? "A note with that title already exists in the other form" : errText(e);
    return;
  }
  try {
    const doc = await api.openNote(np);
    history.rename(path, np);
    if (editor.rebind(path, doc)) {
      editor.resume();
      titleEl.textContent = doc.title;
      clearErr();
      history.loaded(np, "explicit");
    }
    await runSearch(false);
    selectOpen();
  } catch (e) {
    // The file moved but could not be reopened: stay read-only (never resume on the old path).
    errEl.textContent = `Note moved but could not be reopened (${e}); pick it from the list`;
    void runSearch(false);
  }
}

/** Move the open note (or the highlighted row when none is open) to the Trash after confirmation. */
async function deleteNote() {
  if (busy) {
    errEl.textContent = BUSY_MSG;
    return;
  }
  if (q.disabled) {
    errEl.textContent = errText("indexing"); // the backend would refuse after we detached the editor
    return;
  }
  const open = editor.currentPath();
  const path = open ?? results.get(sel)?.path;
  if (!path) return;
  const title = open ? titleEl.textContent : results.get(sel)?.title;
  const row = results.indexOf(path);
  if (!(await ask(`Move “${title}” to the Trash?`, { title: "Delete note", kind: "warning", okLabel: "Move to Trash" }))) return;
  busy = true;
  let reopen = false;
  try {
    if (editor.currentPath() === path) {
      // save first so a failed delete can't lose edits; then detach so autosave can't recreate the file
      if (!(await editor.flush())) {
        errEl.textContent = "Can't delete: unsaved changes couldn't be saved";
        return;
      }
      editor.discard();
      titleEl.textContent = "";
      reopen = true;
    }
    await api.deleteNote(path);
    reopen = false;
    history.remove(path);
    clearErr();
  } catch (e) {
    errEl.textContent = errText(e);
  } finally {
    busy = false;
  }
  if (reopen) await show(path); // delete failed after detaching: put the note back
  await runSearch(false);
  if (!editor.currentPath() && row >= 0 && results.count) {
    sel = Math.min(row, results.count - 1); // highlight the neighbour (not opened) so Enter keeps working
    list.setSelected(sel);
  }
  void refreshTitles();
  focusSearch();
}

async function lockEverything() {
  if (busy) return;
  busy = true;
  try {
    const path = editor.currentPath();
    if (!(await editor.flush())) return;
    if (editor.currentPath() !== path) return;
    editor.suspend();
    try {
      await api.lockAll();
    } catch (e) {
      editor.resume();
      throw e;
    }
    if (path && isLockedPath(path)) {
      editor.unload(); // drop the decrypted text from the editor and stop autosave re-caching it
      titleEl.textContent = "";
    } else editor.resume();
    await runSearch(false);
    void refreshTags(); // a tag only a now-locked note had must leave the panel and filter
  } catch (e) {
    errEl.textContent = errText(e);
  } finally {
    busy = false;
  }
}

async function openSettings() {
  if (!(await editor.flush())) return;
  const cur = await api.getSettings();
  const dlg = $<HTMLDialogElement>("settings");
  const form = dlg.querySelector("form")!;
  const msg = form.querySelector(".msg") as HTMLElement;
  let dir = cur.notes_dir;
  const field = (id: string) => $<HTMLInputElement>(id);
  $("s-dir").textContent = dir ?? "(none)";
  field("s-layout").value = cur.layout;
  field("s-font").value = String(cur.font_size);
  field("s-sort").value = cur.sort;
  msg.textContent = "";
  const draft = resolve(cur.shortcuts, isMac);
  let recording: Action | null = null;
  const table = $<HTMLTableElement>("s-keys");
  const render = (focus?: Action) => {
    table.replaceChildren();
    for (const a of Object.keys(DEFAULTS) as Action[]) {
      const tr = table.insertRow();
      tr.insertCell().textContent = LABELS[a];
      const rec = document.createElement("button");
      rec.type = "button";
      rec.textContent = recording === a ? "Press keys…" : formatBinding(draft[a], isMac);
      rec.onclick = () => { msg.textContent = ""; setRecording(a); };
      tr.insertCell().append(rec);
      if (a === focus) rec.focus(); // render() destroys the clicked button; keep focus on the row
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Reset";
      reset.disabled = draft[a] === DEFAULTS[a];
      reset.onclick = () => assign(a, DEFAULTS[a]);
      tr.insertCell().append(reset);
    }
  };
  const assign = (a: Action, binding: string) => {
    const v = validateBinding(draft, a, binding, isMac);
    const reason = v.ok ? fixedKeyRefusal(binding) : v.reason;
    if (reason) msg.textContent = reason;
    else { draft[a] = binding; msg.textContent = ""; }
    setRecording(null, a);
  };
  // While recording, a window-level capture listener owns every key (focus may be on body after a re-render),
  // so menu/webview defaults (⌘W, ⌘,) don't act. Removed whenever recording ends.
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const step = recorderStep(recording, e, isMac, draft);
    if (step.msg !== undefined) msg.textContent = step.msg;
    if (step.assign) draft[recording!] = step.assign;
    const done = recording!;
    if (step.recording === null) setRecording(null, done);
  };
  const setRecording = (a: Action | null, focus?: Action) => {
    window.removeEventListener("keydown", onKey, true);
    recording = a;
    if (a) window.addEventListener("keydown", onKey, true);
    render(a ?? focus);
  };
  dlg.onclose = () => setRecording(null);
  dlg.oncancel = (e) => { if (recording) e.preventDefault(); };
  $("s-reset-all").onclick = () => { Object.assign(draft, DEFAULTS); msg.textContent = ""; setRecording(null); };
  render();
  $("s-choose").onclick = async () => {
    const d = await open({ directory: true });
    if (typeof d === "string") $("s-dir").textContent = dir = d;
  };
  (form.querySelector("[value=cancel]") as HTMLButtonElement).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const next = { ...toSettings(cur, { layout: field("s-layout").value, fontSize: field("s-font").value, sort: field("s-sort").value, shortcuts: draft }), notes_dir: dir };
    const save = form.querySelector("[type=submit]") as HTMLButtonElement;
    if (save.disabled) return; // a save is already in flight (Enter also submits)
    save.disabled = true;
    try {
      await api.setSettings(next); // on hotkey registration failure this throws and the old hotkey stays
    } catch (err) {
      msg.textContent = err === "not-found" ? "Folder not found" : String(err);
      return;
    } finally {
      save.disabled = false;
    }
    applyLook(next);
    list.setRowH(rowHeight());
    keys = resolve(next.shortcuts, isMac);
    preview.refresh(); // watermark shows the binding
    sort = next.sort;
    syncSort();
    dlg.close();
    if (next.notes_dir !== cur.notes_dir) {
      $("setup").hidden = true;
      await runSearch(true);
      void refreshTitles();
    } else if (next.sort !== cur.sort) await resort();
  };
  dlg.showModal();
}

/** Select the open note's row (none if it is not loaded). */
function selectOpen() {
  sel = results.indexOf(editor.currentPath() ?? "");
  list.setSelected(sel);
}

/** false = the switch was refused (unsaved edits / busy). */
async function select(i: number, how: "explicit" | "auto" = "explicit"): Promise<boolean> {
  sel = i;
  list.setSelected(i);
  const h = results.get(i);
  if (h && !(await show(h.path, how))) {
    selectOpen(); // refused: snap back to the open note
    return false;
  }
  return true;
}

const platform = isMac ? "mac" : /Windows/.test(navigator.userAgent) ? "windows" : "linux";

let menuBusy = false; // re-entrancy guard: select awaiting or popup being built
let lastMenu: { close(): Promise<void> }[] = []; // popup() resolves when shown, so free the previous menu's Rust-side resources on the next open

/** Open row `i` through the normal path, then pop the native menu for it. No menu if the switch was refused. `atRow`: anchor at the row (keyboard) instead of the cursor. */
async function openContextMenu(i: number, atRow = false) {
  const h = results.get(i);
  if (!h || menuBusy) return;
  menuBusy = true;
  try {
    if (!(await select(i)) || editor.currentPath() !== h.path) return;
    const open = () => editor.currentPath(); // actions use the note open when picked
    const run: Record<MenuAction, () => void | Promise<void>> = {
      open: () => settleAfterOpen(false, "enter"),
      rename: startRename,
      toggle_lock: toggleLock,
      copy_link: () => { const p = open(); if (p) return navigator.clipboard.writeText(linkFor(titleEl.textContent ?? "")); },
      reveal: () => { const p = open(); if (p) return revealItemInDir(p); },
      delete_note: deleteNote,
    };
    const old = lastMenu;
    lastMenu = [];
    for (const r of old) void r.close().catch(() => {});
    const items = await Promise.all(
      menuModel({ encrypted: h.encrypted, platform, keys, isMac }).map((m) =>
        m === "separator"
          ? PredefinedMenuItem.new({ item: "Separator" })
          : MenuItem.new({ ...m, action: () => void Promise.resolve(run[m.id]()).catch((e) => (errEl.textContent = errText(e))) }),
      ),
    );
    const menu = await Menu.new({ items });
    lastMenu = [...items, menu];
    const r = atRow ? document.querySelector("#list .row.sel")?.getBoundingClientRect() : undefined;
    await menu.popup(r ? new LogicalPosition(r.left + 16, r.bottom) : undefined);
  } catch (e) {
    errEl.textContent = errText(e);
  } finally {
    menuBusy = false;
  }
}

/** true = fresh first page (new query/folder/sort), selecting its first row; false = reload the loaded range in place. */
let searching: Promise<void> = Promise.resolve(); // latest list reset, awaited by Enter so it never acts on stale rows
function runSearch(selectFirst: boolean, keepOpen: boolean | "highlight" = false): Promise<void> {
  const p = doSearch(selectFirst, keepOpen);
  if (selectFirst) searching = p;
  return p;
}
/** keepOpen: after a reset, stay on the open note when it is in the new first page instead of opening row 0. "highlight": and with no note open, highlight row 0 without opening it. */
async function doSearch(selectFirst: boolean, keepOpen: boolean | "highlight") {
  const seq = ++searchSeq;
  try {
    await (selectFirst ? results.reset() : results.refresh());
    if (seq !== searchSeq) return;
    if (selectFirst) {
      list.toTop();
      list.update();
      if (keepOpen && results.indexOf(editor.currentPath() ?? "") >= 0) selectOpen();
      else if (keepOpen === "highlight" && editor.currentPath() === null) {
        sel = results.count ? 0 : -1; // nothing open: highlight row 0, don't open it
        list.setSelected(sel);
      } else void select(results.count ? 0 : -1, "auto");
    } else {
      list.update();
      selectOpen();
    }
  } catch (e) {
    if (e === "no-folder") $("setup").hidden = false;
    else if (e !== "indexing") console.error("search failed", e);
  }
}

const tagPanel = $("tagpanel");
const tagBtn = $<HTMLButtonElement>("tagbtn");
const filterLine = $("filterline");
const isSelected = (t: string) => selectedTags.some((s) => fold(s) === fold(t));

function renderTags() {
  tagPanel.replaceChildren(
    ...allTags.map(({ tag, count }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("aria-pressed", String(isSelected(tag)));
      b.append(`#${tag} `);
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(count);
      b.append(n);
      b.onclick = () => setTags(toggleTag(selectedTags, tag));
      return b;
    }),
  );
  if (selectedTags.length) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "clear";
    c.textContent = "Clear";
    c.onclick = () => setTags([]);
    tagPanel.append(c);
  }
  filterLine.hidden = !selectedTags.length;
  filterLine.firstElementChild!.textContent = filterLabel(selectedTags);
}

function showTags(on: boolean) {
  tagPanel.hidden = !on;
  tagBtn.setAttribute("aria-pressed", String(on));
  tagBtn.setAttribute("aria-label", on ? "Hide tags" : "Show tags");
  if (on) void refreshTags(); // counts may have moved since the last refresh
}

/** Tag filter changed: fresh first page, keeping the open note selected if it is still listed. */
function setTags(next: string[]) {
  selectedTags = next;
  renderTags();
  void runSearch(true, true);
}

const newTagsReq = latest();
let tagTimer: ReturnType<typeof setTimeout> | undefined;
/** After an in-app save (self-writes are skipped by the watcher): coalesce typing bursts into one refresh. */
function scheduleTagRefresh() {
  clearTimeout(tagTimer);
  tagTimer = setTimeout(() => void refreshTags(true), 300);
}

/** inPlace: when a filter is active, also reload the list so it reflects the new tag state. */
async function refreshTags(inPlace = false) {
  const fresh = newTagsReq();
  let tags: api.TagCount[];
  try {
    tags = await api.listTags();
  } catch (e) {
    if (e !== "indexing") console.error("tag refresh failed", e);
    return;
  }
  if (!fresh()) return; // a newer refresh superseded this response
  allTags = tags;
  const kept = pruneSelection(selectedTags, allTags);
  const pruned = kept.length !== selectedTags.length;
  selectedTags = kept;
  renderTags();
  if (pruned) void runSearch(true, "highlight");
  else if (inPlace && selectedTags.length) void runSearch(false);
}

function syncSort() {
  sortBtn.textContent = sort === "title" ? "A→Z" : "Recent";
  sortBtn.title = `Toggle sort (${formatBinding(keys.toggle_sort, isMac)})`;
}

/** Sort changed: fresh first page from the top, keeping the open note selected if it is loaded. */
async function resort() {
  const seq = ++searchSeq;
  try {
    await results.reset();
    if (seq !== searchSeq) return;
    list.toTop();
    list.update();
    selectOpen();
  } catch (e) {
    if (e !== "indexing") console.error("search failed", e);
  }
}

async function toggleSort() {
  try {
    const cur = await api.getSettings();
    const next = cur.sort === "title" ? "modified" : "title";
    await api.setSettings({ ...cur, sort: next });
    sort = next;
    syncSort();
    await resort();
  } catch (e) {
    errEl.textContent = errText(e);
  }
}

/** Leave preview / focus the editor as afterOpen decides, for the note that is now open. */
function settleAfterOpen(created: boolean, source: "enter" | "wikilink") {
  const r = afterOpen({
    created,
    body: editor.getText(),
    layout: $("app").classList.contains("horizontal") ? "horizontal" : "vertical",
    previewOn: preview.isOn(),
    source,
  });
  if (r.leavePreview) preview.setMode(false);
  if (r.focusEditor) editor.focus();
}

async function enter(force = false) {
  await searching;
  const a = enterAction(q.value, results.loaded, results.get(sel), force);
  if (!a) return;
  try {
    if (a.kind === "open") {
      // show() reports true even when it swallowed an open error; only settle if the note really loaded
      if (!(await show(a.path)) || editor.currentPath() !== a.path) return;
      settleAfterOpen(false, "enter");
    } else await openTitle(a.title, "enter");
  } catch (e) {
    errEl.textContent = errText(e);
  }
}

/** Open the note titled `title`, creating it if missing; same flush-then-load path as everywhere. */
async function openTitle(title: string, source: "enter" | "wikilink"): Promise<boolean> {
  if (busy) {
    errEl.textContent = BUSY_MSG;
    return false;
  }
  try {
    if (!(await editor.flush())) return false;
    // The title cache is the "existed before" signal (open_or_create returns a plain NoteDoc). A stale cache only
    // mislabels an empty/external note, which the empty-body rule below still opens in edit mode.
    const created = !titles.has(fold(title));
    const doc = await api.openOrCreate(title);
    if (!editor.load(doc)) return false;
    titleEl.textContent = doc.title;
    errEl.textContent = "";
    history.loaded(doc.path, "explicit");
    if (created) {
      q.value = doc.title; // list the new note, selected (resort keeps the open note selected)
      await resort();
    } else await runSearch(false);
    void refreshTitles();
    if (editor.currentPath() === doc.path) settleAfterOpen(created, source);
    return true;
  } catch (e) {
    errEl.textContent = errText(e);
    return false;
  }
}

function startRename() {
  const path = editor.currentPath();
  if (!path || titleEl.querySelector("input")) return;
  const old = titleEl.textContent ?? "";
  const input = document.createElement("input");
  input.value = old;
  titleEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    titleEl.textContent = old;
    if (!commit || !title || title === old) return editor.focus();
    try {
      if (!(await editor.flush())) return editor.focus();
      const n = await api.backlinkCount(old);
      const rewrite = n > 0 && (await ask(`Update ${n} links to the new title?`, { title: "Rename", kind: "info" }));
      const r = await api.renameNote(path, title, rewrite);
      history.rename(path, r.path);
      if (!editor.load(await api.openNote(r.path))) return;
      titleEl.textContent = title;
      errEl.textContent = "";
      history.loaded(r.path, "explicit");
      await runSearch(false);
      void refreshTags();
    } catch (e) {
      errEl.textContent = e === "already-exists" ? "A note with that title exists" : errText(e);
    }
    editor.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") void finish(true);
    else if (e.key === "Escape") void finish(false);
  };
  input.onblur = () => void finish(false);
}

q.addEventListener("input", () => void runSearch(true));
q.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void enter(e.shiftKey); // Shift+Enter: create a note titled as typed even when other notes match
  }
});
titleEl.addEventListener("dblclick", startRename);

$("lock").onclick = () => void toggleLock();
$("lockall").onclick = () => void lockEverything();
$("trash").onclick = () => void deleteNote();
$("gear").onclick = () => void openSettings();
sortBtn.onclick = () => void toggleSort();
tagBtn.onclick = () => showTags(tagPanel.hidden === true);
filterLine.querySelector("button")!.onclick = () => setTags([]);

/** Step through history. Does not record a visit; a refused load puts the cursor back, a vanished file is dropped and skipped. */
async function navigate(dir: "back" | "forward") {
  for (let tries = 0; tries < 1000; tries++) { // each miss removes an entry, so this ends well before the cap
    const target = history[dir](() => true);
    if (!target) return;
    const r = await show(target, "nav");
    if (r === true) return selectOpen();
    history.undo();
    if (r === false) return;
    history.remove(target);
  }
}
const goBack = () => void navigate("back");
const goForward = () => void navigate("forward");

async function step(d: 1 | -1) {
  try {
    await results.ensure(sel + d); // may page in more rows past the loaded end
  } catch (e) {
    console.error("load more failed", e);
  }
  list.update();
  await select(moveSelection(sel, d, results.count));
}
const ACTIONS: Record<Exclude<Action, "toggle_window">, () => void> = {
  focus_search: focusSearch,
  next_note: () => void step(1),
  prev_note: () => void step(-1),
  toggle_preview: () => preview.toggle(),
  rename: startRename,
  toggle_lock: () => void toggleLock(),
  lock_all: () => void lockEverything(),
  settings: () => void openSettings(),
  toggle_sort: () => void toggleSort(),
  back: goBack,
  forward: goForward,
  delete_note: () => void deleteNote(),
  toggle_tags: () => showTags(tagPanel.hidden === true),
};
let keys = resolve(undefined, isMac); // refreshed from settings at startup and after save

// One capture-phase handler: runs before CodeMirror's keymap and the webview defaults (so e.g. ⌘R works from the editor).
window.addEventListener(
  "keydown",
  (e) => {
    const t = e.target as HTMLElement;
    if (document.querySelector("dialog[open]") || t.closest?.("#title")) return; // dialogs and the rename field own their keys
    if (isMenuKey(e) && !t.closest?.("#editor") && sel >= 0) {
      e.preventDefault();
      void openContextMenu(sel, true);
      return;
    }
    const arrow = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (arrow && !t.closest?.("#editor")) {
      e.preventDefault();
      void step(arrow);
      return;
    }
    for (const [action, run] of Object.entries(ACTIONS)) {
      if (!matches(e, keys[action as Action], isMac)) continue;
      // Backspace combos keep their editing meaning in the editor and in a non-empty search box
      if (keys[action as Action].endsWith("+Backspace") && (t.closest?.("#editor") || (t === q && q.value))) continue;
      e.preventDefault();
      e.stopPropagation();
      run();
      return;
    }
  },
  true,
);

$("choose").onclick = async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  await api.setSettings({ ...(await api.getSettings()), notes_dir: dir });
  $("setup").hidden = true;
  await runSearch(true);
  void refreshTitles();
};

void listen<{ paths: string[] }>("notes-changed", async (ev) => {
  await runSearch(false);
  void refreshTitles();
  void refreshTags();
  const open = editor.currentPath();
  if (open && ev.payload.paths.includes(open)) editor.onExternalChange(open);
});
void listen("focus-search", focusSearch);
void listen<{ done: number; total: number }>("index-progress", (ev) => setIndexing(true, ev.payload.done, ev.payload.total));
void listen("index-done", async () => {
  setIndexing(false);
  $("setup").hidden = true;
  // Also fires after a passphrase reopen: keep the open note selected instead of jumping to row 0.
  await runSearch(editor.currentPath() === null);
  void refreshTitles();
  void refreshTags();
});
void listen<{ message: string }>("index-error", (ev) => {
  setIndexing(false);
  errEl.textContent = ev.payload.message;
  void runSearch(false); // no vault -> shows the setup screen
});

window.addEventListener("blur", () => void editor.flush());
void getCurrentWindow().onCloseRequested(async (e) => {
  const ok = await shouldClose({
    flush: () => editor.flush(),
    ask: (msg) => ask(msg, { title: "Unsaved edits", kind: "warning" }),
    lastError: () => errEl.textContent ?? "",
  });
  if (!ok) e.preventDefault();
});

void (async () => {
  const s = await api.getSettings();
  const st = await api.indexStatus();
  if (st) setIndexing(true, st[0], st[1]);
  applyLook(s);
  list.setRowH(rowHeight());
  keys = resolve(s.shortcuts, isMac);
  sort = s.sort ?? "modified"; // before the first search, which pages with it
  syncSort();
  if (!s.notes_dir) $("setup").hidden = false;
  else if (!st) {
    await runSearch(true);
    void refreshTitles();
    void refreshTags();
  }
  focusSearch();
})();
