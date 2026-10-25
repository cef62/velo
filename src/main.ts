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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = $<HTMLInputElement>("q");
const list = $<HTMLUListElement>("list");
const titleEl = $<HTMLSpanElement>("title");
const errEl = $<HTMLSpanElement>("err");

const isMac = navigator.platform.startsWith("Mac");
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

let hits: Hit[] = [];
let sel = -1;
let searchSeq = 0;

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
async function show(path: string): Promise<boolean> {
  const current = newShow();
  try {
    if (!(await editor.flush())) return false;
    const doc = await api.openNote(path);
    if (!current()) return true;
    if (!editor.load(doc)) return false;
    titleEl.textContent = doc.title;
    errEl.textContent = "";
  } catch (e) {
    errEl.textContent = e === "locked" ? "Note is locked" : String(e);
  }
  return true;
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
    const r = await api.search(q.value);
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
    else console.error("search failed", e);
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
    errEl.textContent = String(e);
  }
}

/** Open the note titled `title`, creating it if missing; same flush-then-load path as everywhere. */
async function openTitle(title: string): Promise<boolean> {
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
    errEl.textContent = String(e);
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
      errEl.textContent = e === "already-exists" ? "A note with that title exists" : String(e);
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
  if (!s.notes_dir) $("setup").hidden = false;
  else {
    await runSearch(true);
    void refreshTitles();
  }
  $("app").classList.add(s.layout); // read once; Task 11 toggles the class live
  focusSearch();
})();
