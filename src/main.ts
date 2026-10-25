import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Hit } from "./api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mountEditor } from "./editor";
import { shouldClose } from "./close";
import { latest } from "./latest";
import { enterAction, fold, moveSelection } from "./search";
import { mountPreview } from "./preview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { askPassphrase, isLockedPath } from "./passphrase";
import { applyLook, toSettings } from "./settingsform";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = $<HTMLInputElement>("q");
const list = $<HTMLUListElement>("list");
const titleEl = $<HTMLSpanElement>("title");
const errEl = $<HTMLSpanElement>("err");
const statusEl = $<HTMLSpanElement>("status");

const isMac = navigator.platform.startsWith("Mac");
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

let hits: Hit[] = [];
let sel = -1;
let searchSeq = 0;
let sort: api.Settings["sort"] = "modified"; // mirrors settings.sort (Task 6 owns toggling)

// Set while a lock/unlock hand-off is in flight: the open note's file is moving, so navigation is refused.
let busy = false;
const BUSY_MSG = "Busy locking/unlocking — try again in a moment";
// One-shot notice (e.g. keychain unavailable) that survives the next errEl reset.
let notice = "";
const clearErr = () => {
  errEl.textContent = notice;
  notice = "";
};

let indexing = false;
const STILL_INDEXING = "Still indexing…";
/** Search field and editor are locked while the backend indexes; commands reject with "indexing" meanwhile. */
function setIndexing(on: boolean, done = 0, total = 0) {
  if (on) {
    statusEl.textContent = `Indexing… ${done.toLocaleString()} / ${total.toLocaleString()}`;
    if (!indexing) editor.suspend();
  } else {
    statusEl.textContent = "";
    if (indexing) editor.resume();
  }
  indexing = on;
  q.disabled = on;
}
/** Error text for the UI; the "indexing" rejection is not an error. */
const errText = (e: unknown) => (e === "indexing" ? STILL_INDEXING : String(e));

let titles = new Set<string>(); // folded titles of all notes, for wikilink existence
const newShow = latest();
const editor = mountEditor($("editor"), {
  onEscape: focusSearch,
  onError: (m) => (errEl.textContent = m ?? ""),
  onChange: () => preview.refresh(),
});
const preview = mountPreview($("preview"), {
  getText: () => editor.getText(),
  exists: (t) => titles.has(fold(t)),
  onWikilink: (t) => void openTitle(t),
  openExternal: (u) => void openUrl(u).catch((e) => (errEl.textContent = String(e))),
  onToggle: (on) => $("app").classList.toggle("preview-on", on),
});

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

