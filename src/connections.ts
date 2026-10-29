import type { Connections, GraphNode } from "./api";

/** A node with its position in the pane. Keys: `centre`, `out:<path>`, `in:<path>`, `mention:<path>`, `#tag`, `#tag:<path>`. */
export type Placed = { key: string; node: GraphNode; kind: "centre" | "out" | "in" | "tag" | "mention"; x: number; y: number };

const PAD_X = 56; // room for a node's label, centred under it
const PAD_Y = 28;
const ROW = 28; // stacked same-day rows in the time layouts
const AXIS = 16; // under the time layouts' bottom labels: the view draws its date axis there

const newest = (a: GraphNode[]) => [...a].sort((x, y) => y.modified - x.modified);

/** Every node in ring order (centre, out, in, tags, mentions; each group by modified descending), unpositioned. */
function nodes(c: Connections): Omit<Placed, "x" | "y">[] {
  const out: Omit<Placed, "x" | "y">[] = [{ key: "centre", node: c.centre, kind: "centre" }];
  for (const n of newest(c.links_out)) out.push({ key: `out:${n.path}`, node: n, kind: "out" });
  for (const n of newest(c.links_in)) out.push({ key: `in:${n.path}`, node: n, kind: "in" });
  for (const g of c.tags) {
    // a tag node has no note: it carries the centre's dates and its label as the title; collapsed shows the count
    const title = g.notes.length === 0 && g.count > 0 ? `+${g.count}` : `#${g.tag}`;
    out.push({ key: `#${g.tag}`, node: { ...c.centre, path: "", title, preview: "", locked: false }, kind: "tag" });
    for (const n of newest(g.notes)) out.push({ key: `#${g.tag}:${n.path}`, node: n, kind: "tag" });
  }
  for (const m of [...c.mentions].sort((x, y) => y.node.modified - x.node.modified)) out.push({ key: `mention:${m.node.path}`, node: m.node, kind: "mention" });
  return out;
}

/** The centre in the middle, the others evenly on one circle starting at the top. */
export function ringLayout(c: Connections, w: number, h: number): Placed[] {
  const [centre, ...rest] = nodes(c);
  const [cx, cy] = [w / 2, h / 2];
  const r = Math.max(0, Math.min(cx - PAD_X, cy - PAD_Y));
  return [
    { ...centre, x: cx, y: cy },
    ...rest.map((p, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / rest.length;
      return { ...p, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    }),
  ];
}

const dayOf = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** x linear in the day of `key` (centre included); same-day nodes stack upwards from the axis. Returned in date order. */
export function timeLayout(c: Connections, key: "created" | "modified", w: number, h: number): Placed[] {
  const days = new Map<number, Omit<Placed, "x" | "y">[]>();
  for (const p of nodes(c)) {
    const d = dayOf(p.node[key]);
    days.set(d, [...(days.get(d) ?? []), p]);
  }
  const sorted = [...days.keys()].sort((a, b) => a - b);
  const [min, max] = [sorted[0], sorted[sorted.length - 1]];
  const span = Math.max(0, w - 2 * PAD_X);
  const tallest = Math.max(...[...days.values()].map((col) => col.length));
  const row = tallest > 1 ? Math.min(ROW, Math.max(0, h - 2 * PAD_Y - AXIS) / (tallest - 1)) : 0;
  const base = Math.max(0, h - PAD_Y - AXIS);
  return sorted.flatMap((d) => {
    const x = max === min ? w / 2 : PAD_X + (span * (d - min)) / (max - min);
    return days.get(d)!.map((p, i) => ({ ...p, x, y: Math.max(0, base - i * row) }));
  });
}

/** Tab and arrow order: the layouts return nodes in their sort's order. */
export const tabOrder = (placed: Placed[]): string[] => placed.map((p) => p.key);

export const dateText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
export const isTagNode = (p: Placed) => p.key.startsWith("#") && !p.key.includes(":");
const KIND = { centre: "centre", out: "links to", in: "linked from", mention: "mention" } as const;

/** A node's accessible name: "{title}, {kind}, {date}"; a tag node gives its note count, a tag's note names its tag. */
export function nodeLabel(p: Placed, c: Connections, key: "created" | "modified"): string {
  if (isTagNode(p)) return `${p.key}, tag, ${c.tags.find((g) => `#${g.tag}` === p.key)?.count ?? 0} notes`;
  const kind = p.kind === "tag" ? `tagged ${p.key.slice(0, p.key.indexOf(":"))}` : KIND[p.kind];
  return `${p.node.title}, ${kind}, ${dateText(p.node[key])}`;
}

/** What a key does on a focused node; Tab stays native (the nodes render in tab order). */
export function nodeKeyAction(key: string, shift: boolean): "open" | "recentre" | "leave" | "next" | "prev" | null {
  if (key === "Enter") return shift ? "recentre" : "open";
  if (key === " ") return "open";
  if (key === "Escape") return "leave";
  if (key === "ArrowRight" || key === "ArrowDown") return "next";
  if (key === "ArrowLeft" || key === "ArrowUp") return "prev";
  return null;
}
