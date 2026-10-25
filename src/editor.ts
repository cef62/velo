import { Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { SaveController } from "./saver";
import { openNote, saveNote, type NoteDoc } from "./api";

export interface Editor {
  /** false = refused because of unsaved edits. */
  load(doc: NoteDoc): boolean;
  isDirty(): boolean;
  currentPath(): string | null;
  onExternalChange(path: string): void;
  /** Save pending edits now; resolves true when clean afterwards. */
  flush(): Promise<boolean>;
  focus(): void;
  getText(): string;
}

const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

export function mountEditor(el: HTMLElement, opts: { onEscape?: () => void; onError?: (msg: string | null) => void; onChange?: () => void } = {}): Editor {
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
  });

  const ed: Editor = {
    load(doc) {
      if (!ctrl.load(doc)) return false;
      banner.hidden = true;
      view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(true)) });
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
