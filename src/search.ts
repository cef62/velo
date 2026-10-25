import type { Hit } from "./api";

// Same rule as Rust text::fold: strip combining marks after NFD, lowercase.
export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function enterAction(query: string, hits: Hit[]): { kind: "open"; path: string } | { kind: "create"; title: string } | null {
  const q = query.trim();
  if (!q) return null;
  const exact = hits.find((h) => fold(h.title) === fold(q));
  return exact ? { kind: "open", path: exact.path } : { kind: "create", title: q };
}

export const moveSelection = (i: number, delta: number, len: number): number =>
  len === 0 ? -1 : Math.min(len - 1, Math.max(0, i + delta));
