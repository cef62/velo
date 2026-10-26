import type { Hit, Page } from "./api";

/** Rows [start, end) to render for a scroll position, with `overscan` extra rows each side, clamped to [0, count]. */
export function visibleRange(scrollTop: number, viewport: number, rowH: number, count: number, overscan = 10): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowH) + overscan);
  return [Math.min(start, end), end];
}

/** Server-paged result set. Pages are appended in order; a newer reset/refresh invalidates in-flight loads. */
export class Results {
  private rows: Hit[] = [];
  private more = false;
  private tot = 0; // match count, from the first page only
  private gen = 0;
  private pending: Promise<void> | null = null;
  constructor(private fetch: (offset: number) => Promise<Page>) {}

  get count() { return this.rows.length; }
  get hasMore() { return this.more; }
  /** Total matches, as reported by the latest first page. */
  get total() { return this.tot; }
  /** The rows loaded so far (do not mutate). */
  get loaded(): Hit[] { return this.rows; }
  get(i: number): Hit | undefined { return this.rows[i]; }
  indexOf(path: string): number { return this.rows.findIndex((h) => h.path === path); }

  async reset(): Promise<void> {
    const gen = ++this.gen;
    this.pending = null;
    const p = await this.fetch(0);
    if (gen !== this.gen) return;
    this.rows = p.hits;
    this.more = p.has_more;
    this.tot = p.total;
  }

  /** Load pages until row `index` exists or the server has no more. */
  async ensure(index: number): Promise<void> {
    while (index >= this.rows.length && this.more) {
      const gen = this.gen;
      const offset = this.rows.length;
      this.pending ??= this.fetch(offset).then((p) => {
        if (gen !== this.gen || offset !== this.rows.length) return; // stale, or rows moved under us (reset in flight)
        this.rows = this.rows.concat(p.hits);
        this.more = p.has_more && p.hits.length > 0;
      }).finally(() => { if (gen === this.gen) this.pending = null; });
      await this.pending;
      if (gen !== this.gen) return;
    }
  }

  /** Re-fetch the already loaded range from page 0 (same row count, fresh contents). */
  async refresh(): Promise<void> {
    const gen = ++this.gen;
    this.pending = null;
    const want = this.rows.length;
    let rows: Hit[] = [];
    let more = true;
    let tot = this.tot;
    do {
      const p = await this.fetch(rows.length);
      if (gen !== this.gen) return;
      if (!rows.length) tot = p.total;
      rows = rows.concat(p.hits);
      more = p.has_more && p.hits.length > 0;
    } while (more && rows.length < want);
    this.rows = rows;
    this.more = more;
    this.tot = tot;
  }
}

export function ago(ms: number): string {
  const m = (Date.now() - ms) / 60000;
  if (m < 1) return "now";
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 43200) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 43200)}mo`;
}
