import type { SavedSearch } from "./api";
import { sameFilters, type Filters } from "./saved";

/** A chip inside the search field (v2 §3 #9): the applied saved search as one chip, else one per tag and the No links chip. */
export type Chip = { kind: "saved"; label: string; name: string } | { kind: "tag"; label: string; tag: string } | { kind: "nolinks"; label: string };

export function chipsFor(saved: SavedSearch[], f: Filters): Chip[] {
  const s = saved.find((x) => sameFilters(x, f));
  if (s) return [{ kind: "saved", label: s.name, name: s.name }];
  return [...f.tags.map((tag): Chip => ({ kind: "tag", label: `#${tag}`, tag })), ...(f.noLinks ? [{ kind: "nolinks" as const, label: "No links" }] : [])];
}

export const TEXT_MIN = 160; // px of typing room the chips must leave, else they collapse into one

/**
 * How many chips show in a field `fieldW` px wide given each chip's width (+ `gap` between them):
 * at most half the field; the rest fold into a dashed "+N". While typing, if the chips would leave
 * under TEXT_MIN px for the text, every chip collapses into one "N filters" chip (`collapse`).
 */
export function chipLayout(fieldW: number, widths: number[], typing: boolean, gap = 4): { shown: number; folded: number; collapse: boolean } {
  const n = widths.length;
  if (n === 0) return { shown: 0, folded: 0, collapse: false };
  const half = fieldW / 2;
  let shown = 0;
  let used = 0;
  for (const w of widths) {
    const next = used + w + (shown ? gap : 0);
    if (next > half) break;
    used = next;
    shown++;
  }
  const folded = n - shown;
  if (folded) used += (shown ? gap : 0) + 36; // the "+N" chip
  const collapse = typing && (shown === 0 || fieldW - used < TEXT_MIN);
  return collapse ? { shown: 0, folded: n, collapse: true } : { shown, folded, collapse: false };
}
