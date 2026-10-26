/** Back/forward trail of visited note paths. Back/forward move the cursor without recording a visit. */
export class History {
  private e: string[] = [];
  private i = -1;

  get canBack() { return this.i > 0; }
  get canForward() { return this.i < this.e.length - 1; }

  visit(path: string) {
    if (this.e[this.i] === path) return;
    this.e.splice(this.i + 1);
    this.i = this.e.push(path) - 1;
  }

  /** Move to the nearest earlier entry that exists, dropping missing ones passed over. null = none (nothing moves). */
  back(exists: (p: string) => boolean): string | null {
    let j = this.i - 1;
    while (j >= 0 && !exists(this.e[j])) j--;
    if (j < 0) return null;
    this.e.splice(j + 1, this.i - j - 1);
    this.i = j;
    return this.e[j];
  }

  forward(exists: (p: string) => boolean): string | null {
    let j = this.i + 1;
    while (j < this.e.length && !exists(this.e[j])) j++;
    if (j >= this.e.length) return null;
    this.e.splice(this.i + 1, j - this.i - 1);
    this.i++;
    return this.e[this.i];
  }

  rename(oldPath: string, newPath: string) {
    this.e = this.e.map((p) => (p === oldPath ? newPath : p));
  }

  /** Drop every entry for `path`. The cursor stays on its entry; if that was removed, on its right neighbor. */
  remove(path: string) {
    for (let k = this.e.length - 1; k >= 0; k--) {
      if (this.e[k] !== path) continue;
      this.e.splice(k, 1);
      if (k < this.i) this.i--;
    }
    this.i = Math.min(this.i, this.e.length - 1);
  }
}
