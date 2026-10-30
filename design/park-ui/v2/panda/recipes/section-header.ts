import { defineRecipe } from '@pandacss/dev'

// One group header for every list: Tasks groups, Timeline days, Related sections, Info sections, palette groups.
// In Related it is a collapsible treeitem (button with aria-expanded); elsewhere a plain label.
export const sectionHeader = defineRecipe({
  className: 'sectionHeader',
  base: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5',
    w: 'full',
    pt: '2.5',
    pb: '1',
    px: '2.5',
    fontSize: 'uiXs',
    fontWeight: '600',
    lineHeight: '1',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'velo.fgMuted',
    textAlign: 'left',
    borderRadius: 'l2',
    '& [data-count]': { fontWeight: '500', letterSpacing: '0' },
    '& svg': { w: '12px', h: '12px', transition: 'transform 120ms' },
    '&[aria-expanded=false] svg': { transform: 'rotate(-90deg)' },
    _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
  },
})

// Small count pill: due tasks on the Tasks tab (danger), totals on the Related tab (neutral).
export const countBadge = defineRecipe({
  className: 'countBadge',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minW: '18px',
    h: '18px',
    px: '1.5',
    borderRadius: 'full',
    fontSize: 'uiXs',
    fontWeight: '600',
    lineHeight: '1',
    fontVariantNumeric: 'tabular-nums',
  },
  variants: {
    tone: {
      danger: { bg: 'velo.dangerSubtle', color: 'velo.danger' }, // 4.5:1 light, 7.8:1 dark
      neutral: { bg: 'velo.muted', color: 'velo.fgMuted' },
    },
  },
  defaultVariants: { tone: 'neutral' },
  staticCss: [{ tone: ['danger', 'neutral'] }],
})
