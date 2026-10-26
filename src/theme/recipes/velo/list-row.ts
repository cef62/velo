import { defineSlotRecipe } from '@pandacss/dev'

// Fixed height for virtualization; heights come from CSS vars set by applyFontScale().
// `selected` = list/search has focus, `selectedIdle` = selected row while focus is in the editor.
export const listRow = defineSlotRecipe({
  className: 'listRow',
  slots: ['root', 'title', 'snippet', 'date', 'lock'],
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '2.5',
      px: '2.5',
      borderRadius: 'l2',
      color: 'velo.fg',
      fontSize: 'var(--velo-list-fs)',
      lineHeight: '1.2',
      minWidth: '0',
      boxSizing: 'border-box',
      cursor: 'default',
      // keyboard cursor when the list itself has focus (roving tabindex)
      _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
    },
    title: { fontWeight: '500', truncate: true, flex: '0 1 auto' },
    snippet: { color: 'velo.fgMuted', truncate: true, flex: '1 1 0', minWidth: '0', fontSize: 'var(--velo-snippet-fs)' },
    date: {
      color: 'velo.fgMuted',
      fontSize: 'var(--velo-date-fs)',
      fontVariantNumeric: 'tabular-nums',
      flex: 'none',
      ml: 'auto',
      pl: '2',
    },
    lock: { color: 'velo.fgMuted', display: 'inline-flex', flex: 'none', '& svg': { width: '14px', height: '14px' } },
  },
  variants: {
    layout: {
      // vertical window layout: title · snippet · date on one line
      compact: { root: { height: 'var(--velo-row-h)' }, title: { maxWidth: '48%' } },
      // horizontal window layout: title + date, then snippet
      twoLine: {
        root: { height: 'var(--velo-row2-h)', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: '1', px: '3' },
        title: { flex: '1 1 auto' },
        snippet: { flex: 'none', display: 'block' },
      },
    },
    state: {
      idle: { root: { _hover: { bg: 'velo.subtle' } } },
      selected: {
        root: { bg: 'velo.selection', color: 'velo.selectionFg' },
        snippet: { color: 'velo.selectionMuted' },
        date: { color: 'velo.selectionMuted' },
        lock: { color: 'velo.selectionMuted' },
      },
      selectedIdle: { root: { bg: 'velo.selectionIdle' } },
    },
  },
  defaultVariants: { layout: 'compact', state: 'idle' },
})
