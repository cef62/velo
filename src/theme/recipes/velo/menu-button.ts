import { defineRecipe } from '@pandacss/dev'

// Quiet trigger for a Park UI Menu inside bars: "Recent ▾", "Updated · 30d ▾", "Rich ▾".
// Also used as a toggle ("Show done") with aria-pressed.
export const menuButton = defineRecipe({
  className: 'menuButton',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '1',
    h: 'paneTab',
    pl: '2',
    pr: '1.5',
    borderRadius: 'l2',
    color: 'velo.fgMuted',
    fontSize: 'uiSm',
    fontWeight: '500',
    whiteSpace: 'nowrap',
    flex: '0 1 auto', // shrinks before the bar overflows; the label truncates
    minW: '0',
    '& [data-label]': { truncate: true, minW: '0' },
    cursor: 'pointer',
    _hover: { bg: 'velo.muted', color: 'velo.fg' },
    '&[aria-expanded=true], &[aria-pressed=true]': { bg: 'velo.accentSubtleHover', color: 'velo.accentText', boxShadow: 'inset 0 0 0 1px {colors.velo.hairline}, inset 0 1px 0 {colors.velo.highlight}' },
    _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
    '& svg': { w: '14px', h: '14px', flex: 'none' },
  },
  variants: {
    iconOnly: { true: { px: '1', flex: 'none', '& [data-label], & [data-chevron]': { display: 'none' } } }, // never shrinks below its icon
  },
  staticCss: [{ iconOnly: ['true'] }],
})
