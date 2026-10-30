import { defineRecipe } from '@pandacss/dev'

// Banners: conflict (neutral), filter line, update, preview strip.
export const banner = defineRecipe({
  className: 'banner',
  base: { display: 'flex', alignItems: 'center', gap: '2.5', flex: 'none', fontSize: 'ui' },
  variants: {
    tone: {
      conflict: {
        py: '2',
        px: '5',
        bg: 'velo.warningBg',
        borderBottomWidth: '1px',
        borderColor: 'velo.warningBorder',
        color: 'velo.warningFg',
        '& a': { color: 'velo.warningFg', fontWeight: '600', textDecoration: 'underline', textUnderlineOffset: '2px' },
      },
      filter: {
        h: '30px',
        px: '3.5',
        gap: '1.5',
        bg: 'velo.accentSubtle',
        borderBottomWidth: '1px',
        borderColor: 'velo.accentHalo',
        color: 'velo.fgMuted',
        fontSize: 'uiSm',
        '& b': { fontWeight: '500', color: 'velo.accentText' },
      },
      update: {
        py: '2',
        px: '5',
        bg: 'velo.accentSubtle',
        borderBottomWidth: '1px',
        borderColor: 'velo.accentHalo',
        color: 'velo.accentText',
        '& a': { color: 'velo.accentText', fontWeight: '600', textDecoration: 'underline', textUnderlineOffset: '2px' },
      },
      preview: {
        h: '30px',
        px: '5',
        gap: '2',
        bg: 'velo.accentSubtle',
        borderBottomWidth: '1px',
        borderColor: 'velo.accentHalo',
        color: 'velo.accentText',
        fontSize: 'uiSm',
        fontWeight: '500',
      },
    },
  },
  defaultVariants: { tone: 'conflict' },
})
