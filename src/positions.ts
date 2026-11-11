// Cursor and scroll position per note, so a note reopens where it was left. One localStorage entry, a
// per-machine convenience in LRU order: losing it only means notes open at the top.

/** Selection anchor and head, top-visible document offset, and that line's pixel offset from the top edge. */
export type Pos = { a: number; h: number; t: number; m: number };

const KEY = "velo.positions";
export const MAX = 50;

const read = (): [string, Pos][] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    const ok = (p: any) => p && ["a", "h", "t", "m"].every((k) => Number.isFinite(p[k]));
    return Array.isArray(v) ? v.filter((e) => Array.isArray(e) && typeof e[0] === "string" && ok(e[1])) : [];
  } catch { return []; }
};
const write = (l: [string, Pos][]) => { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* storage blocked: positions just aren't remembered */ } };

export const getPos = (path: string): Pos | undefined => read().find(([p]) => p === path)?.[1];
export const setPos = (path: string, pos: Pos) => write([...read().filter(([p]) => p !== path), [path, pos] as [string, Pos]].slice(-MAX));
export const dropPos = (path: string) => write(read().filter(([p]) => p !== path));
export const renamePos = (from: string, to: string) => {
  const pos = getPos(from);
  if (pos) { dropPos(from); setPos(to, pos); }
};
const c = (n: number, len: number) => Math.max(0, Math.min(n, len));
/** Offsets capped to a document of `len` characters (the note changed since the position was stored). */
export const clampPos = (p: Pos, len: number): Pos => ({ ...p, a: c(p.a, len), h: c(p.h, len), t: c(p.t, len) });
