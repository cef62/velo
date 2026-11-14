import { defineSlotRecipe } from '@pandacss/dev'

// Note title bar: title (or inline rename input in its place), save status, right-hand actions.
export const titleBar = defineSlotRecipe({
  className: 'titleBar',
  slots: ['root', 'title', 'status', 'actions'],
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '3',
      h: 'titleBar',
      pl: '5',
      pr: '2.5', // icon buttons sit at the edge (v2 §7)
      borderBottomWidth: '1px',
      borderColor: 'velo.muted',
      bg: 'velo.canvas',
      minW: '0',
      flex: 'none',
    },
    title: {
      fontSize: 'var(--velo-title-fs)',
      fontWeight: '650',
      letterSpacing: '-0.01em',
      lineHeight: '1.2',
      color: 'velo.fg',
      truncate: true,
      flex: '1',
      minW: 'min(12ch, 25%)', // the title yields second: the message cannot squeeze it below 12 characters or a quarter of the bar; a fixed floor pushed the actions out at the 600 px window and the largest font
    },
    status: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      flex: '0 1 auto', // the message yields first (title is flex 1 1 0): it shrinks, its text truncates
      minW: '0',
      overflow: 'hidden',
      '&[data-tone=error]': { color: 'velo.danger' },
    },
    actions: { display: 'inline-flex', alignItems: 'center', gap: '1', flex: 'none' },
  },
})
