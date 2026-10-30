import type * as ApiModule from "../api";
import type { AgentReply, AgentWrite, ExportRequest, GraphNode, Hit, LinkTarget, MergeResult, Mention, NoteDoc, SavedSearch, Settings, TagCount, TaskItem } from "../api";
// Types only: editor.ts loads editortheme.ts, which touches `window` at import time (tests run in node).
import type { Editor, EditorOpts } from "../editor";
import type { Preview } from "../preview";
import type { RichOpts } from "../richmd";
import { afterOpen, renderMarkdown, shouldAutoEdit } from "../preview";
import { Results } from "../list";
import { shouldClose } from "../close";
import { latest } from "../latest";
import { History } from "../history";
import { errText } from "../errtext";
import { enterAction, fold, moveSelection } from "../search";
import { extractTags, pruneSelection, toggleTag } from "../tags";
import { frontMatterRange, stripFrontMatter, wordCount } from "../frontmatter";
import { formatBinding, matches, resolve, type Action, type GLOBAL_ACTIONS } from "../shortcuts";
import { isMenuKey, linkFor, menuModel, type MenuAction } from "../contextmenu";
import { isLockedPath } from "../passphrase";
import { localToday } from "../tasks";
import { sinceMs } from "../timeline";
import { exportFileName } from "../export";
import { prepare, rank, type Ranked } from "../fuzzy";
import { extractTitle } from "../writing";
import { cleanName, defaultName, removeFrom, renameIn, sameFilters, upsert, type Filters } from "../saved";
import type { MenuSpec, UiPort } from "./ports";
import { noInfo, type AppState, type Store } from "./store";

export type Api = typeof ApiModule;

export const INVALID_TITLE = 'A title can\'t contain / \\ : * ? " < > | ] or start with a dot';

const connectionsSortOf = (v: unknown): Settings["connections_sort"] => (v === "created" || v === "updated" ? v : "ring");

