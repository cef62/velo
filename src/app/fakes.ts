// Test fakes for the controller: in-memory backend, editor, preview and UI port. Tests only.
import { vi } from "vitest";
import type { Connections, ExportCounts, ExportRequest, Hit, MergeResult, NoteDoc, NoteMeta, Page, RenameResult, RevisionInfo, Settings, TagCount, TaskView, TimelineRow } from "../api";
import type { Editor } from "../editor";
import type { Preview } from "../preview";
import type { Api } from "./controller";
import type { UiPort } from "./ports";

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** Let pending promise chains run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));

export const PAGE = 2;
export const noMeta: NoteMeta = { created: 0, created_src: "file", modified: 0, modified_src: "file", tags: [], aliases: [] };
export const hit = (title: string): Hit => ({ path: `/n/${title}.md`, title, snippet: "", mtime: 0, encrypted: false });

export const emptyConnections: Connections = { centre: { path: "", title: "", created: 0, modified: 0, preview: "", locked: false }, links_out: [], links_in: [], tags: [], mentions: [] };

/** Backend over `notes` (title → text). search ignores the query and pages all notes in insertion order. */
export function fakeApi(notes: Record<string, string> = {}) {
  const docOf = (path: string): NoteDoc => {
    const title = path.slice(3, -3);
    if (!(title in notes)) throw "not-found";
    return { path, title, text: notes[title], hash: "h", encrypted: false, meta: noMeta };
  };
  const settings: Settings = { notes_dir: "/n", layout: "vertical", font_size: 14, sort: "modified", editor_style: "rich", theme: "system", header_labels: false, shortcuts: {}, write_front_matter: true, show_front_matter: false, info_panel: false, auto_update_check: true, capture_target: "inbox", inbox_title: "Inbox", agent_access: false, connections_sort: "ring", saved_searches: [], timeline_sort: "updated" };
  const api = {
    getSettings: vi.fn(async () => ({ ...settings })),
    setSettings: vi.fn(async (_s: Settings) => {}),
    indexStatus: vi.fn(async (): Promise<[number, number] | null> => null),
    search: vi.fn(async (_q: string, _sort: string, offset: number, _tags: string[], _noLinks: boolean): Promise<Page> => {
      const all = Object.keys(notes).map(hit);
      return { hits: all.slice(offset, offset + PAGE), has_more: offset + PAGE < all.length, total: offset === 0 ? all.length : 0 };
    }),
    listTags: vi.fn(async (): Promise<TagCount[]> => []),
    listTitles: vi.fn(async () => Object.keys(notes)),
    listLinkTargets: vi.fn(async () => Object.keys(notes).map((title) => ({ name: title, title, path: `/n/${title}.md`, modified: 0, locked: false }))),
    createFromSelection: vi.fn(async (title: string, text: string) => {
      if (title in notes) throw "already-exists";
      notes[title] = text;
      return `/n/${title}.md`;
    }),
    openNote: vi.fn(async (path: string) => docOf(path)),
    openOrCreate: vi.fn(async (title: string) => {
      const created = !(title in notes);
      notes[title] ??= "";
      return { ...docOf(`/n/${title}.md`), created };
    }),
    saveNote: vi.fn(),
    tasks: vi.fn(async (_q: string, _t: string[], _d: boolean): Promise<TaskView> => ({ overdue: [], today: [], upcoming: [], no_date: [], done: [], due_count: 0 })),
    timeline: vi.fn(async (_q: string, _t: string[], _n: boolean, _by: "created" | "updated", _since: number | null): Promise<TimelineRow[]> => []),
    exportPreview: vi.fn(async (_r: ExportRequest): Promise<ExportCounts> => ({ notes: 0, open: 0, done: 0, locked: 0, over_limit: 0, no_tasks: 0, unreadable: 0 })),
    exportText: vi.fn(async (_r: ExportRequest): Promise<string> => ""),
    printPage: vi.fn(async () => {}),
    exportMarkdown: vi.fn(async (_p: string, _r: ExportRequest): Promise<ExportCounts> => ({ notes: 0, open: 0, done: 0, locked: 0, over_limit: 0, no_tasks: 0, unreadable: 0 })),
    toggleTask: vi.fn(async (_p: string, line: number, line_text: string) => ({ line, line_text })),
    captureTask: vi.fn(async (_t: string) => "/n/Inbox.md"),
    captureTargetTitle: vi.fn(async (): Promise<{ title: string; path: string | null }> => ({ title: "Inbox", path: "Inbox" in notes ? "/n/Inbox.md" : null })),
    captureDone: vi.fn(async (_hide: boolean) => {}),
    setBadge: vi.fn(async (_c: number) => {}),
    renameNote: vi.fn(async (_p: string, _t: string, _r: boolean): Promise<RenameResult> => { throw "unset"; }),
    mergeNotes: vi.fn(async (_s: string, _t: string): Promise<MergeResult> => { throw "unset"; }),
    backlinkCount: vi.fn(async () => 0),
    linkedFromCount: vi.fn(async (_p: string) => 0),
    connections: vi.fn(async (path: string): Promise<Connections> => ({ ...emptyConnections, centre: { ...emptyConnections.centre, path, title: path.slice(3, -3) } })),
    linkMention: vi.fn(async (_p: string, _t: string, _n: number, _e: string | null): Promise<string | null> => null),
    lockNote: vi.fn(async (_p: string): Promise<string> => { throw "unset"; }),
    unlockNote: vi.fn(async (_p: string): Promise<string> => { throw "unset"; }),
    lockAll: vi.fn(async () => {}),
    deleteNote: vi.fn(async (path: string) => void delete notes[path.slice(3, -3)]),
    hasIdentity: vi.fn(async () => true),
    setupPassphrase: vi.fn(async () => null),
    identityFileExists: vi.fn(async () => true),
    snapshotText: vi.fn(async (_p: string, _t: string) => {}),
    snapshotAgent: vi.fn(async (_p: string, _s: string): Promise<string | null> => "1.md"),
    dropAgentSnapshot: vi.fn(async (_p: string, _id: string) => {}),
    agentWriteDone: vi.fn(async (_id: number, _r: unknown) => {}),
    agentWriteClaim: vi.fn(async (_id: number) => true),
    listRevisions: vi.fn(async (_p: string): Promise<RevisionInfo[]> => []),
    readRevision: vi.fn(async (_p: string, _id: string): Promise<string> => { throw "unset"; }),
    agentSetupCommand: vi.fn(async () => "claude mcp add velo -- /velo --mcp"),
    checkUpdate: vi.fn(async (): Promise<{ version: string } | null> => null),
    installUpdate: vi.fn(async () => {}),
    appVersion: vi.fn(async () => "0.6.0"),
  };
  return { api: api as unknown as Api & typeof api, notes };
}

