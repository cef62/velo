import type * as ApiModule from "../api";
import type { Hit, NoteDoc, Settings } from "../api";
// Types only: editor.ts loads editortheme.ts, which touches `window` at import time (tests run in node).
import type { Editor, EditorOpts } from "../editor";
import type { Preview } from "../preview";
import type { RichOpts } from "../richmd";
import { afterOpen, shouldAutoEdit } from "../preview";
import { Results } from "../list";
import { shouldClose } from "../close";
import { latest } from "../latest";
import { History } from "../history";
import { errText } from "../errtext";
import { enterAction, fold, moveSelection } from "../search";
import { toggleTag } from "../tags";
import { formatBinding, resolve } from "../shortcuts";
import type { UiPort } from "./ports";
import type { AppState, Store } from "./store";

export type Api = typeof ApiModule;

const BUSY_MSG = "Busy — try again in a moment";

/** main.ts without the DOM: same sequencing and guards; state goes to the store, UI effects to the UiPort. */
export class Controller {
  // Attached by the editor/preview hosts once mounted.
  protected editor!: Editor;
  protected preview!: Preview;
  protected readonly results: Results;
  protected readonly history = new History();
  // Set while a lock/unlock hand-off is in flight: the open note's file is moving, so navigation is refused.
  busy = false;
  // One-shot notice (e.g. keychain unavailable) that survives the next err reset.
  protected notice = "";
  protected titles = new Set<string>(); // folded titles of all notes, for wikilink existence
  protected readonly newShow = latest();
  protected searchSeq = 0;
  protected searching: Promise<void> = Promise.resolve(); // latest list reset, awaited by Enter so it never acts on stale rows

  // Wikilinks, tags and links act the same in the preview and in rich edit.
  readonly links: RichOpts = {
    exists: (t) => this.titles.has(fold(t)),
    onWikilink: (t) => void this.openTitle(t, "wikilink"),
    onTag: (t) => {
      this.showTags(true);
      const sel = this.store.get().selectedTags;
      if (!sel.some((s) => fold(s) === fold(t))) this.setTags(toggleTag(sel, t));
    },
    openExternal: (u) => void this.ui.openUrl(u).catch((e) => this.setErr(String(e))),
  };

  constructor(
    readonly store: Store<AppState>,
    protected readonly api: Api,
    protected readonly ui: UiPort,
    protected readonly opts: { isMac: boolean; platform: "mac" | "windows" | "linux" },
  ) {
    this.results = new Results((offset) => {
      const s = store.get();
      return api.search(s.query, s.sort, offset, s.selectedTags);
    });
  }

  /** What mountEditor takes: the editor's callbacks routed into the controller. */
  editorOpts(): Required<EditorOpts> {
    return {
      rich: this.links,
      onEscape: () => this.focusSearch(),
      onError: (m) => this.store.set({ err: m ? errText(m) : "", errFromSave: !!m }),
      onChange: () => this.preview?.refresh(), // also fires on load, maybe before the preview is attached
      onEdit: () => this.history.edited(this.editor.currentPath()),
      onSaved: () => this.scheduleTagRefresh(),
      onConflict: (p) => this.store.set({ conflict: p }),
      onSaving: (on) => this.store.set({ saving: on }),
    };
  }

  /** What mountPreview takes (besides its element). */
  previewOpts() {
    return {
      getText: () => this.editor.getText(),
      toggleLabel: () => formatBinding(this.store.get().keys.toggle_preview, this.opts.isMac),
      ...this.links,
      onToggleTask: (line: number) => void this.editor.toggleTask(line),
      onToggle: (on: boolean) => this.store.set({ previewOn: on }),
    };
  }

  /** A (re)mounted editor gets the current style and indexing read-only state. */
  attachEditor(ed: Editor) {
    this.editor = ed;
    const s = this.store.get();
    ed.setRich(s.editorStyle === "rich");
    ed.setReadOnly(s.indexing !== null);
  }

  attachPreview(p: Preview) {
    this.preview = p;
  }

  row(i: number): Hit | undefined {
    return this.results.get(i);
  }

  protected setErr(msg: string) {
    this.store.set({ err: msg, errFromSave: false });
  }

  protected clearErr() {
    this.setErr(this.notice);
    this.notice = "";
  }

  /** Rows changed (reset/refresh/page loaded): publish them so the list re-renders. */
  protected listChanged() {
    const r = this.results;
    const q = fold(this.store.get().query.trim()); // trimmed like enterAction, so the Create hint matches what Enter does
    this.store.set((s) => ({
      listVersion: s.listVersion + 1,
      count: r.count,
      hasMore: r.hasMore,
      total: r.total,
      exactTitleMatch: q !== "" && r.loaded.some((h) => fold(h.title) === q),
    }));
  }

  /** Search field and editor are read-only while the backend indexes; commands reject with "indexing" meanwhile. */
  protected setIndexing(on: boolean, done = 0, total = 0) {
    this.store.set({ indexing: on ? { done, total } : null });
    // Not editor.suspend(): the saver stays live, so a flush still tries, fails with "indexing" and stays dirty (close asks).
    this.editor?.setReadOnly(on);
  }

