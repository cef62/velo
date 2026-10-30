import type { ExportCounts } from "./api";

const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;

/** The export dialog's summary: "23 notes · 41 open tasks · 12 done", then only the non-zero left-out parts. */
export function countsLine(c: ExportCounts): string {
  const parts = [n(c.notes, "note", "notes"), n(c.open, "open task", "open tasks"), `${c.done.toLocaleString("en-US")} done`];
  if (c.locked) parts.push(n(c.locked, "locked note left out", "locked notes left out"));
  if (c.over_limit) parts.push(`${c.over_limit.toLocaleString("en-US")} over the 1,000 limit`);
  if (c.no_tasks) parts.push(`${c.no_tasks.toLocaleString("en-US")} without tasks`);
  if (c.unreadable) parts.push(`${c.unreadable.toLocaleString("en-US")} unreadable`);
  return parts.join(" · ");
}

/** The save dialog's default name: `<title> <YYYY-MM-DD>.md`, characters file names can't hold replaced by "-". */
export const exportFileName = (title: string, today: string): string => `${title.replace(/[/\\:*?"<>|]/g, "-")} ${today}.md`;
