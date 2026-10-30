import { defineRecipe } from '@pandacss/dev'
import { focusRing } from './focus-ring'

/** Header "Preview" indicator when preview is on (off = plain ghost iconButton with eye). */
export const previewPill = defineRecipe({
  className: 'previewPill',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '1.5',
    h: 'controlSm',
    px: '2.5',
    borderRadius: 'l2',
    bg: 'velo.accent',
    color: 'velo.accentFg',
    fontSize: 'uiSm',
    fontWeight: '600',
    flex: 'none',
    cursor: 'pointer',
    '&::before': { content: '""', w: '6px', h: '6px', borderRadius: 'full', bg: 'velo.accentFg' },
    _hover: { bg: 'velo.accentHover' },
    ...focusRing,
  },
})
