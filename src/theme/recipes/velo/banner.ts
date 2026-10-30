import { defineRecipe } from '@pandacss/dev'

// Banner: only the conflict one is left (v2 §6); filters are chips in the search field, updates a header pill.
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
    },
  },
  defaultVariants: { tone: 'conflict' },
})
