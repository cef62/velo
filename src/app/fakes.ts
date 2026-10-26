// Test fakes for the controller: in-memory backend, editor, preview and UI port. Tests only.
import { vi } from "vitest";
import type { Hit, NoteDoc, Page, Settings } from "../api";
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
export const hit = (title: string): Hit => ({ path: `/n/${title}.md`, title, snippet: "", mtime: 0, encrypted: false });

/** Backend over `notes` (title → text). search ignores the query and pages all notes in insertion order. */
export function fakeApi(notes: Record<string, string> = {}) {
  const docOf = (path: string): NoteDoc => {
    const title = path.slice(3, -3);
    if (!(title in notes)) throw "not-found";
    return { path, title, text: notes[title], hash: "h", encrypted: false };
  };
  const settings: Settings = { notes_dir: "/n", layout: "vertical", font_size: 14, sort: "modified", editor_style: "rich", theme: "system", shortcuts: {} };
  const api = {
    getSettings: vi.fn(async () => ({ ...settings })),
    setSettings: vi.fn(async (_s: Settings) => {}),
    indexStatus: vi.fn(async (): Promise<[number, number] | null> => null),
    search: vi.fn(async (_q: string, _sort: string, offset: number, _tags: string[]): Promise<Page> => {
      const all = Object.keys(notes).map(hit);
      return { hits: all.slice(offset, offset + PAGE), has_more: offset + PAGE < all.length, total: offset === 0 ? all.length : 0 };
    }),
    listTags: vi.fn(async () => []),
    listTitles: vi.fn(async () => Object.keys(notes)),
    openNote: vi.fn(async (path: string) => docOf(path)),
    openOrCreate: vi.fn(async (title: string) => {
      notes[title] ??= "";
      return docOf(`/n/${title}.md`);
    }),
    saveNote: vi.fn(),
    renameNote: vi.fn(),
    backlinkCount: vi.fn(async () => 0),
    lockNote: vi.fn(),
    unlockNote: vi.fn(),
    lockAll: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
    hasIdentity: vi.fn(async () => true),
    setupPassphrase: vi.fn(async () => null),
    identityFileExists: vi.fn(async () => true),
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
  refreshLinks = vi.fn();
  toggleTask = vi.fn(() => false);
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
  const rec = <A extends unknown[], R>(name: string, ret: (...a: A) => R) => (...a: A) => (calls.push([name, ...a]), ret(...a));
  const ui: UiPort = {
    focusSearch: rec("focusSearch", () => {}),
    confirm: rec("confirm", async () => answers.confirm),
    passphrase: rec("passphrase", async () => answers.passphrase),
    chooseDirectory: rec("chooseDirectory", async () => answers.directory),
    openUrl: rec("openUrl", async () => {}),
    reveal: rec("reveal", async () => {}),
    copyText: rec("copyText", async () => {}),
    popupMenu: rec("popupMenu", async () => {}),
    rowAnchor: rec("rowAnchor", () => null),
    setWindowTheme: rec("setWindowTheme", () => {}),
    applyLook: rec("applyLook", () => {}),
  };
  return { ui, calls, answers };
}
