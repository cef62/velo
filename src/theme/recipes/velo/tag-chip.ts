import { defineSlotRecipe } from '@pandacss/dev'
import { focusRing } from './focus-ring'

// Toggle button "#tag 12" in the Filters panel.
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
      borderColor: 'velo.inputBorder',
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
      true: { root: { bg: 'velo.accent', borderColor: 'velo.accent', color: 'velo.accentFg' }, count: { color: 'velo.accentFg' } },
      false: { root: { _hover: { bg: 'velo.subtle' } } },
    },
    // saved-search chips are dashed until applied (v2 §3 #10)
    kind: {
      tag: {},
      saved: { root: { borderStyle: 'dashed', '&[aria-pressed=true]': { borderStyle: 'solid' } } },
    },
  },
  defaultVariants: { selected: false, kind: 'tag' },
  // callers pass the variants as variables, which Panda can't extract: emit every state
  staticCss: [{ selected: ['true', 'false'], kind: ['tag', 'saved'] }],
})
