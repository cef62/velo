// v2 responsive rules (design/park-ui/v2/README.md §7), decided per component from its own width
// (ResizeObserver), not from the window: vertical / horizontal layout and the divider position just work.
// Width thresholds are component widths; the pixel sizes live in panda.config.ts (sizes.paneBar, searchMin, …).
const W = {
  paneLabelsAll: 380, // left pane ≥ this: every tab shows its label; else only the active one
  noteViewMenu: 560, // note < this: the Rich · Plain · Preview switch becomes a menu button
  noteLockInMenu: 420, // note < this: Lock moves into the ⋯ note menu
  noteRenameHint: 800, // note < this: the ↩ Rename / Esc Cancel hint goes, the title input needs the room
  noteMinWithPanel: 480, // docking the side panel would leave the note below this: overlay instead
  headerHideHint: 720, // window < this: hide the ⌘L hint in the search field
} as const

// Pane bar labels show in full or not at all (never truncated). Widths measured in the demo with the archive toggle present, plus
// slack for a 5-digit note count (+24), a 2-digit due badge (+8) and the widest timeline label "Updated · 30d" (+4).
// Per mode [tabs keep the active label from, controls labelled from (tabs 'active'), controls labelled from (tabs 'all')]:
//   Notes    239 (+24) = 263 · 307 (+24) = 331 · 409 (+24) = 433
//   Tasks    219 (+8)  = 227 · 293 (+8)  = 301 · 396 (+8)  = 404
//   Timeline 260 (+4)  = 264 · 344 (+16) = 360 · 431 (+16) = 447
// Below the first number the tabs go icon-only; the narrowest pane (MIN_LIST_W) fits that for every mode.
const PANE_FULL = { notes: [263, 331, 433], tasks: [227, 301, 404], timeline: [264, 360, 447] } as const
export type PaneBarTab = keyof typeof PANE_FULL

export type PaneBarMode = { labels: 'all' | 'active' | 'none'; menusIconOnly: boolean }
export type TitleBarMode = { viewSwitch: 'segments' | 'menu'; lockInMenu: boolean; renameHint: boolean; hideActions: boolean }

/** Left pane bar: every tab labelled when there is room, else only the selected one. */
export const paneBarMode = (paneWidth: number, tab: PaneBarTab = 'notes'): PaneBarMode => {
  const [tabs, controls, controlsAll] = PANE_FULL[tab]
  const labels = paneWidth >= W.paneLabelsAll ? 'all' : paneWidth >= tabs ? 'active' : 'none'
  return { labels, menusIconOnly: paneWidth < (labels === 'all' ? controlsAll : controls) }
}

/** Note title bar: Rich · Plain · Preview segments, or one "Rich ▾" menu button; Lock folds into ⋯ last. */
export const titleBarMode = (noteWidth: number, renaming = false): TitleBarMode => ({
  viewSwitch: noteWidth >= W.noteViewMenu ? 'segments' : 'menu',
  lockInMenu: noteWidth < W.noteLockInMenu,
  renameHint: noteWidth >= W.noteRenameHint,
  // any click on an action blurs the input and cancels the rename, so while renaming a narrow bar drops them for the input
  hideActions: renaming && noteWidth < W.noteLockInMenu,
})

/** Side panel docks beside the note unless that would squeeze the note under 480 px; then it overlays. */
export const sidePanelMode = (noteWidthWithoutPanel: number, panelWidth = 300): 'docked' | 'overlay' =>
  noteWidthWithoutPanel - panelWidth >= W.noteMinWithPanel ? 'docked' : 'overlay'

/** Header: one row always; only the ⌘L hint drops on narrow windows. */
export const showSearchHint = (windowWidth: number) => windowWidth >= W.headerHideHint