  /** Layout, font and theme; the native window (title bar, menus, dialogs) follows the theme too. */
  protected applyLook(s: Settings) {
    this.store.set({ theme: s.theme ?? "system", fontSize: s.font_size, layout: s.layout });
    this.ui.applyLook({ theme: s.theme ?? "system", fontSize: s.font_size, layout: s.layout });
    this.ui.setWindowTheme(s.theme === "light" || s.theme === "dark" ? s.theme : null);
  }

  protected syncStyle() {
    this.editor?.setRich(this.store.get().editorStyle === "rich");
  }

  async start() {
    const s = await this.api.getSettings();
    const st = await this.api.indexStatus();
    if (st) this.setIndexing(true, st[0], st[1]);
    this.applyLook(s);
    this.store.set({
      keys: resolve(s.shortcuts, this.opts.isMac),
      sort: s.sort ?? "modified", // before the first search, which pages with it
      editorStyle: s.editor_style === "plain" ? "plain" : "rich",
    });
    this.syncStyle();
    if (!s.notes_dir) this.store.set({ phase: "setup" });
    else {
      this.store.set({ phase: "ready" });
      if (!st) {
        await this.runSearch(true);
        void this.refreshTitles();
        void this.refreshTags();
      }
    }
    this.focusSearch();
  }

  async refreshTitles() {
    try {
      this.titles = new Set((await this.api.listTitles()).map(fold));
      this.preview?.refresh();
      this.editor?.refreshLinks();
    } catch (e) {
      console.error("title cache refresh failed", e);
    }
  }

  focusSearch() {
    this.ui.focusSearch();
  }

  setListActive(on: boolean) {
    this.store.set({ listActive: on });
  }

  /** The search text changed: fresh first page. */
  setQuery(q: string) {
    this.store.set({ query: q });
    void this.runSearch(true);
  }

  /** The note is now in the editor: title, path and lock state follow it; the conflict banner belongs to the previous note. */
  protected loadedDoc(doc: NoteDoc) {
    this.store.set({ title: doc.title, openPath: doc.path, encrypted: doc.encrypted, conflict: null });
  }

  /**
   * false = refused: unsaved edits could not be saved (error stays visible), nothing changed.
   * "missing" (only when `nav`, i.e. a history step, which does not record a visit) = the file is gone; no error shown.
   */
  async show(path: string, how: "explicit" | "auto" | "nav" = "explicit", retried = false): Promise<boolean | "missing"> {
    if (this.busy) {
      this.setErr(BUSY_MSG);
      return false;
    }
    const current = this.newShow();
    try {
      if (!(await this.editor.flush())) return false;
      const doc = await this.api.openNote(path);
      if (!current()) return true;
      if (!this.editor.load(doc)) return false;
      this.loadedDoc(doc);
      this.clearErr();
      if (shouldAutoEdit({ created: false, body: doc.text, previewOn: this.preview.isOn() })) this.preview.setMode(false);
      this.history.loaded(doc.path, how);
    } catch (e) {
      if (how === "nav" && e === "not-found") return "missing";
      if (e === "locked" && !retried && (await this.promptPassphrase(null))) return this.show(path, how, true);
      this.setErr(e === "locked" ? "Note is locked" : errText(e));
      if (how === "nav") return false; // history cursor must be restored
    }
    return true;
  }

  /** Passphrase dialog; true once the identity is available. Wording depends on identity.age existing. */
  protected async promptPassphrase(context: string | null): Promise<boolean> {
    try {
      const exists = await this.api.identityFileExists();
      return await this.ui.passphrase({
        mode: exists ? "unlock" : "create",
        context,
        submit: async (pw) => {
          if ((await this.api.setupPassphrase(pw)) === "keychain-unavailable") {
            this.notice = "Keychain unavailable — you'll be asked for your passphrase each launch";
            this.setErr(this.notice);
          }
        },
      });
    } catch (e) {
      this.setErr(errText(e));
      return false;
    }
  }

  /** Select the open note's row (none if it is not loaded). */
  protected selectOpen() {
    this.store.set({ sel: this.results.indexOf(this.editor.currentPath() ?? "") });
  }

  /** false = the switch was refused (unsaved edits / busy). */
  async select(i: number, how: "explicit" | "auto" = "explicit"): Promise<boolean> {
    this.store.set({ sel: i });
    const h = this.results.get(i);
    if (h && !(await this.show(h.path, how))) {
      this.selectOpen(); // refused: snap back to the open note
      return false;
    }
    return true;
  }

  /** true = fresh first page (new query/folder/sort), selecting its first row; false = reload the loaded range in place. */
  runSearch(selectFirst: boolean, keepOpen: boolean | "highlight" = false): Promise<void> {
    const p = this.doSearch(selectFirst, keepOpen);
    if (selectFirst) this.searching = p;
    return p;
  }

