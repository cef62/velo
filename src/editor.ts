import { Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
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
}

const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

export function mountEditor(el: HTMLElement, opts: { onEscape?: () => void; onError?: (msg: string | null) => void; onChange?: () => void; onEdit?: () => void; onSaved?: () => void } = {}): Editor {
  const banner = document.createElement("div");
  banner.className = "banner";
  banner.hidden = true;
  const host = document.createElement("div");
  host.className = "cm-host";
  el.append(banner, host);

  let ctrl: SaveController;
  let loading = false;
  const editable = new Compartment(); // read-only until a note is loaded (no path to save to)

  const view = new EditorView({
    parent: host,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
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
  };
  return ed;
}
