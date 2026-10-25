import type { NoteDoc, SaveResult } from "./api";

export interface SaverDeps {
  saveNote(path: string, text: string, baseHash: string): Promise<SaveResult>;
  openNote(path: string): Promise<NoteDoc>;
  getText(): string;
  setText(text: string): void;
  onConflict(conflictPath: string): void;
  /** Called with a message on save failure, and with null when a save succeeds. */
  onError(msg: string | null): void;
}

const RETRY_MAX_MS = 30000;

/** Autosave/conflict/reload state machine, free of CodeMirror and Tauri. */
export class SaveController {
  private cur: { path: string | null; baseHash: string } = { path: null, baseHash: "" };
  private dirty = false;
  private version = 0; // bumps on every user edit
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private retryMs = 1000;

  constructor(private d: SaverDeps, private delay = 500) {}

  isDirty = () => this.dirty;
  currentPath = () => this.cur.path;

  /** Refuses (returns false) while edits are unsaved: switching would drop them. */
  load(doc: NoteDoc): boolean {
    if (this.dirty) return false;
    clearTimeout(this.timer);
    this.cur = { path: doc.path, baseHash: doc.hash };
    this.dirty = false;
    this.retryMs = 1000;
    this.d.setText(doc.text);
    return true;
  }

  /**
   * The open note's file moved (lock/unlock). Unlike load() it never refuses: dirty edits are kept
   * and saved to the new path, so a failed hand-off cannot recreate the old (plaintext) file.
   */
  rebind(doc: NoteDoc) {
    if (!this.dirty) return void this.load(doc);
    this.cur = { path: doc.path, baseHash: doc.hash };
    this.schedule(this.delay);
  }

  edit() {
    if (!this.cur.path) return; // nothing to save to; the editor is read-only until a note loads
    this.dirty = true;
    this.version++;
    this.schedule(this.delay);
  }

  /** Saves pending edits; resolves true when the editor is clean afterwards. */
  async flush(): Promise<boolean> {
    if (!this.cur.path) return true;
    clearTimeout(this.timer);
    if (this.dirty && this.cur.path) await this.enqueue(this.cur, this.d.getText(), this.version);
    else await this.queue;
    return !this.dirty;
  }

  external(path: string) {
    if (path !== this.cur.path) return;
    if (this.dirty) return void this.flush();
    const target = this.cur;
    const v = this.version;
    this.d.openNote(path)
      .then((doc) => {
        if (target !== this.cur || v !== this.version || this.dirty || doc.hash === target.baseHash) return;
        target.baseHash = doc.hash;
        this.d.setText(doc.text);
      })
      .catch(() => {}); // file vanished: keep content, next save recreates it
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  // `target` is captured so a save queued before load() still goes to the old note.
  private enqueue(target: typeof this.cur, text: string, v: number) {
    this.queue = this.queue.then(async () => {
      if (!target.path) return;
      try {
        const r = await this.d.saveNote(target.path, text, target.baseHash);
        if (r.kind === "saved") {
          target.baseHash = r.hash;
          if (target === this.cur && v === this.version) this.dirty = false;
        } else if (target === this.cur) {
          // The conflict note holds `text`. If the user typed since, keep the editor text and the
          // stale baseHash: it stays dirty, and the next save conflicts again into a newer
          // conflict note holding the latest text. No keystroke is discarded.
          if (v === this.version) {
            const disk = await this.d.openNote(target.path);
            if (v === this.version) {
              target.baseHash = disk.hash;
              this.d.setText(disk.text);
              this.dirty = false;
            }
          }
          this.d.onConflict(r.conflict_path);
          if (this.dirty) this.schedule(0);
        }
        this.retryMs = 1000;
        this.d.onError(null);
      } catch (e) {
        this.d.onError(`Save failed: ${e}`);
        this.schedule(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    });
    return this.queue;
  }
}
