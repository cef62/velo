import { expect, test } from "vitest";
import type { Connections, GraphNode } from "./api";
import { ringLayout, tabOrder, timeLayout } from "./connections";

const day = (d: number, hour = 12) => new Date(2026, 0, d, hour).getTime();
const n = (path: string, modified: number, created = modified): GraphNode => ({ path, title: path, created, modified, preview: "", locked: false });
const conn = (over: Partial<Connections> = {}): Connections => ({ centre: n("c.md", day(10)), links_out: [], links_in: [], tags: [], mentions: [], ...over });
const full = conn({
  links_out: [n("o1.md", day(1)), n("o2.md", day(5))],
  links_in: [n("i1.md", day(3))],
  tags: [{ tag: "work", count: 2, notes: [n("t1.md", day(2)), n("t2.md", day(4))] }],
  mentions: [{ node: n("m1.md", day(6)), name: "m1", count: 1 }],
});

test("ring puts centre in the middle and others on one circle", () => {
  const [w, h] = [400, 300];
  const placed = ringLayout(full, w, h);
  const centre = placed.find((p) => p.kind === "centre")!;
  expect([centre.x, centre.y]).toEqual([w / 2, h / 2]);
  const dist = placed.filter((p) => p !== centre).map((p) => Math.hypot(p.x - w / 2, p.y - h / 2));
  expect(dist.length).toBe(7);
  for (const d of dist) expect(Math.abs(d - dist[0])).toBeLessThanOrEqual(0.5);
  for (const p of placed) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(w);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(h);
  }
});

test("ring groups by kind in order", () => {
  const placed = ringLayout(full, 400, 300).filter((p) => p.kind !== "centre");
  expect(placed.map((p) => p.kind)).toEqual(["out", "out", "in", "tag", "tag", "tag", "mention"]);
  // each group by modified descending; a tag node leads its notes
  expect(placed.map((p) => p.key)).toEqual(["out:o2.md", "out:o1.md", "in:i1.md", "#work", "#work:t2.md", "#work:t1.md", "mention:m1.md"]);
});

test("collapsed tag places only its node", () => {
  const placed = ringLayout(conn({ tags: [{ tag: "big", count: 17, notes: [] }] }), 400, 300);
  const tags = placed.filter((p) => p.kind === "tag");
  expect(tags.length).toBe(1);
  expect(tags[0].key).toBe("#big");
  expect(tags[0].node.title).toBe("+17");
});

test("time layout orders by date and stacks same-day nodes", () => {
  const c = conn({ links_out: [n("a.md", day(1)), n("b.md", day(3, 9)), n("b2.md", day(3, 18))] });
  const [w, h] = [400, 300];
  const placed = timeLayout(c, "modified", w, h);
  const at = (k: string) => placed.find((p) => p.key === k)!;
  expect(at("out:b.md").x).toBeGreaterThan(at("out:a.md").x);
  expect(at("out:b.md").x).toBe(at("out:b2.md").x);
  expect(at("out:b.md").y).not.toBe(at("out:b2.md").y);
  expect(at("centre").x).toBeGreaterThan(at("out:b.md").x);
  for (const p of placed) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(w);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(h);
  }
  // created is its own key
  const byCreated = timeLayout(conn({ links_out: [n("a.md", day(1), day(8)), n("b.md", day(3), day(2))] }), "created", w, h);
  expect(byCreated.find((p) => p.key === "out:a.md")!.x).toBeGreaterThan(byCreated.find((p) => p.key === "out:b.md")!.x);
});

test("time layout with one date fits the pane", () => {
  const c = conn({ links_out: [n("a.md", day(10)), n("b.md", day(10))], tags: [{ tag: "x", count: 1, notes: [n("t.md", day(10))] }] });
  const [w, h] = [400, 300];
  for (const p of timeLayout(c, "modified", w, h)) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(w);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(h);
  }
});

test("tabOrder follows the sort", () => {
  expect(tabOrder(ringLayout(full, 400, 300))).toEqual(["centre", "out:o2.md", "out:o1.md", "in:i1.md", "#work", "#work:t2.md", "#work:t1.md", "mention:m1.md"]);
  // time: by date; the tag node sits at the centre's date
  expect(tabOrder(timeLayout(full, "modified", 400, 300))).toEqual(["out:o1.md", "#work:t1.md", "in:i1.md", "#work:t2.md", "out:o2.md", "mention:m1.md", "centre", "#work"]);
});
