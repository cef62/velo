import type { TimelineRow } from "./api";

export type DayGroup = { key: string; label: string; rows: TimelineRow[] };

const DAY = 86_400_000;

/** Rows by local calendar day, in row order: Today, Yesterday, the weekday within a week, then the full date. */
export function groupByDay(rows: TimelineRow[], now: Date, locale?: string): DayGroup[] {
  const recent = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short" });
  const older = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = new Map<string, DayGroup>();
  for (const r of rows) {
    const d = new Date(r.date);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let g = groups.get(key);
    if (!g) {
      const ago = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / DAY); // round: a DST day is 23 or 25 h
      const label = ago === 0 ? "Today" : ago === 1 ? "Yesterday" : ago > 1 && ago < 7 ? recent.format(d) : older.format(d);
      groups.set(key, (g = { key, label, rows: [] }));
    }
    g.rows.push(r);
  }
  return [...groups.values()];
}

/** Start of the range: exactly the last N×24 h; null = all time. */
export const sinceMs = (range: "7" | "30" | "all", now: Date): number | null => (range === "all" ? null : now.getTime() - Number(range) * DAY);

/** The active filters as one line: “query” · #tag · No links · last 30 days. Shown under "No notes match" and in the Export dialog. */
export const filtersLine = (f: { query: string; tags: string[]; noLinks: boolean; range: "7" | "30" | "all" }): string =>
  [f.query.trim() && `“${f.query.trim()}”`, ...f.tags.map((t) => `#${t}`), f.noLinks && "No links", f.range !== "all" && `last ${f.range} days`].filter(Boolean).join(" · ");
