import { defineRecipe } from '@pandacss/dev'

/** Search-match highlight inside row titles/snippets: <mark class={searchMatch()}>. Rows set data-selected="true" when `selected`. */
export const searchMatch = defineRecipe({
  className: 'searchMatch',
  base: {
    bg: 'velo.accentHalo',
    color: 'inherit',
    borderRadius: '2px',
    px: '1px',
    '[data-selected=true] &': { bg: 'rgba(255,255,255,.24)', color: 'white' },
  },
})
