import type { Connections, GraphNode, Mention } from "./api";

// The Related tab (design v2 §5): a keyboard tree that follows the open note.
// Sections in order: Linked from (with the sentence that links), Links to (missing targets in red),
// Mentions (Link it), Shared tags (one group per tag, the 3 most recent notes, then "All N in the list").

export type RelatedRow =
  | { kind: "section"; id: string; title: string; count: number; open: boolean; level: 1 }
  | { kind: "note"; id: string; node: GraphNode; context: string; level: 2 | 3; parent: string }
  | { kind: "missing"; id: string; title: string; level: 2; parent: string }
  | { kind: "mention"; id: string; mention: Mention; level: 2; parent: string }
  | { kind: "tag"; id: string; tag: string; count: number; open: boolean; level: 2; parent: string }
  | { kind: "more"; id: string; tag: string; count: number; level: 3; parent: string };

export const TAG_SHOWN = 3; // notes listed under a tag before "All N in the list"

/** Links in + out, mentions and missing targets: the number on the Related tab. */
export const relatedCount = (c: Connections | null): number => (c ? c.links_in.length + c.links_out.length + c.mentions.length + c.missing.length : 0);

/** Tag groups with more notes than are listed start collapsed. */
export const defaultClosed = (c: Connections): Set<string> => new Set(c.tags.filter((g) => g.count > TAG_SHOWN).map((g) => `tag:${g.tag}`));

/** The tree as rows, `closed` holding the ids of collapsed sections and tags. Empty sections are left out. */
export function relatedRows(c: Connections, closed: Set<string>): RelatedRow[] {
  const rows: RelatedRow[] = [];
  const section = (id: string, title: string, count: number, body: () => void) => {
    if (count === 0) return;
    const open = !closed.has(id);
    rows.push({ kind: "section", id, title, count, open, level: 1 });
    if (open) body();
  };
  section("in", "Linked from", c.links_in.length, () => {
    for (const n of c.links_in) rows.push({ kind: "note", id: `in:${n.path}`, node: n, context: n.context, level: 2, parent: "in" });
  });
  section("out", "Links to", c.links_out.length + c.missing.length, () => {
    for (const n of c.links_out) rows.push({ kind: "note", id: `out:${n.path}`, node: n, context: n.preview, level: 2, parent: "out" });
    for (const t of c.missing) rows.push({ kind: "missing", id: `missing:${t}`, title: t, level: 2, parent: "out" });
  });
  section("mentions", "Mentions", c.mentions.length, () => {
    for (const m of c.mentions) rows.push({ kind: "mention", id: `mention:${m.node.path}`, mention: m, level: 2, parent: "mentions" });
  });
  section("tags", "Shared tags", c.tags.length, () => {
    for (const g of c.tags) {
      const id = `tag:${g.tag}`;
      const open = !closed.has(id);
      rows.push({ kind: "tag", id, tag: g.tag, count: g.count, open, level: 2, parent: "tags" });
      if (!open) continue;
      for (const n of g.notes.slice(0, TAG_SHOWN)) rows.push({ kind: "note", id: `${id}:${n.path}`, node: n, context: n.preview, level: 3, parent: id });
      if (g.count > Math.min(g.notes.length, TAG_SHOWN)) rows.push({ kind: "more", id: `${id}:more`, tag: g.tag, count: g.count, level: 3, parent: id });
    }
  });
  return rows;
}

export type Step = { to: number } | { toggle: string; open: boolean } | null;

/** ↑/↓ move over every row (headers included); → opens a closed group, ← closes an open one or goes to the parent. */
export function stepRelated(rows: RelatedRow[], cur: number, key: string): Step {
  const row = rows[cur];
  if (!row) return null;
  if (key === "ArrowDown") return cur < rows.length - 1 ? { to: cur + 1 } : null;
  if (key === "ArrowUp") return cur > 0 ? { to: cur - 1 } : null;
  if (key === "Home") return cur > 0 ? { to: 0 } : null;
  if (key === "End") return cur < rows.length - 1 ? { to: rows.length - 1 } : null;
  const group = row.kind === "section" || row.kind === "tag" ? row : null;
  if (key === "ArrowRight") {
    if (group && !group.open) return { toggle: group.id, open: true };
    return group ? (cur < rows.length - 1 ? { to: cur + 1 } : null) : null;
  }
  if (key === "ArrowLeft") {
    if (group && group.open) return { toggle: group.id, open: false };
    if (row.kind === "section") return null;
    const parent = rows.findIndex((r) => r.id === row.parent);
    return parent >= 0 ? { to: parent } : null;
  }
  return null;
}

/** The note's name from its path, for the trail row. */
export const stem = (path: string): string => path.replace(/^.*[\\/]/, "").replace(/\.md(\.age)?$/, "");

export const dateText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
