import type { AppState } from "../app/store";

export type PaneTab = Extract<AppState["paneMode"], "notes" | "tasks" | "timeline">;

/** The left pane's tabs, in order (Connections has no tab: it leaves the pane in a later step). */
export const PANE_TABS: readonly PaneTab[] = ["notes", "tasks", "timeline"];

/** ←/→ (or Home/End) on the tablist: the next tab, clamped at the ends; null for other keys. */
export function stepPaneTab(cur: PaneTab, key: string): PaneTab | null {
  const i = PANE_TABS.indexOf(cur);
  const to = key === "ArrowRight" ? i + 1 : key === "ArrowLeft" ? i - 1 : key === "Home" ? 0 : key === "End" ? PANE_TABS.length - 1 : -1;
  return to < 0 || to >= PANE_TABS.length || to === i ? null : PANE_TABS[to];
}
