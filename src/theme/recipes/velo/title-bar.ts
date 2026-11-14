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
      '&[data-compact]': { pl: '3', gap: '2' }, // a status on a narrow bar: titleBarFit budgets with these
    },
    title: {
      fontSize: 'var(--velo-title-fs)',
      fontWeight: '650',
      letterSpacing: '-0.01em',
      lineHeight: '1.2',
      color: 'velo.fg',
      truncate: true,
      flex: '1 1 auto', // natural width, so the message (shrink 1000, below) gives way first; it grows to push the actions right
      minW: '36px', // the title yields after the message and the archived badge, down to this (width budget: titleBarFit in ui/layout.ts)
    },
    status: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      flex: '0 1000 auto', // the message yields first: it shrinks (1000x the title's rate) down to its floor, its text truncates
      minW: '16px', // icon only (titleBarFit)
      '&[data-text]': { minW: '50px' }, // icon, a few characters and an ellipsis
      overflow: 'hidden',
      '&[data-tone=error]': { color: 'velo.danger' },
    },
    actions: { display: 'inline-flex', alignItems: 'center', gap: '1', flex: 'none' },
  },
})
