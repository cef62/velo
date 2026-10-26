import { Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { writingSetup } from "./editortheme";
import { refreshRich, richMarkdown, type RichOpts } from "./richmd";
import { TASK_ITEM } from "./preview";
import { SaveController } from "./saver";
import { openNote, saveNote, type NoteDoc } from "./api";

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
  /** Re-check wikilink targets after the note titles changed. */
  refreshLinks(): void;
  /** Flip "[ ]" / "[x]" of the task item on this 0-based line (from the preview); false if not editable or not a task. */
  toggleTask(line: number): boolean;
}

const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

export function mountEditor(el: HTMLElement, opts: { onEscape?: () => void; onError?: (msg: string | null) => void; onChange?: () => void; onEdit?: () => void; onSaved?: () => void; rich?: RichOpts } = {}): Editor {
  const banner = document.createElement("div");
  banner.className = "banner";
  banner.hidden = true;
  const host = document.createElement("div");
  host.className = "cm-host";
  el.append(banner, host);

  let ctrl: SaveController;
  let loading = false;
  const editable = new Compartment(); // read-only until a note is loaded (no path to save to)
  const rich = new Compartment();

  const view = new EditorView({
    parent: host,
    extensions: [
      writingSetup(),
      rich.of([]),
      editable.of(EditorView.editable.of(false)),
      keymap.of([{ key: "Escape", run: () => (opts.onEscape?.(), true) }]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        opts.onChange?.(); // also fires on load so the preview follows note switches
        if (loading) return;
        opts.onEdit?.(); // user edits only (not loads)
        ctrl.edit();
      }),
    ],
  });

  const setText = (text: string) => {
    loading = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    loading = false;
  };

  function showBanner(conflictPath: string) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = stem(conflictPath);
    a.onclick = async (e) => {
      e.preventDefault();
      if (!(await ed.flush())) return;
      if (ed.load(await openNote(conflictPath))) banner.hidden = true;
    };
    banner.replaceChildren("Your edits were saved to ", a);
    banner.hidden = false;
  }

  ctrl = new SaveController({
    saveNote,
    openNote,
    getText: () => view.state.doc.toString(),
    setText,
    onConflict: showBanner,
    onError: (m) => opts.onError?.(m),
    onSaved: () => opts.onSaved?.(),
  });

  let wantEditable = false; // what load/suspend/resume/unload asked for
  let readOnly = false; // indexing override, wins over wantEditable
  const apply = () => view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(wantEditable && !readOnly)) });
  const setEditable = (on: boolean) => { wantEditable = on; apply(); };

  const ed: Editor = {
    load(doc) {
      if (!ctrl.load(doc)) return false;
      banner.hidden = true;
      setEditable(true);
      return true;
    },
    rebind(fromPath, doc) {
      if (!ctrl.rebind(fromPath, doc)) return false;
      banner.hidden = true;
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
      banner.hidden = true;
    },
    unload() {
      if (!ctrl.unload()) return false;
      setEditable(false);
      banner.hidden = true;
      return true;
    },
    isDirty: ctrl.isDirty,
    currentPath: ctrl.currentPath,
    onExternalChange: (p) => ctrl.external(p),
    flush: () => ctrl.flush(),
    focus: () => view.focus(),
    getText: () => view.state.doc.toString(),
    setRich: (on) => view.dispatch({ effects: rich.reconfigure(on && opts.rich ? richMarkdown(opts.rich) : []) }),
    refreshLinks: () => view.dispatch({ effects: refreshRich.of(null) }),
    toggleTask(line) {
      const doc = view.state.doc;
      if (!view.state.facet(EditorView.editable) || line < 0 || line >= doc.lines) return false; // no note, indexing, lock hand-off
      const l = doc.line(line + 1);
      const m = TASK_ITEM.exec(l.text);
      if (!m) return false;
      const pos = l.from + m[1].length;
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: m[2] === " " ? "x" : " " } });
      return true;
    },
  };
  return ed;
}
