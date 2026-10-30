import { defineRecipe } from '@pandacss/dev'

// Active filter inside the search field: "#work ×", or a saved search "▮ Weekly review ×".
// Replaces the "Filtered by …" banner. Backspace at caret 0 removes the last chip;
// the × is a real button (aria-label "Remove #work"), reachable with Tab.
export const searchChip = defineRecipe({
  className: 'searchChip',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5',
    h: '22px',
    pl: '1.5',
    pr: '0.5',
    borderRadius: 'full',
    fontSize: 'uiSm',
    fontWeight: '500',
    lineHeight: '1',
    whiteSpace: 'nowrap',
    flex: 'none',
    '& button': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      w: '18px',
      h: '18px',
      borderRadius: 'full',
      color: 'inherit',
      cursor: 'pointer',
      _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '0' },
    },
    '& svg': { w: '12px', h: '12px' },
  },
  variants: {
    kind: {
      tag: { bg: 'velo.accentSubtle', color: 'velo.accentText', '& button:hover': { bg: 'velo.accentHalo' } }, // 5.4:1 / 7.3:1
      saved: { bg: 'velo.muted', color: 'velo.fg', '& button:hover': { bg: 'velo.border' } },
    },
  },
  defaultVariants: { kind: 'tag' },
  staticCss: [{ kind: ['tag', 'saved'] }],
})
