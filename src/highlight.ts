import { fold } from "./search";

/** Sorted, merged half-open ranges in `text` where any query term matches, compared through `fold`. */
export function highlightRanges(text: string, query: string): [number, number][] {
  const terms = query.split(/\s+/).map(fold).filter((t) => t.length > 0);
  if (!terms.length) return [];
  // Each folded code unit maps back to the original character it came from (folding may expand or drop chars).
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const f = fold(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) {
      from.push(at);
      to.push(at + ch.length);
    }
    at += ch.length;
  }
  const hits: [number, number][] = [];
  for (const term of terms) {
    for (let p = folded.indexOf(term); p !== -1; p = folded.indexOf(term, p + 1)) {
      hits.push([from[p], to[p + term.length - 1]]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of hits) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}
