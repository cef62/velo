import { NONE, type Action } from "../shortcuts";

/** Each action whose binding another action also uses, mapped to that other action. "none" is never a conflict. */
export function conflictsOf(draft: Record<Action, string>): Partial<Record<Action, Action>> {
  const actions = Object.keys(draft) as Action[];
  const out: Partial<Record<Action, Action>> = {};
  for (const a of actions) {
    const other = draft[a] === NONE ? undefined : actions.find((b) => b !== a && draft[b] === draft[a]);
    if (other) out[a] = other;
  }
  return out;
}
