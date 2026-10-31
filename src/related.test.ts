import { expect, test } from "vitest";
import type { Connections, GraphNode } from "./api";
import { defaultClosed, relatedCount, relatedRows, stem, stepRelated } from "./related";

const n = (title: string, modified = 0, context = ""): GraphNode => ({ path: `/n/${title}.md`, title, created: 0, modified, preview: `${title} preview`, locked: false, context });
const c: Connections = {
  centre: n("C"),
  links_in: [n("A", 2, "See [[C]] here"), n("B", 1)],
  links_out: [n("D")],
  tags: [
    { tag: "idea", count: 2, notes: [n("E"), n("F")] },
    { tag: "work", count: 148, notes: [] },
    { tag: "small", count: 5, notes: [n("G"), n("H"), n("I"), n("J"), n("K")] },
  ],
  mentions: [{ node: n("M"), name: "C", count: 2, context: "mentions C twice" }],
  missing: ["Passphrase UX"],
};

test("rows: sections in order, empty ones left out, missing targets under Links to, tags with 3 notes then All N", () => {
  const rows = relatedRows(c, new Set());
  expect(rows.map((r) => r.id)).toEqual([
    "in", "in:/n/A.md", "in:/n/B.md",
    "out", "out:/n/D.md", "missing:Passphrase UX",
    "mentions", "mention:/n/M.md",
    "tags", "tag:idea", "tag:idea:/n/E.md", "tag:idea:/n/F.md", "tag:work", "tag:work:more", "tag:small", "tag:small:/n/G.md", "tag:small:/n/H.md", "tag:small:/n/I.md", "tag:small:more",
  ]);
  expect(rows[1]).toMatchObject({ kind: "note", context: "See [[C]] here", level: 2 });
  expect(rows.find((r) => r.id === "tag:work:more")).toMatchObject({ kind: "more", count: 148 });
  expect(relatedCount(c)).toBe(5);
  expect(relatedRows({ ...c, links_in: [], mentions: [] }, new Set()).map((r) => r.id).slice(0, 2)).toEqual(["out", "out:/n/D.md"]);
});

test("closed groups hide their rows; big tags start closed", () => {
  expect(defaultClosed(c)).toEqual(new Set(["tag:work", "tag:small"]));
  const rows = relatedRows(c, new Set(["in", "tag:idea"]));
  expect(rows.map((r) => r.id).slice(0, 2)).toEqual(["in", "out"]);
  expect(rows.find((r) => r.id === "tag:idea")).toMatchObject({ open: false });
  expect(rows.some((r) => r.id === "tag:idea:/n/E.md")).toBe(false);
});

test("stepRelated: ↑/↓ over headers too, → opens, ← closes or goes to the parent", () => {
  const rows = relatedRows(c, new Set(["tag:work"]));
  expect(stepRelated(rows, 0, "ArrowDown")).toEqual({ to: 1 });
  expect(stepRelated(rows, 0, "ArrowUp")).toBeNull();
  expect(stepRelated(rows, rows.length - 1, "ArrowDown")).toBeNull();
  expect(stepRelated(rows, 0, "ArrowLeft")).toEqual({ toggle: "in", open: false }); // open section closes
  expect(stepRelated(rows, 1, "ArrowLeft")).toEqual({ to: 0 }); // a row goes to its section
  const work = rows.findIndex((r) => r.id === "tag:work");
  expect(stepRelated(rows, work, "ArrowRight")).toEqual({ toggle: "tag:work", open: true });
  expect(stepRelated(rows, work, "ArrowLeft")).toEqual({ to: rows.findIndex((r) => r.id === "tags") });
  expect(stepRelated(rows, 0, "ArrowRight")).toEqual({ to: 1 }); // open section: → steps in
  expect(stepRelated(rows, 1, "ArrowRight")).toBeNull();
  expect(stepRelated(rows, 5, "End")).toEqual({ to: rows.length - 1 });
});

test("stem", () => {
  expect(stem("/v/notes/Velo roadmap.md")).toBe("Velo roadmap");
  expect(stem("C:\\notes\\Journal.md.age")).toBe("Journal");
});
