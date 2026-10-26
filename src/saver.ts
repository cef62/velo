import type { NoteDoc, SaveResult } from "./api";

export interface SaverDeps {
  saveNote(path: string, text: string, baseHash: string): Promise<SaveResult>;
  openNote(path: string): Promise<NoteDoc>;
  getText(): string;
  setText(text: string): void;
  onConflict(conflictPath: string): void;
  /** Called with a message on save failure, and with null when a save succeeds. */
  onError(msg: string | null): void;
  /** Called after a save landed on disk (also as a conflict copy), e.g. to refresh derived views like tags. */
  onSaved?(): void;
  /** true while a saveNote request is in flight, false once it settled (also on failure). */
  onSaving?(on: boolean): void;
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
  private suspended = false;

  constructor(private d: SaverDeps, private delay = 500) {}

  isDirty = () => this.dirty;
  currentPath = () => this.cur.path;

  /** While suspended nothing is saved or marked dirty (lock hand-off: the file is about to move). */
  suspend() {
    clearTimeout(this.timer);
    this.suspended = true;
  }
  resume() {
    this.suspended = false;
  }

  /** Detach from the current note (clean only; false if dirty). Used after Lock all so autosave can't re-cache plaintext. */
  unload(): boolean {
    if (this.dirty) return false;
    clearTimeout(this.timer);
    this.cur = { path: null, baseHash: "" };
    this.suspended = false;
    this.d.setText("");
    return true;
  }

  /** Detach unconditionally, dropping unsaved edits (the note is being deleted). */
  discard() {
    clearTimeout(this.timer);
    this.dirty = false;
    this.suspended = false;
    this.cur = { path: null, baseHash: "" };
    this.d.setText("");
  }

  /** Refuses (returns false) while edits are unsaved: switching would drop them. */
  load(doc: NoteDoc): boolean {
    if (this.dirty) return false;
    this.suspended = false; // an explicit switch to a valid note ends any suspension
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
   * No-op (false) unless the open note is still `fromPath`: if the user switched notes meanwhile,
   * their edits belong to that other note and must not be saved over the moved one.
   */
  rebind(fromPath: string, doc: NoteDoc): boolean {
    if (this.cur.path !== fromPath) return false;
    if (!this.dirty) return this.load(doc);
    this.cur = { path: doc.path, baseHash: doc.hash };
    this.schedule(this.delay);
    return true;
  }

  edit() {
    if (!this.cur.path || this.suspended) return; // nothing to save to; the editor is read-only until a note loads
    this.dirty = true;
    this.version++;
    this.schedule(this.delay);
  }

  /** Saves pending edits; resolves true when the editor is clean afterwards. */
  async flush(): Promise<boolean> {
    if (!this.cur.path || this.suspended) return true;
    clearTimeout(this.timer);
    if (this.dirty && this.cur.path) await this.enqueue(this.cur, this.d.getText(), this.version);
    else await this.queue;
    return !this.dirty;
  }

  external(path: string) {
    if (path !== this.cur.path || this.suspended) return;
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
        this.d.onSaving?.(true);
        const r = await this.d.saveNote(target.path, text, target.baseHash).finally(() => this.d.onSaving?.(false));
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
        this.d.onSaved?.();
      } catch (e) {
        this.d.onError(`Save failed: ${e}`);
        this.schedule(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    });
    return this.queue;
  }
}
