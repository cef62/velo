// v2 token changes. Merge into panda.config.ts (theme.extend.tokens).
// No color token changes: every v2 surface uses the existing velo.* semantic colors.

export const v2Sizes = {
  paneBar: { value: '36px' }, // left pane bar: mode tabs + that mode's controls
  paneTab: { value: '28px' }, // tab / menu-button height inside pane bars (= controlSm)
  sidePanel: { value: '300px' }, // Related · Info panel, docked
  searchMax: { value: '680px' }, // the header search stops growing here
  searchMin: { value: '180px' }, // and never shrinks below this
  palette: { value: '560px' }, // command palette width
  relatedRow: { value: '44px' }, // min height of a Related row (title + context line)
}

// Breakpoints are component widths, not window widths: each part decides from its own box
// (ResizeObserver), so vertical / horizontal layout and the divider position all just work.
export const v2Widths = {
  paneLabelsAll: 380, // left pane ≥ this: every tab shows its label; else only the active one
  paneSortIconOnly: 240, // left pane < this: Sort / Timeline menu buttons go icon-only
  noteViewMenu: 560, // note < this: the Rich · Plain · Preview switch becomes a menu button
  noteLockInMenu: 420, // note < this: Lock moves into the ⋯ note menu
  noteMinWithPanel: 480, // docking the side panel would leave the note below this: overlay instead
  headerHideHint: 720, // window < this: hide the ⌘L hint in the search field
} as const
