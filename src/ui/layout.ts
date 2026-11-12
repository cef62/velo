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

// Pane bar: a label shows in full or not at all (never truncated), and nothing clips or shrinks from MIN_LIST_W (216 px) up.
// The thresholds are measured in the demo with the widest content the bar may hold, not with typical content:
//  - note count: noteCount() caps it at 5 characters ("9,999" is the widest, then "10K" ... "99K"); it is hidden while the tabs are icon-only;
//  - Tasks due badge: dueText() caps it at "99+"; it shows in every mode;
//  - widest menu labels, found by measuring every one: Sort "Title A→Z" (wider than "Recent"); timeline "Updated · 30d"
//    (wider than "Created · 30d", "Updated · All" and every 7d label). The sort and timeline labels are the ones that were
//    truncated in review when only "Recent" and the default timeline label were measured.
// Per mode [tabs keep the active label from, controls labelled from (tabs 'active'), controls labelled from (tabs 'all')],
// each the first width where a sweep of 216-600 px (3 modes, every sort and timeline label, 99,999 notes, 999 due) shows no
// clipped, truncated or shrunken item, plus 2 px. Last failing width -> threshold:
//   Notes    267 + 2 = 269 (Recent) · 354 + 2 = 357 (Title A→Z, 9,999) · 457 + 2 = 460 (Title A→Z, 9,999)
//   Tasks    232 + 2 = 235 (icon-only Show done shrinks) · 306 + 2 = 308 · 408 + 2 = 410
//   Timeline 268 + 2 = 271 · 365 + 2 = 368 (Updated · 30d)        · 453 + 2 = 456 (Updated · 30d)
// Below the first number the tabs go icon-only; the narrowest pane (MIN_LIST_W) fits that for every mode.
const PANE_FULL = { notes: [269, 357, 460], tasks: [235, 308, 410], timeline: [271, 368, 456] } as const
/** Notes count beside the tabs: at most 5 characters whatever the vault size; never rounds up (10,500 -> "10K"). */
export const noteCount = (n: number) => (n < 10000 ? n.toLocaleString('en-US') : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0, roundingMode: 'trunc' } as Intl.NumberFormatOptions).format(n)) // roundingMode is missing from the TS lib
/** The exact total with its unit, as the count would read uncapped. */
export const notesText = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'note' : 'notes'}`
/** Extra text for the Notes tab (tooltip, accessible name) when the count beside the tabs is hidden or capped; else ''. */
export const notesExtra = (total: number, shown: boolean) => (total > 0 && (!shown || total >= 10000) ? notesText(total) : '')
/** Extra text for the Tasks tab tooltip when the badge is capped; else ''. */
export const dueExtra = (n: number) => (n > 99 ? `${n.toLocaleString('en-US')} due` : '')
/** Due badge text: at most 3 characters. */
export const dueText = (n: number) => (n > 99 ? '99+' : String(n))
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