function ago(ms: number): string {
  const m = (Date.now() - ms) / 60000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 43200) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 43200)}mo`;
}

function render() {
  list.replaceChildren(
    ...hits.map((h, i) => {
      const li = document.createElement("li");
      li.className = i === sel ? "sel" : "";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = (h.encrypted ? "🔒 " : "") + h.title;
      const m = document.createElement("span");
      m.className = "m";
      m.textContent = ago(h.mtime);
      const s = document.createElement("div");
      s.className = "s";
      s.textContent = h.snippet;
      li.append(t, m, s);
      li.onclick = () => select(i);
      return li;
    }),
  );
  list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

/** false = refused: unsaved edits could not be saved (error stays visible), nothing changed. */
async function show(path: string, retried = false): Promise<boolean> {
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
  } catch (e) {
    if (e === "locked" && !retried && (await promptPassphrase())) return show(path, true);
    errEl.textContent = e === "locked" ? "Note is locked" : errText(e);
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
    if (editor.rebind(path, doc)) {
      editor.resume();
      titleEl.textContent = doc.title;
      clearErr();
    }
    await runSearch(false);
    sel = hits.findIndex((h) => h.path === editor.currentPath());
    render();
  } catch (e) {
    // The file moved but could not be reopened: stay read-only (never resume on the old path).
    errEl.textContent = `Note moved but could not be reopened (${e}); pick it from the list`;
    void runSearch(false);
  }
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
  field("s-hotkey").value = cur.shortcuts.toggle_window ?? "Mod+Shift+Space";
  field("s-layout").value = cur.layout;
  field("s-font").value = String(cur.font_size);
  msg.textContent = "";
  $("s-choose").onclick = async () => {
    const d = await open({ directory: true });
    if (typeof d === "string") $("s-dir").textContent = dir = d;
  };
  (form.querySelector("[value=cancel]") as HTMLButtonElement).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const next = { ...toSettings(cur, { hotkey: field("s-hotkey").value, layout: field("s-layout").value, fontSize: field("s-font").value }), notes_dir: dir };
    try {
      await api.setSettings(next); // on hotkey registration failure this throws and the old hotkey stays
    } catch (err) {
      msg.textContent = String(err);
      return;
    }
    applyLook(next);
    sort = next.sort ?? "modified";
    dlg.close();
    if (next.notes_dir !== cur.notes_dir) {
      $("setup").hidden = true;
      await runSearch(true);
      void refreshTitles();
    }
  };
  dlg.showModal();
}

async function select(i: number) {
  sel = i;
  render();
  if (hits[i] && !(await show(hits[i].path))) {
    sel = hits.findIndex((h) => h.path === editor.currentPath());
    render();
  }
}

async function runSearch(selectFirst: boolean) {
  const seq = ++searchSeq;
  try {
    const r = (await api.search(q.value, sort, 0)).hits;
    if (seq !== searchSeq) return;
    const keep = hits[sel]?.path;
    hits = r;
    if (selectFirst) select(r.length ? 0 : -1);
    else {
      sel = Math.max(0, r.findIndex((h) => h.path === keep));
      if (!r.length) sel = -1;
      render();
    }
  } catch (e) {
    if (e === "no-folder") $("setup").hidden = false;
    else if (e !== "indexing") console.error("search failed", e);
  }
}

async function enter() {
  const a = enterAction(q.value, hits);
  if (!a) return;
  try {
    if (a.kind === "open") {
      if (!(await show(a.path))) return;
    } else if (!(await openTitle(a.title))) return;
    editor.focus();
  } catch (e) {
    errEl.textContent = errText(e);
  }
}

/** Open the note titled `title`, creating it if missing; same flush-then-load path as everywhere. */
async function openTitle(title: string): Promise<boolean> {
  if (busy) {
    errEl.textContent = BUSY_MSG;
    return false;
  }
  try {
    if (!(await editor.flush())) return false;
    const doc = await api.openOrCreate(title);
    if (!editor.load(doc)) return false;
    titleEl.textContent = doc.title;
    errEl.textContent = "";
    await runSearch(false);
    void refreshTitles();
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
      if (!editor.load(await api.openNote(r.path))) return;
      titleEl.textContent = title;
      errEl.textContent = "";
      await runSearch(false);
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
    void enter();
  }
});
titleEl.addEventListener("dblclick", startRename);

// Capture phase so CodeMirror's keymap (e.g. ⌘⇧L, ⌘,) never sees these.
window.addEventListener(
  "keydown",
  (e) => {
    if (!mod(e) || document.querySelector("dialog[open]")) return;
    const k = e.key.toLowerCase();
    const act = e.shiftKey && k === "e" ? toggleLock : e.shiftKey && k === "l" ? lockEverything : !e.shiftKey && k === "," ? openSettings : null;
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    void act();
  },
  true,
);
$("lock").onclick = () => void toggleLock();
$("lockall").onclick = () => void lockEverything();
$("gear").onclick = () => void openSettings();

window.addEventListener("keydown", (e) => {
  const inEditor = !!(e.target as HTMLElement).closest?.("#editor");
  const down = e.key === "ArrowDown" || (mod(e) && e.key === "j");
  const up = e.key === "ArrowUp" || (mod(e) && e.key === "k");
  if ((down || up) && !(inEditor && !mod(e))) {
    e.preventDefault();
    select(moveSelection(sel, down ? 1 : -1, hits.length));
  } else if (mod(e) && e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    preview.toggle();
  } else if (mod(e) && e.key === "l") {
    e.preventDefault();
    focusSearch();
  } else if (mod(e) && e.key === "r") {
    e.preventDefault();
    startRename();
  }
});

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
  const open = editor.currentPath();
  if (open && ev.payload.paths.includes(open)) editor.onExternalChange(open);
});
void listen("focus-search", focusSearch);
void listen<{ done: number; total: number }>("index-progress", (ev) => setIndexing(true, ev.payload.done, ev.payload.total));
void listen("index-done", async () => {
  setIndexing(false);
  $("setup").hidden = true;
  await runSearch(true);
  void refreshTitles();
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
  if (!s.notes_dir) $("setup").hidden = false;
  else if (!st) {
    await runSearch(true);
    void refreshTitles();
  }
  applyLook(s);
  sort = s.sort ?? "modified";
  focusSearch();
})();
