import { expect, test } from "vitest";
import type { TimelineRow } from "./api";
import { groupByDay, sinceMs } from "./timeline";

const now = new Date(2026, 9, 30, 12, 0);
const row = (title: string, d: Date): TimelineRow => ({ path: `/n/${title}.md`, title, date: d.getTime(), snippet: "", locked: false });

test("rows group by local day with relative labels", () => {
  const rows = [
    row("a", new Date(2026, 9, 30, 0, 5)),
    row("b", new Date(2026, 9, 29, 23, 55)),
    row("c", new Date(2026, 9, 26, 10, 0)),
    row("d", new Date(2026, 9, 12, 9, 0)),
    row("e", new Date(2026, 9, 12, 8, 0)),
  ];
  const g = groupByDay(rows, now, "en-GB");
  expect(g.map((x) => x.label.split(" ")[0])).toEqual(["Today", "Yesterday", "Monday", "12"]);
  expect(g[2].label).toBe("Monday 26 Oct");
  expect(g[3].label).toBe("12 Oct 2026");
  expect(g[3].rows.map((r) => r.title)).toEqual(["d", "e"]);
  expect(g.flatMap((x) => x.rows)).toEqual(rows);
});

test("range start is exactly N×24 h back; all has none", () => {
  expect(sinceMs("7", now)).toBe(now.getTime() - 7 * 86_400_000);
  expect(sinceMs("30", now)).toBe(now.getTime() - 30 * 86_400_000);
  expect(sinceMs("all", now)).toBeNull();
});
