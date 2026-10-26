import { formatBinding, NONE, type Action } from "../shortcuts";

export type HeaderMode = "full" | "compact" | "folded";

/** README "Small window": ≥ 900 full, 720–899 icon-only segments, < 720 actions fold into ⋯. */
export const headerMode = (width: number): HeaderMode => (width >= 900 ? "full" : width >= 720 ? "compact" : "folded");

/** Hints at the right of the search field. */
export function searchHint(s: { query: string; sel: number; exactTitleMatch: boolean; keys: Record<Action, string>; isMac: boolean }): string[] {
  if (s.query === "") return s.keys.focus_search === NONE ? [] : [formatBinding(s.keys.focus_search, s.isMac)];
  const [enter, shiftEnter] = s.isMac ? ["↩", "⇧↩"] : ["Enter", "Shift+Enter"];
  const out: string[] = [];
  if (s.sel >= 0) out.push(`${enter} Open`);
  if (!s.exactTitleMatch) out.push(`${shiftEnter} Create`);
  return out;
}