  /** keepOpen: after a reset, stay on the open note when it is in the new first page instead of opening row 0. "highlight": and with no note open, highlight row 0 without opening it. */
  protected async doSearch(selectFirst: boolean, keepOpen: boolean | "highlight") {
    const seq = ++this.searchSeq;
    const r = this.results;
    try {
      await (selectFirst ? r.reset() : r.refresh());
      if (seq !== this.searchSeq) return;
      this.listChanged();
      if (selectFirst) {
        if (keepOpen && r.indexOf(this.editor.currentPath() ?? "") >= 0) this.selectOpen();
        else if (keepOpen === "highlight" && this.editor.currentPath() === null) {
          this.store.set({ sel: r.count ? 0 : -1 }); // nothing open: highlight row 0, don't open it
        } else void this.select(r.count ? 0 : -1, "auto");
      } else this.selectOpen();
    } catch (e) {
      if (e === "no-folder") this.store.set({ phase: "setup" });
      else if (e !== "indexing") console.error("search failed", e);
    }
  }

  /** Sort changed: fresh first page from the top, keeping the open note selected if it is loaded. */
  protected async resort() {
    const seq = ++this.searchSeq;
    try {
      await this.results.reset();
      if (seq !== this.searchSeq) return;
      this.listChanged();
      this.selectOpen();
    } catch (e) {
      if (e !== "indexing") console.error("search failed", e);
    }
  }

  /** Load pages until row `index` exists (the list scrolled near its end). */
  async ensureRows(index: number) {
    const had = this.results.count;
    try {
      await this.results.ensure(index);
    } catch (e) {
      console.error("load more failed", e);
      return;
    }
    if (this.results.count !== had) this.listChanged();
  }

  /** Leave preview / focus the editor as afterOpen decides, for the note that is now open. */
  protected settleAfterOpen(created: boolean, source: "enter" | "wikilink") {
    const r = afterOpen({
      created,
      body: this.editor.getText(),
      layout: this.store.get().layout,
      previewOn: this.preview.isOn(),
      source,
    });
    if (r.leavePreview) this.preview.setMode(false);
    if (r.focusEditor) this.editor.focus();
  }

  async enter(force = false) {
    await this.searching;
    const a = enterAction(this.store.get().query, this.results.loaded, this.results.get(this.store.get().sel), force);
    if (!a) return;
    try {
      if (a.kind === "open") {
        // show() reports true even when it swallowed an open error; only settle if the note really loaded
        if (!(await this.show(a.path)) || this.editor.currentPath() !== a.path) return;
        this.settleAfterOpen(false, "enter");
      } else await this.openTitle(a.title, "enter");
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  /** Open the note titled `title`, creating it if missing; same flush-then-load path as everywhere. */
  async openTitle(title: string, source: "enter" | "wikilink"): Promise<boolean> {
    if (this.busy) {
      this.setErr(BUSY_MSG);
      return false;
    }
    try {
      if (!(await this.editor.flush())) return false;
      // The title cache is the "existed before" signal (open_or_create returns a plain NoteDoc). A stale cache only
      // mislabels an empty/external note, which the empty-body rule below still opens in edit mode.
      const created = !this.titles.has(fold(title));
      const doc = await this.api.openOrCreate(title);
      if (!this.editor.load(doc)) return false;
      this.loadedDoc(doc);
      this.setErr("");
      this.history.loaded(doc.path, "explicit");
      if (created) {
        this.store.set({ query: doc.title }); // list the new note, selected (resort keeps the open note selected)
        await this.resort();
      } else await this.runSearch(false);
      void this.refreshTitles();
      if (this.editor.currentPath() === doc.path) this.settleAfterOpen(created, source);
      return true;
    } catch (e) {
      this.setErr(errText(e));
      return false;
    }
  }

  /** Step through history. Does not record a visit; a refused load puts the cursor back, a vanished file is dropped and skipped. */
  async navigate(dir: "back" | "forward") {
    for (let tries = 0; tries < 1000; tries++) { // each miss removes an entry, so this ends well before the cap
      const target = this.history[dir](() => true);
      if (!target) return;
      const r = await this.show(target, "nav");
      if (r === true) return this.selectOpen();
      this.history.undo();
      if (r === false) return;
      this.history.remove(target);
    }
  }

  /** Arrow keys: move the selection, opening the row without recording a visit. */
  async step(d: 1 | -1) {
    try {
      await this.results.ensure(this.store.get().sel + d); // may page in more rows past the loaded end
    } catch (e) {
      console.error("load more failed", e);
    }
    this.listChanged();
    await this.select(moveSelection(this.store.get().sel, d, this.results.count), "auto");
  }

  /** Window blur: save now. */
  onBlur() {
    void this.editor.flush();
  }

  /** The window wants to close: true when clean, or after the user confirms discarding. */
  requestClose(): Promise<boolean> {
    return shouldClose({
      flush: () => this.editor.flush(),
      ask: (msg) => this.ui.confirm(msg, { title: "Unsaved edits", kind: "warning" }),
      lastError: () => this.store.get().err,
    });
  }

  // Tags arrive in Task 7; the call sites above are final.
  protected scheduleTagRefresh() {}
  protected async refreshTags(_inPlace = false) {}
  protected showTags(_on: boolean) {}
  protected setTags(_next: string[]) {}
}