const BUSY_MSG = "Busy — try again in a moment";
const UPDATE_BUSY = "An update check or install is already running"; // update.rs BUSY
const TASK_MOVED = "This task changed — refreshed";
const UNDO_MS = 5000;
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
  protected linkIndex: Ranked<LinkTarget>[] = []; // [[ autocomplete
  protected tagIndex: Ranked<TagCount>[] = []; // # autocomplete
  protected readonly newShow = latest();
  protected searchSeq = 0;
  protected searching: Promise<void> = Promise.resolve(); // latest list reset, awaited by Enter so it never acts on stale rows
  protected settingsQueue: Promise<unknown> = Promise.resolve();
  protected installing = false;

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
      return api.search(s.query, s.sort, offset, s.selectedTags, s.noLinks);
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
      complete: { links: () => this.linkIndex, tags: () => this.tagIndex, onCreate: (t) => void this.createLinked(t) },
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
      connectionsSort: connectionsSortOf(s.connections_sort),
      savedSearches: s.saved_searches ?? [],
      timeline: { ...this.store.get().timeline, by: s.timeline_sort === "created" ? "created" : "updated" },
    });
    this.syncStyle();
    if (!s.notes_dir) this.store.set({ phase: "setup" });
    else {
      this.store.set({ phase: "ready" });
      if (!st) {
        await this.runSearch(true);
        void this.refreshTitles();
        void this.refreshTags();
        void this.loadTasks();
      }
    }
    this.focusSearch();
  }

  async refreshTitles() {
    this.refreshTimeline(); // titles refresh on every add, rename, delete and lock change
    void this.loadLinkTargets();
    try {
      this.titles = new Set((await this.api.listTitles()).map(fold));
      this.preview?.refresh();
      this.editor?.refreshLinks();
    } catch (e) {
      console.error("title cache refresh failed", e);
    }
  }

  async loadLinkTargets() {
    try {
      this.linkIndex = prepare(await this.api.listLinkTargets(), (t) => t.name);
    } catch (e) {
      console.error("link target refresh failed", e);
    }
  }

  /** The Create row of [[ autocomplete: an empty note; the open note stays open. */
  async createLinked(title: string) {
    try {
      await this.api.createFromSelection(title, "");
    } catch (e) {
      return this.setErr(e === "already-exists" ? "A note with this title exists" : e === "invalid-title" ? INVALID_TITLE : errText(e));
    }
    void this.refreshTitles();
    await this.runSearch(false);
  }

  protected extractFrom: { path: string; from: number; to: number; text: string } | null = null;

  /** Move to new note: ask for a title for the selection. Nothing changes until commitExtract. */
  startExtract() {
    const path = this.editor.currentPath();
    const sel = path ? this.editor.getSelection() : null;
    const s = this.store.get();
    if (!path) return;
    if (s.encrypted) return this.setErr("Can't move text out of a locked note");
    if (this.busy || s.indexing) return this.setErr(BUSY_MSG);
    if (!sel) return this.setErr("Select the text to move first");
    if (sel.from < (frontMatterRange(this.editor.getText())?.to ?? 0)) return this.setErr("Select text below the front matter");
    this.extractFrom = { path, ...sel };
    this.store.set({ extract: { title: extractTitle(sel.text), err: "" } });
  }

  /** The dialog finished: a title on Enter, null on Cancel. The note is created first; the source changes only after that. */
  async commitExtract(input: string | null) {
    const from = this.extractFrom;
    if (!from || input === null) {
      this.extractFrom = null;
      return this.store.set({ extract: null });
    }
    const title = input.trim();
    const fail = (err: string) => this.store.set({ extract: { title: input, err } });
    if (!title) return fail("Title required");
    try {
      await this.api.createFromSelection(title, from.text);
    } catch (e) {
      return fail(e === "already-exists" ? "A note with this title exists" : e === "invalid-title" ? INVALID_TITLE : errText(e));
    }
    this.extractFrom = null;
    this.store.set({ extract: null });
    const same = this.editor.currentPath() === from.path && this.editor.getText().slice(from.from, from.to) === from.text;
    if (!same || !this.editor.applyChange({ from: from.from, to: from.to, insert: `[[${title}]]` }, true))
      this.setErr(`Created “${title}”; the selection changed, so the text was left in place`);
    void this.refreshTitles();
    await this.runSearch(false);
    this.editor.focus();
  }

  /** Merge into…: the open note is the source. Saved first, so the backend merges what is on screen. */
  async startMerge() {
    const path = this.editor.currentPath();
    const s = this.store.get();
    if (!path) return this.setErr("Open a note to merge");
    if (s.encrypted) return this.setErr("Can't merge a locked note");
    if (this.busy || s.indexing) return this.setErr(BUSY_MSG);
    if (!(await this.editor.flush())) return this.setErr("Can't merge: unsaved changes couldn't be saved");
    this.store.set({ merge: { source: path, sourceTitle: s.title, query: "", target: null, err: "" } });
  }

  /** Plain notes other than the source, by title (aliases left out), most recently modified first on ties. */
  mergeCandidates(query: string): LinkTarget[] {
    const source = this.store.get().merge?.source;
    const rows = this.linkIndex.filter((r) => r.item.name === r.item.title && !r.item.locked && r.item.path !== source);
    return rank(fold(query), rows, (a, b) => b.modified - a.modified);
  }

  setMergeQuery(query: string) {
    this.store.set((s) => (s.merge ? { merge: { ...s.merge, query, err: "" } } : {}));
  }

  async chooseMergeTarget(t: LinkTarget) {
    const m = this.store.get().merge;
    if (!m) return;
    try {
      const count = await this.api.backlinkCount(m.sourceTitle);
      this.store.set((s) => (s.merge ? { merge: { ...s.merge, target: { path: t.path, title: t.title, count }, err: "" } } : {}));
    } catch (e) {
      this.store.set((s) => (s.merge ? { merge: { ...s.merge, err: errText(e) } } : {}));
    }
  }

  backMerge() {
    this.store.set((s) => (s.merge && !s.merge.pending ? { merge: { ...s.merge, target: null, err: "" } } : {}));
  }

  cancelMerge() {
    if (this.store.get().merge?.pending) return; // the merge result must still land in the dialog
    this.store.set({ merge: null });
  }

  /** Same detach order as deleteNote: save, then drop the editor's hold on source/target so autosave can't overwrite the merge. */
  async commitMerge() {
    const m = this.store.get().merge;
    if (!m?.target || this.busy) return;
    const target = m.target;
    const patch = (p: { err?: string; pending: boolean }) => this.store.set((s) => (s.merge ? { merge: { ...s.merge, ...p } } : {}));
    const fail = (err: string) => patch({ err, pending: false });
    const open = this.editor.currentPath();
    let reopen: string | null = null;
    let r: MergeResult | null = null;
    this.busy = true;
    patch({ pending: true });
    try {
      if (open === m.source || open === target.path) {
        if (!(await this.editor.flush())) return fail("Can't merge: unsaved changes couldn't be saved");
        this.editor.discard();
        this.closedDoc();
        reopen = open;
      }
      r = await this.api.mergeNotes(m.source, target.path);
      reopen = null;
      this.history.remove(m.source);
    } catch (e) {
      fail(e === "locked" ? "Can't merge a locked note" : e === "same-note" ? "Pick another note" : errText(e));
    } finally {
      this.busy = false;
      patch({ pending: false });
    }
    if (reopen) await this.show(reopen); // merge failed after detaching: put the note back
    if (!r) return;
    this.store.set({ merge: null });
    await this.show(r.path); // always from disk: the link rewrite may have written the target again
    if (r.trash_error) this.setErr(`Merged, but “${m.sourceTitle}” couldn't be moved to the Trash: ${r.trash_error}`);
    await this.runSearch(false);
    void this.refreshTitles();
    void this.refreshTags();
  }

  focusSearch() {
    this.ui.focusSearch();
  }

  setListActive(on: boolean) {
    this.store.set({ listActive: on });
  }

  /** The search text changed: fresh first page. */
  setQuery(q: string) {
    if (this.store.get().capture) return this.store.set((s) => ({ query: q, capture: { ...s.capture!, err: "" } })); // capture text, not a search
    this.keptCapture = false;
    this.store.set({ query: q });
    this.filterChanged(false);
  }

  protected listStale = false; // the query/tags changed in Tasks mode: the Notes list reloads when it is shown again
  /** Query or tag filter changed. In Tasks mode only the tasks follow it: the editor must not jump to a hidden list's first hit. */
  protected filterChanged(keepOpen: boolean | "highlight") {
    const mode = this.store.get().paneMode;
    if (mode === "tasks" || mode === "timeline") {
      this.listStale = true;
      void (mode === "tasks" ? this.loadTasks(true) : this.loadTimeline());
    } else void this.runSearch(true, keepOpen);
  }

  protected captureQuery = ""; // the search text before capture mode, restored when it ends empty
  protected captureSession = 0; // bumped when capture mode ends: a late submit result belongs to an old session
  protected capturePending = false; // a submit is in flight: another Enter would append the task twice
  protected keptCapture = false;
  // A capture whose save into the open note failed: `before` = copies of its line in the note before the append.
  protected captureUnsaved: { path: string; text: string; before: number } | null = null;
  // One writer per note across awaits: a backend write waits for note loads in flight (the load decides the editor's
  // note), and a load waits for backend writes in flight (else its reply holds pre-write text and hash).
  protected readonly pendingLoads = new Set<Promise<unknown>>();
  protected readonly pendingWrites = new Set<Promise<unknown>>();
  /**
   * Flush the open note, wait for backend writes in flight, then `open`; null when the flush failed. Tracked in
   * `pendingLoads` from the flush on, so an agent write deciding "not open" waits for the note this ends up showing.
   */
  protected loading<T>(open: () => Promise<T>): Promise<T | null> {
    return this.track(this.pendingLoads, (async () => {
      if (!(await this.editor.flush())) return null;
      while (this.pendingWrites.size) await Promise.allSettled([...this.pendingWrites]);
      return open();
    })());
  }
  protected track<T>(set: Set<Promise<unknown>>, p: Promise<T>): Promise<T> {
    set.add(p);
    const done = () => set.delete(p);
    p.then(done, done);
    return p;
  } // the query is capture text kept after a blur, not yet edited: never overwrite it

  /** The capture shortcut: the search field becomes "→ <target>", empty (text already typed in capture mode stays). */
  async startCapture() {
    let target = "Inbox";
    try {
      target = (await this.api.captureTargetTitle()).title;
    } catch (e) {
      console.error("capture target failed", e);
    }
    const s = this.store.get();
    if (!s.capture) this.captureQuery = s.query;
    this.store.set({ capture: { target, err: "" }, query: s.capture ? s.query : "" });
    this.focusSearch();
  }

  /**
   * Enter in capture mode. The open target note gets the line through the editor (one writer, ⌘Z undoes it),
   * any other through the backend. On error the text stays in the field with the message under it.
   */
  async submitCapture(text: string) {
    if (!this.store.get().capture || this.capturePending) return;
    const t = text.trim();
    if (!t) return this.endCapture(true);
    if (this.busy) return this.failCapture(BUSY_MSG);
    const session = this.captureSession;
    const live = () => this.captureSession === session && this.store.get().capture !== null;
    this.capturePending = true;
    try {
      // re-read: a capture spanning midnight must target today's daily note, not the one shown at start
      const { title: target, path } = await this.api.captureTargetTitle().catch(() => ({ title: this.store.get().capture?.target ?? "Inbox", path: null }));
      while (this.pendingLoads.size) await Promise.allSettled([...this.pendingLoads]); // the writer depends on which note ends up open
      if (!live()) return;
      this.store.set((s) => ({ capture: { ...s.capture!, target } }));
      const { openPath, title, indexing } = this.store.get();
      // the path the backend would write (an alias resolves to its note); no note yet: compare titles
      if (openPath && this.editor.currentPath() === openPath && (path ? path === openPath : fold(title) === fold(target))) {
        // not editable: read-only while indexing (the gate) or suspended mid lock hand-off
        // A retry never edits a line: if the earlier append is still in the note (unsaved, or saved by the saver's own
        // retry) the flush below saves it or finds it saved; if it went (a conflict reload) it is appended once more.
        // Other text is a new capture; an earlier unsaved line stays in the note and is saved with it.
        const line = "- [ ] " + t;
        const u = this.captureUnsaved?.path === openPath && this.captureUnsaved.text === t ? this.captureUnsaved : null;
        const before = u?.before ?? copies(this.editor.getText(), line);
        if (copies(this.editor.getText(), line) <= before && !this.editor.appendLine(line)) return this.failCapture(indexing ? errText("indexing") : `${target} can't be edited right now`);
        const conflict = this.store.get().conflict;
        if (!(await this.editor.flush())) {
          this.captureUnsaved = { path: openPath, text: t, before };
          return live() ? this.failCapture(`${target} wasn't saved — Enter retries the save`) : undefined;
        }
        this.captureUnsaved = null;
        // the saver put the text in a conflict copy and reloaded the note without the line: same outcome as the backend's "conflict"
        if (this.store.get().conflict !== conflict && this.store.get().conflict !== null) return this.capturedToConflict(live(), text, target);
        return live() ? this.endCapture(true, text) : undefined;
      }
      try {
        await this.track(this.pendingWrites, this.api.captureTask(t));
      } catch (e) {
        if (e === "empty") return live() && this.endCapture(true);
        if (e === "conflict") return this.capturedToConflict(live(), text, target);
        const msg = e === "locked" ? `${target} is locked` : errText(e);
        return live() ? this.failCapture(msg) : this.setErr(msg); // after a blur the text is already the search query
      }
      void this.loadTasks(); // a backend write: the watcher skips it
      if (live()) this.endCapture(true, text);
      else void this.runSearch(false);
    } finally {
      this.capturePending = false;
    }
  }

  /** The line is in a conflict copy: re-sending would add it twice. */
  protected capturedToConflict(live: boolean, text: string, target: string) {
    if (live) this.endCapture(true, text);
    this.setErr(`Saved to a conflict copy — check ${target}`);
  }

  protected failCapture(err: string) {
    this.store.set((s) => (s.capture ? { capture: { ...s.capture, err } } : {}));
  }

  /** Esc in capture mode. */
  cancelCapture() {
    this.endCapture(true);
  }

  /** Focus left the field: leave capture mode, velo stays shown. */
  blurCapture() {
    if (this.store.get().capture) this.endCapture(false);
  }

  /**
   * Typed text is never dropped: uncaptured text stays as a search; otherwise the earlier search comes back.
   * `captured` = the text just appended; anything typed after it (field no longer equal) is kept.
   */
  protected endCapture(hide: boolean, captured?: string) {
    const q = this.store.get().query;
    const keep = q !== captured && q.trim() !== "";
    this.captureSession++;
    this.keptCapture = keep;
    this.captureUnsaved = null;
    this.store.set({ capture: null, ...(keep ? {} : { query: this.captureQuery }) });
    // the kept text lists like a search, but never opens a hit: focus went to the open note (or a note just opened)
    // Tasks always reload: a load during capture mode (watcher, backend write) filtered by the capture text
    const mode = this.store.get().paneMode;
    if (mode === "tasks" || mode === "timeline") this.filterChanged(false);
    else if (keep) void this.runSearch(true, "highlight");
    else if (captured !== undefined) void this.runSearch(false); // the target's row moved; the list is otherwise unchanged
    void this.api.captureDone(hide).catch((e) => console.error("capture done failed", e)); // ends the backend's session even when velo stays shown
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
    const { infoOpen, openPath } = this.store.get();
    if (!infoOpen || !openPath) return;
    const fresh = this.infoReq();
    try {
      const [backlinks, revisions] = await Promise.all([this.api.linkedFromCount(openPath), this.api.listRevisions(openPath)]);
      if (fresh() && this.store.get().openPath === openPath) this.store.set((s) => ({ info: { ...s.info, backlinks, revisions } }));
    } catch (e) {
      if (e !== "locked") console.error("info load failed", e);
    }
  }

  /** Settings read-modify-writes run one at a time: two quick toggles must not write back each other's stale copy. */
  protected updateSettings(f: (cur: Settings) => Promise<void>): Promise<void> {
    const run = this.settingsQueue.then(async () => f(await this.api.getSettings()));
    this.settingsQueue = run.catch(() => {});
    return run;
  }

  async toggleInfo() {
    try {
      await this.updateSettings(async (cur) => {
        const next = !cur.info_panel;
        await this.api.setSettings({ ...cur, info_panel: next });
        this.store.set({ infoOpen: next });
      });
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
      const doc = await this.loading(() => this.api.openNote(path));
      if (!doc) return false;
      if (!current()) return true;
      if (!this.editor.load(doc)) return false;
      this.loadedDoc(doc);
      this.clearErr();
      if (shouldAutoEdit({ created: false, body: doc.text, previewOn: this.preview.isOn() })) this.preview.setMode(false);
      this.history.loaded(doc.path, how);
    } catch (e) {
      if (how === "nav" && e === "not-found") return "missing";
      if (e === "locked" && !retried && how !== "auto") { // never pop the dialog up while typing in search
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
    // a refresh supersedes a fresh first page still in flight: it inherits that page's row-0 rule, or the new query's
    // first match would never be selected and Enter would create a note while it is listed
    if (!selectFirst && this.pendingFirst !== null) [selectFirst, keepOpen] = [true, this.pendingFirst];
    const p = this.doSearch(selectFirst, keepOpen);
    if (selectFirst) this.searching = p;
    return p;
  }

  /** keepOpen: after a reset, stay on the open note when it is in the new first page instead of opening row 0. "highlight": never open anything; select the open note's row if listed, else highlight row 0 (Enter opens it). */
  protected pendingFirst: boolean | "highlight" | null = null; // keepOpen of a fresh first page not landed yet
  protected async doSearch(selectFirst: boolean, keepOpen: boolean | "highlight") {
    const seq = ++this.searchSeq;
    const r = this.results;
    const highlighted = this.highlighted();
    if (selectFirst) this.pendingFirst = keepOpen;
    try {
      await (selectFirst ? r.reset() : r.refresh()).finally(() => seq === this.searchSeq && (this.pendingFirst = null));
      if (seq !== this.searchSeq) return;
      this.listChanged(selectFirst);
      if (selectFirst) {
        if (keepOpen && r.indexOf(this.editor.currentPath() ?? "") >= 0) this.selectOpen();
        else if (keepOpen === "highlight") {
          this.store.set({ sel: r.count ? 0 : -1 }); // highlight row 0, don't open it
        } else void this.select(r.count ? 0 : -1, "auto");
      } else this.reselect(highlighted);
    } catch (e) {
      if (e === "no-folder") this.store.set({ phase: "setup" });
      else if (e !== "indexing") console.error("search failed", e);
    }
  }

  /** Sort changed: fresh first page from the top, keeping the open note selected if it is loaded. */
  protected async resort() {
    // a typed query's first page is in flight: keep its row-0 rule (it pages with the new sort), but never leave the open note
    // when it is listed (a note just created by openTitle)
    if (this.pendingFirst !== null) return this.runSearch(true, this.pendingFirst || true);
    const seq = ++this.searchSeq;
    const highlighted = this.highlighted();
    try {
      await this.results.reset().finally(() => seq === this.searchSeq && (this.pendingFirst = null));
      if (seq !== this.searchSeq) return;
      this.listChanged(true);
      this.reselect(highlighted);
    } catch (e) {
      if (e !== "indexing") console.error("search failed", e);
    }
  }

  /** The path of a highlighted row that is not the open note (row 0 after a "highlight" reset), read before the rows change. */
  protected highlighted(): string | null {
    const p = this.results.get(this.store.get().sel)?.path;
    return p && p !== this.editor.currentPath() ? p : null;
  }

  /**
   * After the rows changed: the open note's row, else the highlighted note's row (Enter opens it, never creates a note).
   * By path, never by index: a row that moved or left must not leave the highlight on another note.
   */
  protected reselect(highlighted: string | null) {
    const open = this.results.indexOf(this.editor.currentPath() ?? "");
    this.store.set({ sel: open >= 0 ? open : highlighted ? this.results.indexOf(highlighted) : -1 });
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

  async enter(force = false, checklist = false) {
    if (this.store.get().paneMode === "tasks") {
      // the field filters tasks here: Enter opens the first one shown, never creates a note
      await settled(() => this.tasksLoading);
      const v = this.store.get().taskView;
      const first = v && [...v.overdue, ...v.today, ...v.upcoming, ...v.no_date, ...v.done][0];
      if (first) await this.openTask(first);
      return;
    }
    if (this.store.get().paneMode === "timeline") {
      // the list is stale here: Enter opens the first note shown, never creates one
      await settled(() => this.timelineLoading);
      const first = this.store.get().timeline.rows?.[0];
      // the passphrase dialog keeps focus: only a note that really loaded takes it
      if (first && (await this.show(first.path)) && this.editor.currentPath() === first.path) this.editor.focus();
      return;
    }
    await settled(() => this.searching);
    const a = enterAction(this.store.get().query, this.results.loaded, this.results.get(this.store.get().sel), force);
    if (!a) return;
    try {
      if (a.kind === "open") {
        // show() reports true even when it swallowed an open error; only settle if the note really loaded
        if (!(await this.show(a.path)) || this.editor.currentPath() !== a.path) return;
        this.settleAfterOpen(false, "enter");
      } else await this.openTitle(a.title, "enter", checklist);
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  /** Open the note titled `title`, creating it if missing; same flush-then-load path as everywhere. */
  async openTitle(title: string, source: "enter" | "wikilink", checklist = false): Promise<boolean> {
    if (this.busy) {
      this.setErr(BUSY_MSG);
      return false;
    }
    const current = this.newShow(); // a pending auto-show must not replace this note when its reply lands later
    try {
      const doc = await this.loading(() => this.api.openOrCreate(title));
      if (!doc) return false;
      const created = doc.created;
      if (!current()) return true;
      if (!this.editor.load(doc)) return false;
      this.loadedDoc(doc);
      this.setErr("");
      this.history.loaded(doc.path, "explicit");
      if (created) {
        if (!this.store.get().capture && !this.keptCapture) this.store.set({ query: doc.title }); // list the new note, selected (resort keeps the open note selected); typed capture text is never replaced
        await this.resort();
      } else await this.runSearch(false);
      void this.refreshTitles();
      if (created && checklist && this.editor.currentPath() === doc.path && stripFrontMatter(this.editor.getText()).trim() === "") this.editor.appendLine("- [ ] "); // after the stamped front matter, caret at the end
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
    if (this.busy) return this.setErr(BUSY_MSG);
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
    void this.loadTasks(); // the path moved (and a locked note's tasks leave the index)
    void this.refreshTitles(); // link targets carry the path and the locked flag
    try {
      const doc = await this.api.openNote(np);
      this.history.rename(path, np);
      if (this.editor.rebind(path, doc)) {
        this.editor.resume();
        this.loadedDoc(doc);
        this.clearErr();
        this.history.loaded(np, "explicit");
      }
      await this.runSearch(false); // reselects the open note's row (by path)
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
    if (this.busy) return this.setErr(BUSY_MSG);
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
      // decrypted task text must not come back: drop the rows, the undo payload and any tasks reply in flight
      clearTimeout(this.undoTimer);
      this.store.set({ taskView: null, tickUndo: null });
      void this.loadTasks(); // a new request: older replies are stale
      void this.loadConnections(); // the graph's links and tags may come from now-locked notes
      void this.refreshTitles(); // link targets carry each note's locked flag
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
    if (this.busy) {
      this.setErr(BUSY_MSG);
      return this.editor.focus();
    }
    this.busy = true; // its editor.load would end an update install's suspension
    let renamed = false;
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
      renamed = true;
    } catch (e) {
      this.setErr(e === "already-exists" ? "A note with that title exists" : e === "invalid-title" ? INVALID_TITLE : errText(e));
    } finally {
      this.busy = false;
    }
    if (renamed) {
      await this.runSearch(false);
      void this.refreshTitles();
      void this.refreshTags();
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
    this.filterChanged(true);
  }

  setNoLinks(on: boolean) {
    this.store.set({ noLinks: on });
    this.filterChanged(true);
  }

  /** The filter line's Clear: tags and the No links chip. */
  clearFilters() {
    this.store.set({ selectedTags: [], noLinks: false });
    this.filterChanged(true);
  }

  toggleTagFilter(tag: string) {
    this.setTags(toggleTag(this.store.get().selectedTags, tag));
  }

  protected filters(): Filters {
    const s = this.store.get();
    return { query: s.query, tags: s.selectedTags, noLinks: s.noLinks };
  }

  /** Save search…: ask for a name for the current filters. Nothing to save without a filter or search text. */
  startSaveSearch() {
    const f = this.filters();
    if (this.store.get().capture || (!f.query.trim() && f.tags.length === 0 && !f.noLinks)) return;
    this.store.set({ saveSearch: { name: defaultName(f), err: "", confirmReplace: false } });
  }

  /** The Save (or Rename) dialog finished: a name on Enter, null on Cancel. A name in use is replaced only on the second, confirmed commit. */
  async commitSaveSearch(input: string | null) {
    const cur = this.store.get().saveSearch;
    if (!cur || input === null) return this.store.set({ saveSearch: null });
    const name = cleanName(input);
    if (!name) return this.store.set({ saveSearch: { ...cur, name: input, err: input.trim() ? "Name too long (60 characters at most)" : "Name required", confirmReplace: false } });
    const taken = this.store.get().savedSearches.some((x) => fold(x.name) === fold(name) && fold(name) !== fold(cur.renaming ?? ""));
    if (taken && !(cur.confirmReplace && fold(cur.name) === fold(name))) return this.store.set({ saveSearch: { ...cur, name, err: "", confirmReplace: true } });
    try {
      if (cur.renaming !== undefined) await this.renameSaved(cur.renaming, name);
      else {
        const f = this.filters();
        await this.writeSaved((l) => upsert(l, { name, query: f.query.trim(), tags: [...f.tags], no_links: f.noLinks }));
      }
      this.store.set({ saveSearch: null });
    } catch (e) {
      this.store.set({ saveSearch: { ...cur, name, err: errText(e), confirmReplace: false } });
    }
  }

  protected writeSaved(f: (list: SavedSearch[]) => SavedSearch[]): Promise<void> {
    return this.updateSettings(async (cur) => {
      const next = f(cur.saved_searches ?? []);
      await this.api.setSettings({ ...cur, saved_searches: next });
      this.store.set({ savedSearches: next });
    });
  }

  /** A saved search's chip: replaces the search text, tags and No links; on the search already applied, clears them. */
  applySaved(name: string) {
    const s = this.store.get();
    const saved = s.savedSearches.find((x) => fold(x.name) === fold(name));
    if (!saved || s.capture) return; // the search field holds capture text, not a search
    const on = sameFilters(saved, this.filters());
    this.keptCapture = false;
    this.store.set(on ? { query: "", selectedTags: [], noLinks: false } : { query: saved.query, selectedTags: [...saved.tags], noLinks: saved.no_links });
    this.filterChanged(false);
  }

  /** A chip's native menu. `atChip`: anchor at the focused chip (keyboard) instead of the cursor. */
  async savedMenu(name: string, atChip: boolean) {
    // ids reuse MenuAction values: a new id would break openContextMenu's exhaustive record; they only name the native items
    const items: MenuSpec[] = [
      { id: "rename", text: "Rename…", action: () => this.store.set({ saveSearch: { name, err: "", confirmReplace: false, renaming: name } }) },
      { id: "delete_note", text: "Delete", action: () => void this.deleteSaved(name) },
    ];
    await this.ui.popupMenu(items, atChip ? this.ui.focusAnchor() : null).catch((e) => this.setErr(errText(e)));
  }

  renameSaved(from: string, to: string): Promise<void> {
    return this.writeSaved((l) => renameIn(l, from, to));
  }

  async deleteSaved(name: string) {
    if (!(await this.ui.confirm(`Delete the saved search “${name}”?`, { title: "Delete saved search", kind: "warning", okLabel: "Delete" }))) return;
    try {
      await this.writeSaved((l) => removeFrom(l, name));
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  protected readonly newTagsReq = latest();
  protected tagTimer: ReturnType<typeof setTimeout> | undefined;
  /** After an in-app save (self-writes are skipped by the watcher): coalesce typing bursts into one refresh. */
  protected scheduleTagRefresh() {
    clearTimeout(this.tagTimer);
    this.tagTimer = setTimeout(() => {
      void this.refreshTags(true);
      void this.loadTasks();
      this.refreshTimeline();
    }, 300);
  }

  setPaneMode(m: AppState["paneMode"]) {
    if (m === "connections") return void this.showConnections();
    this.store.set({ paneMode: m });
    if (m === "tasks") void this.loadTasks();
    else if (m === "timeline") void this.loadTimeline();
    else if (this.listStale) {
      this.listStale = false;
      void this.runSearch(true, "highlight"); // switching modes never changes the open note
    }
  }

  protected readonly newTimelineReq = latest();
  protected timelineLoading: Promise<void> = Promise.resolve(); // latest timeline load, awaited by Enter in Timeline mode
  /** The timeline: notes filtered like the list, newest first by the chosen date, within the range. */
  loadTimeline(): Promise<void> {
    return (this.timelineLoading = this.doLoadTimeline());
  }

  protected async doLoadTimeline() {
    const { query, selectedTags, noLinks, timeline } = this.store.get();
    const fresh = this.newTimelineReq();
    try {
      const rows = await this.api.timeline(query, selectedTags, noLinks, timeline.by, sinceMs(timeline.range, new Date()));
      if (fresh()) this.store.set((s) => ({ timeline: { ...s.timeline, rows, err: "" } }));
    } catch (e) {
      if (fresh()) this.store.set((s) => ({ timeline: { ...s.timeline, rows: null, err: errText(e) } }));
    }
  }

  /** Notes changed: the shown timeline follows. */
  protected refreshTimeline() {
    if (this.store.get().paneMode === "timeline") void this.loadTimeline();
  }

  async setTimelineBy(by: "created" | "updated") {
    this.store.set((s) => ({ timeline: { ...s.timeline, by } }));
    void this.loadTimeline();
    try {
      await this.updateSettings((cur) => this.api.setSettings({ ...cur, timeline_sort: by }));
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  setTimelineRange(range: "7" | "30" | "all") {
    this.store.set((s) => ({ timeline: { ...s.timeline, range } }));
    return this.loadTimeline();
  }

  /** What the timeline shows, as an export request; titled by the matching saved search, else the filters. */
  protected exportRequest(tasksOnly: boolean): ExportRequest {
    const s = this.store.get();
    const f = this.filters();
    const named = s.savedSearches.find((x) => sameFilters(x, f))?.name;
    const title = named ?? ([...f.tags.map((t) => `#${t}`), f.query.trim()].filter(Boolean).join(" ") || "All notes");
    return { query: s.query, tags: s.selectedTags, no_links: s.noLinks, by: s.timeline.by, since_ms: sinceMs(s.timeline.range, new Date()), tasks_only: tasksOnly, title };
  }

  /** Export…: always what the timeline shows, so other panes switch to it first. */
  startExport(): Promise<void> {
    if (this.store.get().paneMode !== "timeline") this.setPaneMode("timeline");
    this.store.set({ exporting: { counts: null, format: "md", tasksOnly: false, err: "", pending: false } });
    return this.loadExportPreview();
  }

  protected readonly newExportReq = latest();
  // The backend reads up to 1,000 files: called on open and on a Tasks only change, never per render.
  protected async loadExportPreview() {
    const cur = this.store.get().exporting;
    if (!cur) return;
    const fresh = this.newExportReq();
    const done = (p: Partial<NonNullable<AppState["exporting"]>>) => fresh() && this.store.set((s) => ({ exporting: s.exporting && { ...s.exporting, ...p } }));
    try {
      done({ counts: await this.api.exportPreview(this.exportRequest(cur.tasksOnly)), err: "" });
    } catch (e) {
      done({ err: errText(e) });
    }
  }

  setExportOptions(p: { format?: "md" | "pdf"; tasksOnly?: boolean }): Promise<void> {
    const cur = this.store.get().exporting;
    if (!cur) return Promise.resolve();
    const refetch = p.tasksOnly !== undefined && p.tasksOnly !== cur.tasksOnly;
    this.store.set({ exporting: { ...cur, ...p, counts: refetch ? null : cur.counts } });
    return refetch ? this.loadExportPreview() : Promise.resolve();
  }

  /** Export (go) or Cancel. Markdown: the save dialog picks the file; cancelling it keeps the dialog open. PDF: the native print dialog. */
  async commitExport(go: boolean) {
    const cur = this.store.get().exporting;
    if (!cur) return;
    if (!go) return this.store.set({ exporting: null });
    if (cur.pending || !cur.counts?.notes) return; // nothing to export writes no empty file
    const req = this.exportRequest(cur.tasksOnly);
    const update = (p: Partial<NonNullable<AppState["exporting"]>>) => this.store.set((s) => ({ exporting: s.exporting && { ...s.exporting, ...p } }));
    update({ pending: true, err: "" });
    if (cur.format === "pdf") {
      try {
        // wikilinks and tags print as plain text: nothing on paper to click
        const html = renderMarkdown(await this.api.exportText(req), () => true).replace(/<a href="#" (class="(?:wikilink|tag)"[^>]*)>(.*?)<\/a>/g, "<span $1>$2</span>");
        this.store.set({ printHtml: html });
        await this.ui.nextFrame();
        await this.api.printPage();
        this.store.set({ printHtml: null, exporting: null });
      } catch (e) {
        this.store.set({ printHtml: null });
        update({ pending: false, err: errText(e) });
      }
      return;
    }
    try {
      const path = await this.ui.saveFile(exportFileName(req.title, localToday()));
      if (path === null) return update({ pending: false });
      await this.api.exportMarkdown(path, req);
      this.store.set({ exporting: null });
    } catch (e) {
      update({ pending: false, err: errText(e) });
    }
  }

  protected readonly newConnectionsReq = latest();
  /** Open the Connections view centred on the open note (flushed first); nothing happens without one. */
  async showConnections() {
    const { openPath } = this.store.get();
    if (!openPath || !(await this.editor.flush())) return;
    this.store.set({ paneMode: "connections", connections: { centre: openPath, data: null, err: "" } });
    await this.loadConnections();
  }

  /** A node picked in the view: the normal open, the centre stays. */
  openFromGraph(path: string) {
    return this.show(path);
  }

  recentre(path: string) {
    this.store.set((s) => ({ connections: { centre: path, data: s.connections?.data ?? null, err: "" } }));
    return this.loadConnections();
  }

  /** (Re)load the graph around the current centre; not called per keystroke (on show, re-centre, Link it). */
  async loadConnections() {
    const centre = this.store.get().connections?.centre;
    if (!centre) return;
    const fresh = this.newConnectionsReq();
    try {
      const data = await this.api.connections(centre);
      if (fresh()) this.store.set({ connections: { centre, data, err: "" } });
    } catch (e) {
      if (fresh()) this.store.set({ connections: { centre, data: null, err: e === "locked" ? "Note is locked" : errText(e) } });
    }
  }

  /**
   * Link it: wrap the mention in [[…]]. The open centre is rewritten through the editor (one undoable change, autosave
   * persists it, typed text kept); a closed one by the backend. A mention that moved only refreshes the graph.
   */
  async linkMention(m: Mention) {
    const conn = this.store.get().connections;
    if (!conn || conn.data?.centre.locked) return;
    const fail = (e: unknown) => this.store.set((s) => ({ connections: s.connections && { ...s.connections, err: errText(e) } }));
    try {
      if (this.editor.currentPath() === conn.centre) {
        const text = this.editor.getText();
        const next = this.busy ? null : await this.api.linkMention(conn.centre, m.name, m.count, text);
        if (next === null) return fail("The note can't be edited right now");
        // typing during the call moved the offsets: the mention is gone or the text changed, so just refresh
        const same = this.editor.currentPath() === conn.centre && this.editor.getText() === text;
        if (same && !this.editor.applyChange(changedSpan(text, next), true)) return fail("The note can't be edited right now");
      } else await this.api.linkMention(conn.centre, m.name, m.count, null);
    } catch (e) {
      if (e !== "mention-moved") return fail(e);
    }
    // the graph reads the centre from disk: autosave would land after the reload
    if (this.editor.currentPath() === conn.centre) await this.editor.flush();
    await this.loadConnections();
  }

  /** Native menu for a node in the view. */
  async openNodeMenu(node: GraphNode, mention: Mention | null) {
    const locked = this.store.get().connections?.data?.centre.locked;
    const items: MenuSpec[] = [{ id: "open", text: "Open in editor", action: () => void this.openFromGraph(node.path) }];
    if (mention && !locked) items.push({ id: "link_it", text: "Link it", action: () => void this.linkMention(mention) });
    await this.ui.popupMenu(items, null).catch((e) => this.setErr(errText(e)));
  }

  async setConnectionsSort(sort: Settings["connections_sort"]) {
    try {
      await this.updateSettings(async (cur) => {
        await this.api.setSettings({ ...cur, connections_sort: sort });
        this.store.set({ connectionsSort: sort });
      });
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async toggleShowDone() {
    this.store.set((s) => ({ showDone: !s.showDone }));
    await this.loadTasks(true);
  }

  protected readonly newTasksReq = latest();
  protected tasksDay = ""; // localToday() at the last load: groups and the due count depend on it
  /** Tasks for the view (filtered like the list) and the due count / Dock badge (unfiltered). */
  loadTasks(filterOnly = false): Promise<void> {
    return (this.tasksLoading = this.doLoadTasks(filterOnly));
  }

  protected tasksLoading: Promise<void> = Promise.resolve(); // latest task load, awaited by Enter in Tasks mode
  protected badgeStale = false; // a full load did not land: the next one recomputes the badge even when only the filter changed
  protected async doLoadTasks(filterOnly: boolean) {
    this.tasksDay = localToday();
    const { query, selectedTags, showDone } = this.store.get();
    const fresh = this.newTasksReq();
    try {
      const v = await this.api.tasks(query, selectedTags, showDone);
      // the badge must not change while typing a search: count from an unfiltered view, and only when notes changed (not per keystroke)
      const filtered = !!query.trim() || selectedTags.length > 0;
      if (!filterOnly) this.badgeStale = true;
      const due = !filtered ? v.due_count : filterOnly && !this.badgeStale ? null : (await this.api.tasks("", [], false)).due_count;
      if (!fresh()) return;
      if (due === null) return void this.store.set({ taskView: v });
      this.badgeStale = false;
      this.store.set({ taskView: v, dueCount: due });
      await this.api.setBadge(due);
    } catch (e) {
      if (e !== "indexing") console.error("tasks refresh failed", e);
    }
  }

  /** The window came back (a sleeping Mac never fires the midnight timer): reload if "today" moved since the last load. */
  refreshIfNewDay() {
    if (localToday() !== this.tasksDay) void this.loadTasks();
  }

  protected undoTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tick from the Tasks view; a backend tick offers undo for 5 s. */
  async tickTask(item: TaskItem) {
    const r = await this.flipTask(item.path, item.line, item.line_text);
    if (!r) return;
    // the row shows the tick now, not after the reload (the editor path waits for its save and a 300 ms debounce)
    const next = r === "editor" ? { line: item.line, line_text: this.editor.getText().split("\n")[item.line]?.replace(/\r$/, "") ?? item.line_text } : r;
    // once: the next task reply replaces it (an editor tick's reload follows its save, so the row may flicker until then)
    const patch = (ts: TaskItem[]) => ts.map((t) => (t.path === item.path && t.line === item.line ? { ...t, ...next, done: !item.done } : t));
    this.store.set(({ taskView: v }) => (v ? { taskView: { ...v, overdue: patch(v.overdue), today: patch(v.today), upcoming: patch(v.upcoming), no_date: patch(v.no_date), done: patch(v.done) } } : {}));
    if (r === "editor") return; // through the editor, ⌘Z undoes it; its save's onSaved reloads the view
    clearTimeout(this.undoTimer);
    this.store.set({ tickUndo: { path: item.path, line: r.line, lineText: r.line_text, unticked: item.done } });
    this.undoTimer = setTimeout(() => this.store.set({ tickUndo: null }), UNDO_MS);
  }

  async undoTick() {
    const u = this.store.get().tickUndo;
    if (!u) return;
    clearTimeout(this.undoTimer);
    this.store.set({ tickUndo: null });
    await this.flipTask(u.path, u.line, u.lineText);
  }

  /**
   * One writer per note: the open note flips through the editor (a backend write would stale its base hash),
   * any other through the backend's line-checked toggle. null = nothing changed; else where the backend put the line.
   */
  protected async flipTask(path: string, line: number, expected: string, retried = false): Promise<"editor" | { line: number; line_text: string } | null> {
    while (this.pendingLoads.size) await Promise.allSettled([...this.pendingLoads]); // the writer depends on which note ends up open
    if (this.busy) {
      this.setErr(BUSY_MSG);
      return null;
    }
    if (this.editor.currentPath() === path) {
      const cur = this.editor.getText().split("\n")[line]?.replace(/\r$/, "");
      if (cur !== expected) return this.taskMoved();
      if (!this.editor.toggleTask(line)) return null;
      void this.editor.flush(); // its onSaved refreshes the view
      return "editor";
    }
    let r;
    try {
      r = await this.track(this.pendingWrites, this.api.toggleTask(path, line, expected));
    } catch (e) {
      if (e === "task-moved") return this.taskMoved();
      if (e === "locked" && !retried) {
        const ok = await this.promptPassphrase({ trigger: "open", context: null });
        if (ok) return this.flipTask(path, line, expected, true);
        if (ok === null) return null; // no key on this computer: keep the copy-identity error
      }
      this.setErr(e === "locked" ? "Note is locked" : errText(e));
      return null;
    }
    void this.loadTasks();
    return r;
  }

  protected taskMoved(): null {
    this.setErr(TASK_MOVED);
    void this.loadTasks();
    return null;
  }

  /** Open the task's note (same flush-then-load path) with the caret on its line. */
  async openTask(item: TaskItem) {
    if (!(await this.show(item.path)) || this.editor.currentPath() !== item.path) return;
    this.preview.setMode(false);
    this.editor.revealLine(item.line);
    this.editor.focus();
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
    this.tagIndex = prepare(tags, (t) => t.tag);
    this.store.set({ tags, selectedTags: kept });
    if (pruned) {
      this.filterChanged("highlight");
      if (this.store.get().paneMode === "notes") void this.loadTasks(); // a load started with the pruned tag must not stay
    } else if (inPlace && kept.length) void this.runSearch(false);
  }

  togglePreview() {
    this.preview.toggle();
  }

  setPreview(on: boolean) {
    this.preview.setMode(on);
  }

  async toggleLayout() {
    try {
      await this.updateSettings(async (cur) => {
        const next = { ...cur, layout: cur.layout === "horizontal" ? ("vertical" as const) : ("horizontal" as const) };
        await this.api.setSettings(next);
        this.applyLook(next);
      });
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async toggleStyle() {
    try {
      await this.updateSettings(async (cur) => {
        const next = cur.editor_style === "plain" ? "rich" : "plain";
        await this.api.setSettings({ ...cur, editor_style: next });
        this.store.set({ editorStyle: next });
      });
      this.syncStyle();
    } catch (e) {
      this.setErr(errText(e));
    }
  }

  async toggleFrontMatter() {
    try {
      await this.updateSettings(async (cur) => {
        const next = !cur.show_front_matter;
        await this.api.setSettings({ ...cur, show_front_matter: next });
        this.store.set({ showFrontMatter: next });
      });
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
      await this.updateSettings(async (cur) => {
        const next = cur.sort === "title" ? "modified" : "title";
        await this.api.setSettings({ ...cur, sort: next });
        this.store.set({ sort: next });
      });
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
    // the open note belongs to the old folder: save it while that folder is still the vault (an agent write may have
    // landed while the dialog was open)
    if (next.notes_dir !== cur.notes_dir && !(await this.editor.flush())) return "Save the open note first";
    try {
      await this.updateSettings(() => this.api.setSettings(next)); // on hotkey registration failure this throws and the old hotkey stays
    } catch (err) {
      return err === "not-found" ? "Folder not found" : String(err);
    }
    this.applyLook(next);
    this.store.set({ keys: resolve(next.shortcuts, this.opts.isMac), sort: next.sort, headerLabels: next.header_labels, writeFrontMatter: next.write_front_matter, showFrontMatter: next.show_front_matter, infoOpen: next.info_panel, connectionsSort: connectionsSortOf(next.connections_sort), savedSearches: next.saved_searches ?? [], settings: null });
    this.preview?.refresh(); // watermark shows the binding
    this.syncStyle();
    if (next.notes_dir !== cur.notes_dir) {
      // saved above; anything typed since could only fail to save into the new folder
      if (!this.editor.unload()) this.editor.discard();
      this.closedDoc();
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
      await this.updateSettings((cur) => this.api.setSettings({ ...cur, notes_dir: dir }));
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
      const run: Record<Exclude<MenuAction, "link_it">, () => void | Promise<void>> = {
        open: () => this.settleAfterOpen(false, "enter"),
        rename: () => this.startRename(),
        toggle_lock: () => this.toggleLock(),
        copy_link: () => { const p = open(); if (p) return this.ui.copyText(linkFor(this.store.get().title)); },
        reveal: () => { const p = open(); if (p) return this.ui.reveal(p); },
        delete_note: () => this.deleteNote(),
        merge_note: () => this.startMerge(),
      };
      const { keys, isMac } = this.store.get();
      const items: MenuSpec[] = menuModel({ encrypted: h.encrypted, platform: this.opts.platform, keys, isMac }).map((m) =>
        m === "separator" ? m : { ...m, action: () => void Promise.resolve(run[m.id as keyof typeof run]()).catch((e) => this.setErr(errText(e))) },
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

  /** The background check found a new version (the backend announces each version once). */
  onUpdateAvailable(version: string) {
    if (this.store.get().update?.status !== "installing") this.store.set({ update: { version, status: "available" } });
  }

  /** Manual check (app menu, Settings): the result shows in the update banner, and is returned as one line for Settings. */
  async checkUpdates(): Promise<string> {
    if (this.store.get().update?.status === "installing") return "Installing…";
    try {
      const found = await this.api.checkUpdate();
      if (found) {
        this.store.set({ update: { version: found.version, status: "available" } });
        return `velo ${found.version} is available`;
      }
      const version = await this.api.appVersion();
      this.store.set({ update: { version, status: "current" } });
      return `velo is up to date (${version})`;
    } catch (e) {
      if (e === UPDATE_BUSY) return "Already checking…"; // a repeat click, or the daily check: its result arrives on its own
      this.setErr(errText(e));
      return errText(e);
    }
  }

  /** The result is shown in the Settings dialog, which covers the error banner. */
  async copyAgentSetup(): Promise<string> {
    try {
      await this.ui.copyText(await this.api.agentSetupCommand());
      return "Copied";
    } catch (e) {
      return errText(e);
    }
  }

  /** Save, freeze the editor, then install; the backend relaunches velo. On failure the editor comes back. */
  async installUpdate() {
    const u = this.store.get().update;
    if (u?.status !== "available" || this.installing) return; // a repeat click
    if (this.busy) return this.setErr(BUSY_MSG);
    this.busy = this.installing = true;
    try {
      if (!(await this.editor.flush())) return; // the save error stays visible; nothing is lost
      this.newShow(); // a note reply still on its way must not load (load ends the suspension)
      this.editor.suspend(); // the relaunch skips the close flow: no edit may start now
      this.store.set({ update: { ...u, status: "installing", message: `Downloading velo ${u.version}…` } });
      await this.api.installUpdate();
    } catch (e) {
      this.editor.resume();
      if (e === UPDATE_BUSY) {
        this.store.set({ update: u }); // the daily check is running; the update is still there
        this.setErr("Checking for updates — try again in a moment");
      } else {
        // No Install button: the backend dropped the update; the next check announces it again.
        this.store.set({ update: { version: u.version, status: "failed", message: `Update failed: ${errText(e)}` } });
      }
    } finally {
      this.busy = this.installing = false;
    }
  }

  /** Download progress from the backend: percent when the size is known, else megabytes. */
  onUpdateProgress(downloaded: number, total: number | null) {
    const u = this.store.get().update;
    if (u?.status !== "installing") return;
    const amount = total ? `${Math.min(100, Math.floor((downloaded * 100) / total))}%` : `${(downloaded / 1e6).toFixed(1)} MB`;
    this.store.set({ update: { ...u, message: `Downloading velo ${u.version}… ${amount}` } });
  }

  /** The download finished; the plugin now checks the signature and replaces the bundle. */
  onUpdateInstalling() {
    const u = this.store.get().update;
    if (u?.status === "installing") this.store.set({ update: { ...u, message: `Installing velo ${u.version}… velo restarts when it's done.` } });
  }

  dismissUpdate() {
    if (this.store.get().update?.status !== "installing") this.store.set({ update: null });
  }

  openReleaseNotes(version: string) {
    void this.ui.openUrl(`https://github.com/cef62/velo/releases/tag/v${version}`).catch((e) => this.setErr(String(e)));
  }

  /** Title-bar Retry after a save error. */
  retrySave() {
    void this.editor.flush();
  }

  protected readonly actions: Record<Exclude<Action, (typeof GLOBAL_ACTIONS)[number]>, () => void> = {
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
    daily_note: () => void this.openTitle(localToday(), "enter"),
    extract_note: () => this.startExtract(),
    merge_note: () => void this.startMerge(),
    toggle_tasks: () => this.setPaneMode(this.store.get().paneMode === "tasks" ? "notes" : "tasks"),
    toggle_connections: () => this.setPaneMode(this.store.get().paneMode === "connections" ? "notes" : "connections"),
    toggle_timeline: () => this.setPaneMode(this.store.get().paneMode === "timeline" ? "notes" : "timeline"),
    export: () => void this.startExport(),
    save_search: () => this.startSaveSearch(),
  };

  /**
   * The window's one capture-phase keydown handler: runs before CodeMirror's keymap and the webview defaults
   * (so e.g. ⌘R works from the editor). true = handled: the caller preventDefaults and stops propagation.
   */
  onKeyDown(e: KeyEventLike): boolean {
    if (e.inDialog || e.inRename) return false; // dialogs and the rename field own their keys
    const { sel, keys, paneMode } = this.store.get();
    const notes = paneMode === "notes"; // the note list's keys do nothing while the pane lists tasks
    if (notes && isMenuKey(e) && !e.inEditor && sel >= 0) {
      void this.openContextMenu(sel, true);
      return true;
    }
    const arrow = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (notes && arrow && !e.inEditor) {
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
    void this.loadTasks();
    const open = this.editor.currentPath();
    // during an agent rename the editor is frozen on the old path: agentRenamed reloads it
    if (open && paths.includes(open) && this.agentRenaming !== open) {
      // The reload replaces the editor text: keep the old one as a revision (a dirty editor conflicts instead).
      if (!this.editor.isDirty()) await this.api.snapshotText(open, this.editor.getText()).catch((e) => console.warn("snapshot before reload failed:", e));
      this.editor.onExternalChange(open);
    }
  }

  /** An agent write (via the backend's `agent-write`) to the note open in the editor: applied as a user edit, then saved. */
  protected agentQueue: Promise<unknown> = Promise.resolve();
  protected agentRenaming: string | null = null; // the open note's path while the backend renames it (editor frozen)

  /** An agent request (the backend's `agent-write`) about the open note; one at a time, in arrival order. */
  onAgentWrite(req: AgentWrite): Promise<void> {
    const run = this.agentQueue.then(async () => {
      const reply = await this.agentWrite(req).catch((): AgentReply => "refused");
      if (reply !== null) await this.api.agentWriteDone(req.id, reply); // null: the backend stopped waiting
    });
    this.agentQueue = run.catch(() => {});
    return run;
  }

  protected async agentWrite(req: AgentWrite): Promise<AgentReply | null> {
    if (req.kind === "renamed") return this.agentRenamed(req.path, req.to ?? null);
    if (req.kind === "trash-failed") {
      this.setErr(`The agent couldn't move “${req.title ?? req.path}” to the Trash: ${req.error ?? "unknown error"}`); // the note left the editor but is still there
      return "ok";
    }
    // a load in flight decides which note ends up open: a not-open answered before it lands would let the backend
    // write behind the editor that then shows the old text
    while (this.pendingLoads.size) await Promise.allSettled([...this.pendingLoads]);
    if (req.kind === "flush") {
      // a rename is about to rewrite links in these notes: the open one must be saved first
      if (!req.paths?.includes(this.editor.currentPath() ?? "")) return "not-open";
      return (await this.editor.flush()) && !this.editor.isDirty() ? "flushed" : "refused";
    }
    const open = () => this.editor.currentPath() === req.path;
    if (!open()) return "not-open"; // the backend does it itself
    if (this.busy || !(await this.editor.flush())) return "refused";
    if (!open()) return "not-open";
    if (req.kind === "trash" || req.kind === "rename") {
      if (this.busy || this.editor.isDirty()) return "refused";
      if (!(await this.api.agentWriteClaim(req.id))) return null;
      if (!open() || this.busy || this.editor.isDirty()) return "refused";
      if (req.kind === "rename") {
        // frozen until `renamed`, so autosave can't recreate the file under its old name
        this.busy = true;
        this.editor.suspend();
        this.agentRenaming = req.path;
        return "ready";
      }
      this.editor.discard(); // clean (flushed): nothing is dropped; autosave can't bring the file back
      this.closedDoc();
      this.history.remove(req.path);
      void this.runSearch(false);
      void this.refreshTitles();
      return "closed";
    }
    const saved = await this.api.openNote(req.path);
    // a replace was computed from the saved text `base`; a keystroke or another write since then would be overwritten
    const check = (): AgentReply | null =>
      !open() || this.busy
        ? "refused"
        : this.editor.isDirty() || saved.text.replace(/\r\n?/g, "\n") !== this.editor.getText() || (req.kind === "replace" && saved.hash !== req.base)
          ? "conflict"
          : null;
    let bad = check();
    if (bad) return bad;
    if (!(await this.api.agentWriteClaim(req.id))) return null; // timed out: the agent was told velo is busy
    const snap = await this.api.snapshotAgent(req.path, req.summary ?? "");
    // not applied after all (a keystroke landed during the snapshot): its revision would record a write that never happened
    const unapplied = async (r: AgentReply) => {
      if (snap) await this.api.dropAgentSnapshot(req.path, snap).catch((e) => console.warn("dropping the agent snapshot failed:", e));
      return r;
    };
    if ((bad = check())) return unapplied(bad);
    const insert = req.insert ?? "";
    const ok = req.kind === "append" ? this.editor.appendLine(insert) : this.editor.applyChange(changedSpan(this.editor.getText(), insert));
    if (!ok) return unapplied("refused");
    // applied: from here no failure may invite a retry, which would apply it twice
    try {
      if (!(await this.editor.flush())) return "unsaved"; // the edit stays in the editor; its save error or conflict banner shows
      return { hash: (await this.api.openNote(req.path)).hash };
    } catch {
      return "unsaved";
    }
  }

  /** The backend finished renaming the open note (`to` null: it failed): unfreeze the editor where the note now is. */
  protected async agentRenamed(from: string, to: string | null): Promise<AgentReply> {
    if (this.agentRenaming !== from) return "ok";
    this.agentRenaming = null;
    try {
      if (!to) {
        this.editor.resume();
        return "ok";
      }
      try {
        this.history.rename(from, to);
        const doc = await this.api.openNote(to);
        this.editor.load(doc); // clean and frozen since `ready`: never refused
        this.loadedDoc(doc);
      } catch (e) {
        this.editor.discard(); // never resume on the old path: a save would recreate it
        this.closedDoc();
        this.setErr(errText(e));
      }
    } finally {
      this.busy = false;
    }
    void this.runSearch(false);
    void this.refreshTitles();
    void this.refreshTags();
    return "ok";
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
    void this.loadTasks();
  }

  onIndexError(message: string) {
    this.setIndexing(false);
    this.setErr(message);
    void this.runSearch(false); // no vault -> shows the setup screen
  }
}

/** How many lines of `text` read exactly `line`. */
const copies = (text: string, line: string) => text.split("\n").filter((l) => l.replace(/\r$/, "") === line).length;

/** Awaits the latest of a promise that can be replaced while awaited (a newer load drops the older one's reply). */
async function settled(latest: () => Promise<unknown>) {
  for (let p = latest(); ; p = latest()) {
    await p;
    if (p === latest()) return;
  }
}

/** The single change turning `a` into `b`: common prefix and suffix kept, so undo and the caret only touch what changed. */
export function changedSpan(a: string, b: string) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}
