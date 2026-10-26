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
      px: '5',
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
      minW: '0',
    },
    status: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      flex: 'none',
      '&[data-tone=error]': { color: 'velo.danger' },
    },
    actions: { display: 'inline-flex', alignItems: 'center', gap: '1', flex: 'none' },
  },
})
