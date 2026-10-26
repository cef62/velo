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
  private gen = 0;
  private pending: Promise<void> | null = null;
  constructor(private fetch: (offset: number) => Promise<Page>) {}

  get count() { return this.rows.length; }
  get hasMore() { return this.more; }
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
    do {
      const p = await this.fetch(rows.length);
      if (gen !== this.gen) return;
      rows = rows.concat(p.hits);
      more = p.has_more && p.hits.length > 0;
    } while (more && rows.length < want);
    this.rows = rows;
    this.more = more;
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

export interface ListView {
  /** Rows changed (reset/refresh/page loaded): re-render, keeping the scroll position. */
  update(): void;
  /** Mark row `i` selected (-1 = none) and scroll it into view. */
  setSelected(i: number): void;
  toTop(): void;
  setRowH(h: number): void;
}

const LOAD_AHEAD = 50;

/** Fixed-height virtualized list: only the visible window (+overscan) of rows exists in the DOM. */
export function mountList(el: HTMLElement, o: { results: Results; onSelect(i: number): void; onContextMenu?(i: number, x: number, y: number): void; rowH: number }): ListView {
  let { rowH } = o;
  let selected = -1;
  const rendered = new Map<number, HTMLElement>();
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  el.setAttribute("role", "listbox");
  el.replaceChildren(spacer);

  function build(i: number): HTMLElement {
    const h = o.results.get(i)!;
    const row = document.createElement("div");
    row.className = "row" + (i === selected ? " sel" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === selected));
    row.setAttribute("aria-setsize", String(o.results.count));
    row.setAttribute("aria-posinset", String(i + 1));
    row.style.top = `${i * rowH}px`;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = (h.encrypted ? "🔒 " : "") + h.title;
    const m = document.createElement("span");
    m.className = "m";
    m.textContent = ago(h.mtime);
    const s = document.createElement("div");
    s.className = "s";
    s.textContent = h.snippet;
    row.append(t, m, s);
    row.onclick = () => o.onSelect(i);
    row.oncontextmenu = (e) => { e.preventDefault(); o.onContextMenu?.(i, e.clientX, e.clientY); };
    return row;
  }

  function paint(full: boolean) {
    const { count, hasMore } = o.results;
    spacer.style.height = `${(count + (hasMore ? 1 : 0)) * rowH}px`;
    if (full) {
      for (const r of rendered.values()) r.remove();
      rendered.clear();
      spacer.querySelector(".loader")?.remove();
    }
    const [a, b] = visibleRange(el.scrollTop, el.clientHeight, rowH, count);
    for (const [i, r] of rendered) if (i < a || i >= b) { r.remove(); rendered.delete(i); }
    for (let i = a; i < b; i++) if (!rendered.has(i)) { const r = build(i); rendered.set(i, r); spacer.append(r); }
    const loader = spacer.querySelector<HTMLElement>(".loader");
    if (hasMore && !loader) {
      const l = document.createElement("div");
      l.className = "loader";
      l.textContent = "Loading…";
      l.style.top = `${count * rowH}px`;
      spacer.append(l);
    } else if (!hasMore) loader?.remove();
    else if (loader) loader.style.top = `${count * rowH}px`;
    if (hasMore && b >= count - LOAD_AHEAD) {
      const had = count;
      o.results.ensure(count).then(() => { if (o.results.count !== had) paint(true); }, (e) => console.error("load more failed", e));
    }
  }

  el.addEventListener("scroll", () => paint(false), { passive: true });
  return {
    update: () => paint(true),
    setSelected(i) {
      selected = i;
      if (i >= 0) {
        const top = i * rowH;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
      }
      paint(true);
    },
    toTop() { el.scrollTop = 0; },
    setRowH(h) { rowH = h; paint(true); },
  };
}
