import { defineRecipe } from '@pandacss/dev'

/**
 * Search-match highlight inside row titles/snippets: <mark class={searchMatch()}>.
 * Lists put data-active="true" on the list while it (or the field driving it) has focus, and data-selected="true" on the selected row.
 */
export const searchMatch = defineRecipe({
  className: 'searchMatch',
  base: {
    bg: 'velo.matchBg',
    color: 'velo.matchFg',
    fontWeight: '600',
    borderRadius: '2px',
    px: '1px',
    '[data-selected=true] &': { bg: 'velo.matchOnIdleBg', color: 'velo.matchOnIdleFg' }, // selected, focus elsewhere
    '[data-active=true] [data-selected=true] &': { bg: 'velo.matchOnSelectionBg', color: 'velo.matchOnSelectionFg' }, // focused selection (more specific, wins)
  },
})
