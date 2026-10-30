import { fold } from "./search";

const WORD = /[\p{L}\p{N}]/u;

/** Match quality of folded query `q` in folded `f`: 5 exact, 4 prefix, 3 word-start, 2 substring, 1 in-order letters, 0 none. */
export function tier(q: string, f: string): number {
  if (f === q) return 5;
  if (f.startsWith(q)) return 4;
  let i = f.indexOf(q);
  if (i < 0) {
    let j = 0;
    for (const ch of f) if (ch === q[j] && ++j === q.length) return 1;
    return 0;
  }
  for (; i >= 0; i = f.indexOf(q, i + 1)) if (!WORD.test(f[i - 1])) return 3;
  return 2;
}

export type Ranked<T> = { item: T; f: string };

/** Fold the keys once (when a cache loads), not on every keystroke. */
export const prepare = <T>(items: T[], key: (t: T) => string): Ranked<T>[] => items.map((item) => ({ item, f: fold(key(item)) }));

/** Matches of folded `q`, best tier first, then by `tie`; at most `limit`. */
export function rank<T>(q: string, items: Ranked<T>[], tie: (a: T, b: T) => number, limit = 20): T[] {
  const hits: { item: T; t: number }[] = [];
  for (const r of items) {
    const t = tier(q, r.f);
    if (t) hits.push({ item: r.item, t });
  }
  return hits
    .sort((a, b) => b.t - a.t || tie(a.item, b.item))
    .slice(0, limit)
    .map((h) => h.item);
}
