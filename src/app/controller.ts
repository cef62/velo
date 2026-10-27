import type * as ApiModule from "../api";
import type { Hit, NoteDoc, Settings, TagCount } from "../api";
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
import { extractTags, pruneSelection, toggleTag } from "../tags";
import { stripFrontMatter, wordCount } from "../frontmatter";
import { formatBinding, matches, resolve, type Action } from "../shortcuts";
import { isMenuKey, linkFor, menuModel, type MenuAction } from "../contextmenu";
import { isLockedPath } from "../passphrase";
import type { MenuSpec, UiPort } from "./ports";
import { noInfo, type AppState, type Store } from "./store";

export type Api = typeof ApiModule;

const BUSY_MSG = "Busy — try again in a moment";
const NO_KEY_MSG =
  "This note was locked with a velo key that isn't on this computer. Copy `.velo/identity.age` from the other computer into this notes folder.";

/** What the window's capture-phase keydown handler passes in; the flags say where focus is. */
export type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  getModifierState?: (k: string) => boolean; // pass it through so AltGr never fires a Mod+Alt binding off-mac
  inEditor: boolean;
  inSearchWithText: boolean;
  inDialog: boolean; // a dialog or the settings recorder owns the keys
  inRename: boolean;
};

/** The app logic without the DOM: same sequencing and guards; state goes to the store, UI effects to the UiPort. */
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
      onMeta: (m) => {
        this.store.set((s) => ({ info: { ...s.info, meta: m } }));
        this.textInfo();
        void this.loadInfo();
      },
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
    ed.setShowFrontMatter(s.showFrontMatter);
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
  protected listChanged(reset = false) {
    const r = this.results;
    const q = fold(this.store.get().query.trim()); // trimmed like enterAction, so the Create hint matches what Enter does
    this.store.set((s) => ({
      listVersion: s.listVersion + 1,
      listReset: s.listReset + (reset ? 1 : 0),
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
    this.editor?.setShowFrontMatter(this.store.get().showFrontMatter);
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
      headerLabels: s.header_labels === true,
      writeFrontMatter: s.write_front_matter !== false,
      showFrontMatter: s.show_front_matter === true,
      infoOpen: s.info_panel === true,
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
    this.store.set({ title: doc.title, openPath: doc.path, encrypted: doc.encrypted, conflict: null, info: { ...noInfo, meta: doc.meta } });
    this.textInfo();
    void this.loadInfo();
  }

  /** Word count and merged tags from the editor text (on load and save, not per keystroke). */
  protected textInfo() {
    const text = this.editor.getText();
    this.store.set((s) => {
      const seen = new Set<string>();
      const tags = [...(s.info.meta?.tags ?? []), ...extractTags(stripFrontMatter(text))].filter((t) => !seen.has(fold(t)) && seen.add(fold(t)));
      return { info: { ...s.info, words: wordCount(text), tags } };
    });
  }

  protected readonly infoReq = latest();
  /** Backlinks and revisions for the open note; no backend calls while the panel is closed. */
  async loadInfo() {
    const { infoOpen, openPath, title } = this.store.get();
    if (!infoOpen || !openPath) return;
    const fresh = this.infoReq();
    try {
      const [backlinks, revisions] = await Promise.all([this.api.backlinkCount(title), this.api.listRevisions(openPath)]);
      if (fresh() && this.store.get().openPath === openPath) this.store.set((s) => ({ info: { ...s.info, backlinks, revisions } }));
    } catch (e) {
      if (e !== "locked") console.error("info load failed", e);
    }
  }

  async toggleInfo() {
    try {
      const cur = await this.api.getSettings();
      const next = !cur.info_panel;
      await this.api.setSettings({ ...cur, info_panel: next });
      this.store.set({ infoOpen: next });
      void this.loadInfo();
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async selectRevision(id: string) {
    const path = this.store.get().openPath;
    if (!path) return;
    try {
      const text = await this.api.readRevision(path, id);
      if (this.store.get().openPath === path) this.store.set((s) => ({ info: { ...s.info, preview: { id, text } } }));
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  /** The editor holds no note any more (deleted, or locked away by Lock all). */
  protected closedDoc() {
    this.store.set({ title: "", openPath: null, encrypted: false, conflict: null, info: noInfo });
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
      if (e === "locked" && !retried) {
        const ok = await this.promptPassphrase({ trigger: "open", context: null });
        if (ok) return this.show(path, how, true);
        if (ok === null) return how !== "nav"; // no key on this computer: keep the copy-identity error
      }
      this.setErr(e === "locked" ? "Note is locked" : errText(e));
      if (how === "nav") return false; // history cursor must be restored
    }
    return true;
  }

  /**
   * Passphrase dialog; true once the identity is available. Wording depends on identity.age existing.
   * null = opening a locked note with no key anywhere: a new key couldn't decrypt it, so no dialog, just the copy-identity error.
   * context: the note title when locking, for the create dialog's subtitle.
   */
  protected async promptPassphrase(req: { trigger: "open" | "lock"; context: string | null }): Promise<boolean | null> {
    try {
      if (req.trigger === "open" && !(await this.api.hasIdentity()) && !(await this.api.identityFileExists())) {
        this.setErr(NO_KEY_MSG);
        return null;
      }
      const exists = await this.api.identityFileExists();
      return await this.ui.passphrase({
        mode: exists ? "unlock" : "create",
        context: req.context,
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
      this.listChanged(selectFirst);
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
      this.listChanged(true);
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

  /** Arrow keys: move the selection and open the row (recorded in history). */
  async step(d: 1 | -1) {
    try {
      await this.results.ensure(this.store.get().sel + d); // may page in more rows past the loaded end
    } catch (e) {
      console.error("load more failed", e);
    }
    this.listChanged();
    await this.select(moveSelection(this.store.get().sel, d, this.results.count));
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

  /**
   * Lock/unlock the open note. The editor is suspended (read-only, no saves) from after the flush until
   * it is rebound to the new path, so no autosave/blur/watcher save can recreate the old path.
   */
  async toggleLock() {
    if (this.busy) return;
    const path = this.editor.currentPath();
    if (!path) return;
    this.busy = true;
    try {
      await this.lockHandoff(path);
    } finally {
      this.busy = false;
    }
  }

  protected async lockHandoff(path: string) {
    try {
      if (!(await this.api.hasIdentity()) && !(await this.promptPassphrase({ trigger: "lock", context: this.store.get().title }))) return;
      if (!(await this.editor.flush())) return; // error already visible
    } catch (e) {
      this.setErr(errText(e));
      return;
    }
    if (this.editor.currentPath() !== path) return; // belt and braces: the open note changed during the awaits
    this.editor.suspend();
    let np: string;
    try {
      np = isLockedPath(path) ? await this.api.unlockNote(path) : await this.api.lockNote(path);
    } catch (e) {
      this.editor.resume(); // nothing moved: old path is still valid
      this.setErr(e === "already-exists" ? "A note with that title already exists in the other form" : errText(e));
      return;
    }
    try {
      const doc = await this.api.openNote(np);
      this.history.rename(path, np);
      if (this.editor.rebind(path, doc)) {
        this.editor.resume();
        this.loadedDoc(doc);
        this.clearErr();
        this.history.loaded(np, "explicit");
      }
      await this.runSearch(false);
      this.selectOpen();
    } catch (e) {
      // The file moved but could not be reopened: stay read-only (never resume on the old path).
      this.setErr(`Note moved but could not be reopened (${e}); pick it from the list`);
      void this.runSearch(false);
    }
  }

  /** Move the open note (or the highlighted row when none is open) to the Trash after confirmation. */
  async deleteNote() {
    if (this.busy) {
      this.setErr(BUSY_MSG);
      return;
    }
    if (this.store.get().indexing) {
      this.setErr(errText("indexing")); // the backend would refuse after we detached the editor
      return;
    }
    const sel = this.store.get().sel;
    const open = this.editor.currentPath();
    const path = open ?? this.results.get(sel)?.path;
    if (!path) return;
    const title = open ? this.store.get().title : this.results.get(sel)?.title;
    const row = this.results.indexOf(path);
    if (!(await this.ui.confirm(`Move “${title}” to the Trash?`, { title: "Delete note", kind: "warning", okLabel: "Move to Trash" }))) return;
    this.busy = true;
    let reopen = false;
    try {
      if (this.editor.currentPath() === path) {
        // save first so a failed delete can't lose edits; then detach so autosave can't recreate the file
        if (!(await this.editor.flush())) {
          this.setErr("Can't delete: unsaved changes couldn't be saved");
          return;
        }
        this.editor.discard();
        this.closedDoc();
        reopen = true;
      }
      await this.api.deleteNote(path);
      reopen = false;
      this.history.remove(path);
      this.clearErr();
    } catch (e) {
      this.setErr(errText(e));
    } finally {
      this.busy = false;
    }
    if (reopen) await this.show(path); // delete failed after detaching: put the note back
    await this.runSearch(false);
    if (!this.editor.currentPath() && row >= 0 && this.results.count) {
      this.store.set({ sel: Math.min(row, this.results.count - 1) }); // highlight the neighbour (not opened) so Enter keeps working
    }
    void this.refreshTitles();
    this.focusSearch();
  }

  async lockEverything() {
    if (this.busy) return;
    this.busy = true;
    try {
      const path = this.editor.currentPath();
      if (!(await this.editor.flush())) return;
      if (this.editor.currentPath() !== path) return;
      this.editor.suspend();
      try {
        await this.api.lockAll();
      } catch (e) {
        this.editor.resume();
        throw e;
      }
      if (path && isLockedPath(path)) {
        this.editor.unload(); // drop the decrypted text from the editor and stop autosave re-caching it
        this.closedDoc();
      } else this.editor.resume();
      await this.runSearch(false);
      void this.refreshTags(); // a tag only a now-locked note had must leave the panel and filter
    } catch (e) {
      this.setErr(errText(e));
    } finally {
      this.busy = false;
    }
  }

  protected renameFrom: { path: string; old: string } | null = null;

  /** Inline rename of the open note: the title bar shows an input while `renaming`. */
  startRename() {
    const path = this.editor.currentPath();
    if (!path || this.renameFrom) return;
    this.renameFrom = { path, old: this.store.get().title };
    this.store.set({ renaming: true });
  }

  /** The rename input finished: `title` on Enter, null on Escape or blur. */
  async commitRename(input: string | null) {
    const from = this.renameFrom;
    if (!from) return; // already finished (Enter then blur)
    this.renameFrom = null;
    this.store.set({ renaming: false });
    const { path, old } = from;
    const title = input?.trim() ?? "";
    if (!title || title === old) return this.editor.focus();
    try {
      if (!(await this.editor.flush())) return this.editor.focus();
      const n = await this.api.backlinkCount(old);
      const rewrite = n > 0 && (await this.ui.confirm(`Update ${n} links to the new title?`, { title: "Rename", kind: "info" }));
      const r = await this.api.renameNote(path, title, rewrite);
      this.history.rename(path, r.path);
      const doc = await this.api.openNote(r.path);
      if (!this.editor.load(doc)) return;
      this.loadedDoc(doc);
      this.store.set({ title });
      this.setErr("");
      this.history.loaded(r.path, "explicit");
      await this.runSearch(false);
      void this.refreshTags();
    } catch (e) {
      this.setErr(e === "already-exists" ? "A note with that title exists" : errText(e));
    }
    this.editor.focus();
  }

  showTags(on: boolean) {
    this.store.set({ tagPanelOpen: on });
    if (on) void this.refreshTags(); // counts may have moved since the last refresh
  }

  /** Tag filter changed: fresh first page, keeping the open note selected if it is still listed. */
  setTags(next: string[]) {
    this.store.set({ selectedTags: next });
    void this.runSearch(true, true);
  }

  toggleTagFilter(tag: string) {
    this.setTags(toggleTag(this.store.get().selectedTags, tag));
  }

  protected readonly newTagsReq = latest();
  protected tagTimer: ReturnType<typeof setTimeout> | undefined;
  /** After an in-app save (self-writes are skipped by the watcher): coalesce typing bursts into one refresh. */
  protected scheduleTagRefresh() {
    clearTimeout(this.tagTimer);
    this.tagTimer = setTimeout(() => void this.refreshTags(true), 300);
  }

  /** inPlace: when a filter is active, also reload the list so it reflects the new tag state. */
  async refreshTags(inPlace = false) {
    const fresh = this.newTagsReq();
    let tags: TagCount[];
    try {
      tags = await this.api.listTags();
    } catch (e) {
      if (e !== "indexing") console.error("tag refresh failed", e);
      return;
    }
    if (!fresh()) return; // a newer refresh superseded this response
    const selected = this.store.get().selectedTags;
    const kept = pruneSelection(selected, tags);
    const pruned = kept.length !== selected.length;
    this.store.set({ tags, selectedTags: kept });
    if (pruned) void this.runSearch(true, "highlight");
    else if (inPlace && kept.length) void this.runSearch(false);
  }

  togglePreview() {
    this.preview.toggle();
  }

  setPreview(on: boolean) {
    this.preview.setMode(on);
  }

  async toggleLayout() {
    try {
      const cur = await this.api.getSettings();
      const next = { ...cur, layout: cur.layout === "horizontal" ? ("vertical" as const) : ("horizontal" as const) };
      await this.api.setSettings(next);
      this.applyLook(next);
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async toggleStyle() {
    try {
      const cur = await this.api.getSettings();
      const next = cur.editor_style === "plain" ? "rich" : "plain";
      await this.api.setSettings({ ...cur, editor_style: next });
      this.store.set({ editorStyle: next });
      this.syncStyle();
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async toggleFrontMatter() {
    try {
      const cur = await this.api.getSettings();
      const next = !cur.show_front_matter;
      await this.api.setSettings({ ...cur, show_front_matter: next });
      this.store.set({ showFrontMatter: next });
      this.syncStyle();
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  /** Replace the open note with revision `id` as a user edit, after confirming and snapshotting the current text. */
  async restoreRevision(id: string) {
    if (this.busy) return this.setErr(BUSY_MSG); // lock hand-off: the editor is suspended, the file is moving
    const path = this.editor.currentPath();
    if (!path || !(await this.editor.flush())) return;
    try {
      const ts = this.store.get().info.revisions?.find((r) => r.id === id)?.ts;
      const when = ts === undefined ? "earlier" : new Date(ts).toLocaleString();
      if (!(await this.ui.confirm(`Replace the note with this version from ${when}? The current text is kept as a revision.`, { title: "Restore revision", okLabel: "Restore" }))) return;
      if (this.busy) return this.setErr(BUSY_MSG);
      const text = await this.api.readRevision(path, id);
      // Snapshot what the editor holds right before the replace; again if keys were typed meanwhile.
      // A failed snapshot aborts: the current text must stay recoverable.
      let cur;
      do {
        cur = this.editor.getText();
        await this.api.snapshotText(path, cur);
      } while (this.editor.getText() !== cur);
      if (this.busy) return this.setErr(BUSY_MSG);
      if (this.editor.currentPath() === path) {
        this.editor.replaceText(text);
        this.store.set((s) => ({ info: { ...s.info, preview: null } }));
        void this.loadInfo(); // the snapshot above is a new revision
      }
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async toggleSort() {
    try {
      const cur = await this.api.getSettings();
      const next = cur.sort === "title" ? "modified" : "title";
      await this.api.setSettings({ ...cur, sort: next });
      this.store.set({ sort: next });
      await this.resort();
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  /** Open the Settings dialog on the saved settings, once unsaved edits are saved. */
  async openSettings() {
    if (!(await this.editor.flush())) return;
    try {
      this.store.set({ settings: await this.api.getSettings() });
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  closeSettings() {
    this.store.set({ settings: null });
  }

  /** Settings dialog Save: null = saved (dialog closed), else the message to show in the dialog. */
  async saveSettings(next: Settings): Promise<string | null> {
    const cur = this.store.get().settings ?? (await this.api.getSettings());
    try {
      await this.api.setSettings(next); // on hotkey registration failure this throws and the old hotkey stays
    } catch (err) {
      return err === "not-found" ? "Folder not found" : String(err);
    }
    this.applyLook(next);
    this.store.set({ keys: resolve(next.shortcuts, this.opts.isMac), sort: next.sort, headerLabels: next.header_labels, writeFrontMatter: next.write_front_matter, showFrontMatter: next.show_front_matter, infoOpen: next.info_panel, settings: null });
    this.preview?.refresh(); // watermark shows the binding
    this.syncStyle();
    if (next.notes_dir !== cur.notes_dir) {
      this.store.set({ phase: "ready" });
      await this.runSearch(true);
      void this.refreshTitles();
    } else if (next.sort !== cur.sort) await this.resort();
    return null;
  }

  /** First-run chooser: pick the notes folder and load it. */
  async chooseFolder() {
    try {
      const dir = await this.ui.chooseDirectory();
      if (typeof dir !== "string") return;
      await this.api.setSettings({ ...(await this.api.getSettings()), notes_dir: dir });
      this.store.set({ phase: "ready" });
      await this.runSearch(true);
      void this.refreshTitles();
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  protected menuBusy = false; // re-entrancy guard: select awaiting or popup being built

  /** Open row `i` through the normal path, then pop the native menu for it. No menu if the switch was refused. `atRow`: anchor at the row (keyboard) instead of the cursor. */
  async openContextMenu(i: number, atRow = false) {
    const h = this.results.get(i);
    if (!h || this.menuBusy) return;
    this.menuBusy = true;
    try {
      if (!(await this.select(i)) || this.editor.currentPath() !== h.path) return;
      const open = () => this.editor.currentPath(); // actions use the note open when picked
      const run: Record<MenuAction, () => void | Promise<void>> = {
        open: () => this.settleAfterOpen(false, "enter"),
        rename: () => this.startRename(),
        toggle_lock: () => this.toggleLock(),
        copy_link: () => { const p = open(); if (p) return this.ui.copyText(linkFor(this.store.get().title)); },
        reveal: () => { const p = open(); if (p) return this.ui.reveal(p); },
        delete_note: () => this.deleteNote(),
      };
      const { keys, isMac } = this.store.get();
      const items: MenuSpec[] = menuModel({ encrypted: h.encrypted, platform: this.opts.platform, keys, isMac }).map((m) =>
        m === "separator" ? m : { ...m, action: () => void Promise.resolve(run[m.id]()).catch((e) => this.setErr(errText(e))) },
      );
      await this.ui.popupMenu(items, atRow ? this.ui.rowAnchor(this.store.get().sel) : null);
    } catch (e) {
      this.setErr(errText(e));
    } finally {
      this.menuBusy = false;
    }
  }

  /** Conflict banner link: open the conflict copy through the normal flush-then-load path. */
  async openConflict() {
    const p = this.store.get().conflict;
    if (p) await this.show(p);
  }

  dismissConflict() {
    this.store.set({ conflict: null });
  }

  /** Title-bar Retry after a save error. */
  retrySave() {
    void this.editor.flush();
  }

  protected readonly actions: Record<Exclude<Action, "toggle_window">, () => void> = {
    toggle_info: () => void this.toggleInfo(),
    toggle_front_matter: () => void this.toggleFrontMatter(),
    focus_search: () => this.focusSearch(),
    toggle_preview: () => this.togglePreview(),
    rename: () => this.startRename(),
    toggle_lock: () => void this.toggleLock(),
    lock_all: () => void this.lockEverything(),
    settings: () => void this.openSettings(),
    toggle_sort: () => void this.toggleSort(),
    back: () => void this.navigate("back"),
    forward: () => void this.navigate("forward"),
    delete_note: () => void this.deleteNote(),
    toggle_tags: () => this.showTags(!this.store.get().tagPanelOpen),
    toggle_rich: () => void this.toggleStyle(),
    toggle_layout: () => void this.toggleLayout(),
  };

  /**
   * The window's one capture-phase keydown handler: runs before CodeMirror's keymap and the webview defaults
   * (so e.g. ⌘R works from the editor). true = handled: the caller preventDefaults and stops propagation.
   */
  onKeyDown(e: KeyEventLike): boolean {
    if (e.inDialog || e.inRename) return false; // dialogs and the rename field own their keys
    const { sel, keys } = this.store.get();
    if (isMenuKey(e) && !e.inEditor && sel >= 0) {
      void this.openContextMenu(sel, true);
      return true;
    }
    const arrow = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (arrow && !e.inEditor) {
      void this.step(arrow);
      return true;
    }
    for (const [action, run] of Object.entries(this.actions)) {
      if (!matches(e, keys[action as Action], this.opts.isMac)) continue;
      // Backspace combos keep their editing meaning in the editor and in a non-empty search box
      if (keys[action as Action].endsWith("+Backspace") && (e.inEditor || e.inSearchWithText)) continue;
      run();
      return true;
    }
    return false;
  }

  /** Watcher: files changed on disk (self-writes excluded). */
  async onNotesChanged(paths: string[]) {
    await this.runSearch(false);
    void this.refreshTitles();
    void this.refreshTags();
    const open = this.editor.currentPath();
    if (open && paths.includes(open)) {
      // The reload replaces the editor text: keep the old one as a revision (a dirty editor conflicts instead).
      if (!this.editor.isDirty()) await this.api.snapshotText(open, this.editor.getText()).catch((e) => console.warn("snapshot before reload failed:", e));
      this.editor.onExternalChange(open);
    }
  }

  onIndexProgress(done: number, total: number) {
    this.setIndexing(true, done, total);
  }

  async onIndexDone() {
    this.setIndexing(false);
    this.store.set({ phase: "ready" });
    // Also fires after a passphrase reopen: keep the open note selected instead of jumping to row 0.
    await this.runSearch(this.editor.currentPath() === null);
    void this.refreshTitles();
    void this.refreshTags();
  }

  onIndexError(message: string) {
    this.setIndexing(false);
    this.setErr(message);
    void this.runSearch(false); // no vault -> shows the setup screen
  }
}