/** Editor stand-in: `flushResult` decides whether a flush leaves it clean. */
export class FakeEditor implements Editor {
  path: string | null = null;
  text = "";
  dirty = false;
  flushResult = true;
  rich = false;
  showFrontMatter = false;
  readOnly = false;
  suspended = false;
  focused = 0;
  load(doc: NoteDoc) {
    if (this.dirty) return false;
    this.path = doc.path;
    this.text = doc.text;
    return true;
  }
  rebind(fromPath: string, doc: NoteDoc) {
    if (this.path !== fromPath) return false;
    this.path = doc.path;
    return true;
  }
  suspend() { this.suspended = true; }
  resume() { this.suspended = false; }
  setReadOnly(on: boolean) { this.readOnly = on; }
  unload() {
    if (this.dirty) return false;
    this.path = null;
    this.text = "";
    return true;
  }
  discard() {
    this.dirty = false;
    this.path = null;
    this.text = "";
  }
  isDirty = () => this.dirty;
  currentPath = () => this.path;
  onExternalChange = vi.fn();
  flush = vi.fn(async () => this.flushResult);
  focus() { this.focused++; }
  getText = () => this.text;
  setRich(on: boolean) { this.rich = on; }
  setShowFrontMatter(on: boolean) { this.showFrontMatter = on; }
  replaceText(text: string) {
    this.text = text;
    this.dirty = true;
  }
  refreshLinks = vi.fn();
  toggleTask = vi.fn(() => false);
  revealed: number[] = [];
  revealLine(line: number) { this.revealed.push(line); }
  changes: { from: number; to: number; insert: string }[] = [];
  isolated: boolean[] = [];
  applyChange(c: { from: number; to: number; insert: string }, isolate = false) {
    this.isolated.push(isolate);
    if (this.path === null || this.suspended || this.readOnly) return false;
    this.changes.push(c);
    this.text = this.text.slice(0, c.from) + c.insert + this.text.slice(c.to);
    this.dirty = true;
    return true;
  }
  selection: { from: number; to: number } | null = null;
  getSelection() {
    return this.selection && { ...this.selection, text: this.text.slice(this.selection.from, this.selection.to) };
  }
  appended: string[] = [];
  appendLine(text: string) {
    this.appended.push(text);
    if (this.path === null || this.suspended) return false;
    this.text += (this.text === "" || this.text.endsWith("\n") ? "" : "\n") + text;
    return true;
  }
}

export class FakePreview implements Preview {
  on = false;
  toggle() { this.on = !this.on; }
  setMode(on: boolean) { this.on = on; }
  isOn = () => this.on;
  refresh = vi.fn();
}

/** Records every call as [method, ...args]; dialog answers are settable. */
export function fakeUi() {
  const calls: [string, ...unknown[]][] = [];
  const answers = { confirm: true, passphrase: false, directory: null as string | null };
  // popupMenu contract: each open closes the previous menu first, so at most one stays open.
  const menus: { items: unknown[]; closed: boolean }[] = [];
  const rec = <A extends unknown[], R>(name: string, ret: (...a: A) => R) => (...a: A) => (calls.push([name, ...a]), ret(...a));
  const ui: UiPort = {
    focusSearch: rec("focusSearch", () => {}),
    confirm: rec("confirm", async () => answers.confirm),
    passphrase: rec("passphrase", async () => answers.passphrase),
    chooseDirectory: rec("chooseDirectory", async () => answers.directory),
    saveFile: rec("saveFile", async (_name: string): Promise<string | null> => null),
    nextFrame: rec("nextFrame", async () => {}),
    openUrl: rec("openUrl", async () => {}),
    reveal: rec("reveal", async () => {}),
    copyText: rec("copyText", async () => {}),
    popupMenu: rec("popupMenu", async (items) => {
      for (const m of menus) m.closed = true;
      menus.push({ items, closed: false });
    }),
    rowAnchor: rec("rowAnchor", () => null),
    focusAnchor: rec("focusAnchor", () => null),
    setWindowTheme: rec("setWindowTheme", () => {}),
    applyLook: rec("applyLook", () => {}),
  };
  return { ui, calls, answers, menus };
}
