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

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const UNESCAPES = Object.fromEntries(Object.entries(ESCAPES).map(([c, e]) => [e, c]));
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/** Wraps the query's matches in `<mark class={cls}>` inside markdown-it inline HTML (which escapes only &<>"), text only. */
export function markHtml(html: string, query: string, cls: string): string {
  return html
    .split(/(<[^>]*>)/)
    .map((seg, i) => {
      if (i % 2) return seg; // a tag
      const text = seg.replace(/&(amp|lt|gt|quot);/g, (e) => UNESCAPES[e]);
      const ranges = highlightRanges(text, query);
      if (!ranges.length) return seg;
      let out = "";
      let at = 0;
      for (const [s, e] of ranges) {
        out += escapeHtml(text.slice(at, s)) + `<mark class="${cls}">${escapeHtml(text.slice(s, e))}</mark>`;
        at = e;
      }
      return out + escapeHtml(text.slice(at));
    })
    .join("");
}
