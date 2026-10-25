import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { SaveController } from "./saver";
import { openNote, saveNote, type NoteDoc } from "./api";

export interface Editor {
  load(doc: NoteDoc): void;
  isDirty(): boolean;
  currentPath(): string | null;
  onExternalChange(path: string): void;
  /** Save pending edits now; resolves when all queued saves finished. */
  flush(): Promise<void>;
  focus(): void;
}

const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

export function mountEditor(el: HTMLElement, opts: { onEscape?: () => void; onError?: (msg: string | null) => void } = {}): Editor {
  const banner = document.createElement("div");
  banner.className = "banner";
  banner.hidden = true;
  const host = document.createElement("div");
  host.className = "cm-host";
  el.append(banner, host);

  let ctrl: SaveController;
  let loading = false;

  const view = new EditorView({
    parent: host,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      keymap.of([{ key: "Escape", run: () => (opts.onEscape?.(), true) }]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || loading) return;
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
      banner.hidden = true;
      await ed.flush();
      ed.load(await openNote(conflictPath));
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
      banner.hidden = true;
      ctrl.load(doc);
    },
    isDirty: ctrl.isDirty,
    currentPath: ctrl.currentPath,
    onExternalChange: (p) => ctrl.external(p),
    flush: () => ctrl.flush(),
    focus: () => view.focus(),
  };
  return ed;
}
