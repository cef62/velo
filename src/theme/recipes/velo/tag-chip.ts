import { defineSlotRecipe } from '@pandacss/dev'
import { focusRing } from './focus-ring'

// Toggle button "#tag 12" in the tag panel.
export const tagChip = defineSlotRecipe({
  className: 'tagChip',
  slots: ['root', 'count'],
  base: {
    root: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      h: '26px',
      px: '2.5',
      borderRadius: 'full',
      borderWidth: '1px',
      borderColor: 'velo.border',
      bg: 'velo.canvas',
      color: 'velo.fg',
      fontSize: 'uiSm',
      fontWeight: '500',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      ...focusRing,
    },
    count: { color: 'velo.fgMuted', fontWeight: '400', fontVariantNumeric: 'tabular-nums' },
  },
  variants: {
    selected: {
      true: { root: { bg: 'velo.accent', borderColor: 'velo.accent', color: 'white' }, count: { color: 'white' } },
      false: { root: { _hover: { bg: 'velo.subtle' } } },
    },
  },
  defaultVariants: { selected: false },
  // callers pass `selected` as a variable, which Panda can't extract: emit both states
  staticCss: [{ selected: ['true', 'false'] }],
})
