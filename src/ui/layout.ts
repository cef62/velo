// v2 responsive rules (design/park-ui/v2/README.md §7), decided per component from its own width
// (ResizeObserver), not from the window: vertical / horizontal layout and the divider position just work.
// Width thresholds are component widths; the pixel sizes live in panda.config.ts (sizes.paneBar, searchMin, …).
const W = {
  paneLabelsAll: 380, // left pane ≥ this: every tab shows its label; else only the active one
  paneSortIconOnly: 240, // left pane < this: Sort / Timeline menu buttons go icon-only
  noteViewMenu: 560, // note < this: the Rich · Plain · Preview switch becomes a menu button
  noteLockInMenu: 420, // note < this: Lock moves into the ⋯ note menu
  noteMinWithPanel: 480, // docking the side panel would leave the note below this: overlay instead
  headerHideHint: 720, // window < this: hide the ⌘L hint in the search field
} as const

export type PaneBarMode = { labels: 'all' | 'active'; menusIconOnly: boolean }
export type TitleBarMode = { viewSwitch: 'segments' | 'menu'; lockInMenu: boolean }

/** Left pane bar: every tab labelled when there is room, else only the selected one. */
export const paneBarMode = (paneWidth: number): PaneBarMode => ({
  labels: paneWidth >= W.paneLabelsAll ? 'all' : 'active',
  menusIconOnly: paneWidth < W.paneSortIconOnly,
})

/** Note title bar: Rich · Plain · Preview segments, or one "Rich ▾" menu button; Lock folds into ⋯ last. */
export const titleBarMode = (noteWidth: number): TitleBarMode => ({
  viewSwitch: noteWidth >= W.noteViewMenu ? 'segments' : 'menu',
  lockInMenu: noteWidth < W.noteLockInMenu,
})

/** Side panel docks beside the note unless that would squeeze the note under 480 px; then it overlays. */
export const sidePanelMode = (noteWidthWithoutPanel: number, panelWidth = 300): 'docked' | 'overlay' =>
  noteWidthWithoutPanel - panelWidth >= W.noteMinWithPanel ? 'docked' : 'overlay'

/** Header: one row always; only the ⌘L hint drops on narrow windows. */
export const showSearchHint = (windowWidth: number) => windowWidth >= W.headerHideHint
