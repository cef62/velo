// v2 responsive rules, decided per component from its own width (ResizeObserver), not from the window.
// Replaces src/ui/breakpoints.ts headerMode(): the header no longer has modes.
import { v2Widths as W } from './tokens'

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
