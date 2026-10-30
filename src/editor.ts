import { Annotation, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { writingCompletions, type CompleteSource } from "./complete";
import { writingSetup } from "./editortheme";
import { refreshRich, richMarkdown, type RichOpts } from "./richmd";
import { dueInputRule, localToday, toggleTaskAt } from "./tasks";
import { SaveController } from "./saver";
import { frontMatterHide, ISOLATED, replaceAll, stampSelection, undoHistory } from "./fmhide";
import { stampChange } from "./frontmatter";
import { openNote, saveNote, type NoteDoc, type NoteMeta } from "./api";

export interface Editor {
  /** false = refused because of unsaved edits. */
  load(doc: NoteDoc): boolean;
  /** Like load() but never refuses: for the open note's file being renamed by lock/unlock. False (no-op) if `fromPath` is no longer open. */
  rebind(fromPath: string, doc: NoteDoc): boolean;
  /** Read-only and no saving until resume()/load(): for the lock hand-off. */
  suspend(): void;
  resume(): void;
  /** Read-only override (indexing) on top of the editor's own state; saving is unaffected. */
  setReadOnly(on: boolean): void;
  /** Detach from the (clean) open note and empty the editor; false if dirty. */
  unload(): boolean;
  /** Detach even if dirty, dropping unsaved edits (note being deleted). */
  discard(): void;
  isDirty(): boolean;
  currentPath(): string | null;
  onExternalChange(path: string): void;
  /** Save pending edits now; resolves true when clean afterwards. */
  flush(): Promise<boolean>;
  focus(): void;
  getText(): string;
  /** Rich edit (marks hidden off the cursor line) or plain markdown. */
  setRich(on: boolean): void;
  /** Show the front-matter block, or hide it (atomic, caret kept after it). */
  setShowFrontMatter(on: boolean): void;
  /** Replace the whole text as a user edit (dirty, autosaved): restoring a revision. */
  replaceText(text: string): void;
  /** Re-check wikilink targets after the note titles changed. */
  refreshLinks(): void;
  /** Flip the box of the task item on this 0-based line (from the preview), stamping/removing its done date; false if not editable or not a task. */
  toggleTask(line: number): boolean;
  /** Append `text` as a new last line (user edit); false if not editable. */
  appendLine(text: string): boolean;
  /** Replace [from, to) with `insert` as a user edit (undoable, autosaved); false if not editable. `isolate`: its own undo step, never joined to typing. */
  applyChange(change: { from: number; to: number; insert: string }, isolate?: boolean): boolean;
  /** The main selection, or null when it is empty. */
  getSelection(): { from: number; to: number; text: string } | null;
  /** Caret to the start of this 0-based line, scrolled into view (a hidden front matter clamps it to the body). */
  revealLine(line: number): void;
}

export type EditorOpts = {
  onEscape?: () => void;
  onError?: (msg: string | null) => void;
  onChange?: () => void;
  onEdit?: () => void;
  onSaved?: () => void;
  /** A save conflicted: the edits went to a conflict copy at `conflictPath` (the UI shows the banner). */
  onConflict?: (conflictPath: string) => void;
  /** A save request is in flight (true) or finished (false). */
  onSaving?: (on: boolean) => void;
  /** Effective dates/tags/aliases after a successful save of the open note. */
  onMeta?: (meta: NoteMeta) => void;
  rich?: RichOpts;
  /** `[[` autocomplete over these link targets. */
  complete?: CompleteSource;
  onFocus?: () => void;
};

// Marks the stamped-dates change of a save: not a user edit (no dirty, no new save).
const stamped = Annotation.define<boolean>();

export function mountEditor(el: HTMLElement, opts: EditorOpts = {}): Editor {
  const host = document.createElement("div");
  host.className = "cm-host";
  el.append(host);

  let ctrl: SaveController;
  let loading = false;
  const editable = new Compartment(); // read-only until a note is loaded (no path to save to)
  const rich = new Compartment();
  const fmHide = new Compartment();
  const undo = undoHistory();

  const view = new EditorView({
    parent: host,
    extensions: [
      writingSetup(),
      undo.extension,
      dueInputRule,
      rich.of([]),
      fmHide.of(frontMatterHide(true)),
      editable.of(EditorView.editable.of(false)),
      opts.complete ? writingCompletions(opts.complete) : [],
      // an open popup takes Escape itself: close it, keep focus in the editor
      keymap.of([{ key: "Escape", run: (v) => completionStatus(v.state) === null && (opts.onEscape?.(), true) }]),
      EditorView.domEventHandlers({ focus: () => opts.onFocus?.() }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        opts.onChange?.(); // also fires on load so the preview follows note switches
        if (loading || u.transactions.some((t) => t.annotation(stamped))) return;
        opts.onEdit?.(); // user edits only (not loads)
        ctrl.edit();
      }),
    ],
  });

  const setText = (text: string) => {
    loading = true;
    // Caret to the top; a hidden front matter moves it past the block.
    view.dispatch(replaceAll(view.state.doc, text));
    for (const spec of undo.reset) view.dispatch(spec);
    loading = false;
  };

  ctrl = new SaveController({
    saveNote,
    openNote,
    getText: () => view.state.doc.toString(),
    setText,
    onConflict: (p) => opts.onConflict?.(p),
    onSaving: (on) => opts.onSaving?.(on),
    onError: (m) => opts.onError?.(m),
    onSaved: () => opts.onSaved?.(),
    onMeta: (m) => opts.onMeta?.(m),
    applyFrontMatter(block, sentBlock) {
      const c = stampChange(view.state.doc.toString(), block, sentBlock);
      if (!c) return;
      const changes = view.state.changes(c);
      // a caret at 0 (empty note) ends up after an inserted block, on the same body character
      view.dispatch({ changes, selection: stampSelection(view.state.selection, changes), annotations: [stamped.of(true), Transaction.addToHistory.of(false)] });
    },
  });

  let wantEditable = false; // what load/suspend/resume/unload asked for
  let readOnly = false; // indexing override, wins over wantEditable
  const apply = () => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(wantEditable && !readOnly)) });
  const setEditable = (on: boolean) => { wantEditable = on; apply(); };

  const ed: Editor = {
    load(doc) {
      if (!ctrl.load(doc)) return false;
      setEditable(true);
      return true;
    },
    rebind(fromPath, doc) {
      if (!ctrl.rebind(fromPath, doc)) return false;
      return true;
    },
    suspend() {
      ctrl.suspend();
      setEditable(false);
    },
    resume() {
      ctrl.resume();
      setEditable(!!ctrl.currentPath());
    },
    setReadOnly(on) {
      readOnly = on;
      apply();
    },
    discard() {
      ctrl.discard();
      setEditable(false);
    },
    unload() {
      if (!ctrl.unload()) return false;
      setEditable(false);
      return true;
    },
    isDirty: ctrl.isDirty,
    currentPath: ctrl.currentPath,
    onExternalChange: (p) => ctrl.external(p),
    flush: () => ctrl.flush(),
    focus: () => view.focus(),
    getText: () => view.state.doc.toString(),
    setRich: (on) => view.dispatch({ effects: rich.reconfigure(on && opts.rich ? richMarkdown(opts.rich) : []) }),
    setShowFrontMatter(on) {
      view.dispatch({ effects: fmHide.reconfigure(frontMatterHide(!on)) });
      if (!on) view.dispatch({ selection: view.state.selection }); // re-run the caret guard: off the hidden block
    },
    replaceText: (text) => view.dispatch(replaceAll(view.state.doc, text)), // restore: never leave the caret before a hidden block
    refreshLinks: () => view.dispatch({ effects: refreshRich.of(null) }),
    toggleTask(line) {
      const doc = view.state.doc;
      if (!view.state.facet(EditorView.editable) || line < 0 || line >= doc.lines) return false; // no note, indexing, lock hand-off
      const change = toggleTaskAt(doc, doc.line(line + 1).from, localToday());
      if (!change) return false;
      view.dispatch({ changes: change });
      return true;
    },
    appendLine(text) {
      if (!view.state.facet(EditorView.editable)) return false;
      const doc = view.state.doc;
      const sep = doc.length === 0 || doc.sliceString(doc.length - 1) === "\n" ? "" : "\n";
      view.dispatch({ changes: { from: doc.length, insert: sep + text }, selection: { anchor: doc.length + sep.length + text.length } });
      return true;
    },
    applyChange(change, isolate) {
      if (!view.state.facet(EditorView.editable)) return false;
      view.dispatch({ changes: change, ...(isolate && ISOLATED) });
      return true;
    },
    getSelection() {
      const { from, to } = view.state.selection.main;
      return from === to ? null : { from, to, text: view.state.sliceDoc(from, to) };
    },
    revealLine(line) {
      const doc = view.state.doc;
      const pos = doc.line(Math.min(Math.max(line, 0), doc.lines - 1) + 1).from;
      // the hidden-front-matter guard moves the caret past the block; scroll to where it really lands
      view.dispatch({ selection: { anchor: pos } });
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
    },
  };
  return ed;
}
