import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
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

const SAVE_DELAY_MS = 500;
const stem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

export function mountEditor(el: HTMLElement, opts: { onEscape?: () => void } = {}): Editor {
  const banner = document.createElement("div");
  banner.className = "banner";
  banner.hidden = true;
  const host = document.createElement("div");
  host.className = "cm-host";
  el.append(banner, host);

  let cur = { path: null as string | null, baseHash: "" };
  let dirty = false;
  let version = 0; // bumps on every user edit; a save only clears dirty if no edit happened meanwhile
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
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
        dirty = true;
        version++;
        clearTimeout(timer);
        timer = setTimeout(() => void ed.flush(), SAVE_DELAY_MS);
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

  // `target` is captured so a save queued before load() still goes to the old note.
  function enqueueSave(target: typeof cur, text: string, v: number) {
    queue = queue.then(async () => {
      if (!target.path) return;
      try {
        const r = await saveNote(target.path, text, target.baseHash);
        if (r.kind === "saved") {
          target.baseHash = r.hash;
          if (target === cur && v === version) dirty = false;
        } else if (target === cur) {
          // Disk version wins in the editor; our text lives in the conflict note.
          const disk = await openNote(target.path);
          target.baseHash = disk.hash;
          setText(disk.text);
          dirty = false;
          showBanner(r.conflict_path);
        }
      } catch (e) {
        console.error("save failed", e); // stays dirty; next edit or change event retries
      }
    });
    return queue;
  }

  const ed: Editor = {
    load(doc) {
      if (dirty) enqueueSave(cur, view.state.doc.toString(), version);
      clearTimeout(timer);
      cur = { path: doc.path, baseHash: doc.hash };
      dirty = false;
      banner.hidden = true;
      setText(doc.text);
    },
    isDirty: () => dirty,
    currentPath: () => cur.path,
    onExternalChange(path) {
      if (path !== cur.path) return;
      if (dirty) return void ed.flush();
      const target = cur;
      openNote(path)
        .then((d) => {
          if (target !== cur || dirty || d.hash === cur.baseHash) return;
          cur.baseHash = d.hash;
          setText(d.text);
        })
        .catch(() => {}); // file vanished: keep content, next save recreates it
    },
    flush() {
      clearTimeout(timer);
      if (dirty && cur.path) return enqueueSave(cur, view.state.doc.toString(), version);
      return queue;
    },
    focus: () => view.focus(),
  };
  return ed;
}
