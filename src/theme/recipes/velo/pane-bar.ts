import { defineSlotRecipe } from '@pandacss/dev'

// The bar on top of the left pane, same for every mode (Notes · Tasks · Timeline):
// mode tabs on the left, that mode's controls on the right.
// Markup: <div root><div tabs role="tablist"><button tab role="tab" aria-selected>…</button>…</div>
//         <span spacer/><span meta>1,204</span>{mode controls}</div>
// Keyboard: the tablist is one Tab stop (roving tabindex), ←/→ move, Enter/Space select.
export const paneBar = defineSlotRecipe({
  className: 'paneBar',
  slots: ['root', 'tabs', 'tab', 'spacer', 'meta'],
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '1',
      h: 'paneBar',
      px: '1.5',
      borderBottomWidth: '1px',
      borderColor: 'velo.muted',
      bg: 'velo.canvas',
      flex: 'none',
      minW: '0',
      overflow: 'hidden', // a narrow column clips instead of spilling under the note
    },
    tabs: { display: 'flex', alignItems: 'center', gap: '0.5', flex: 'none' },
    tab: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      h: 'paneTab',
      px: '2',
      borderRadius: 'l2',
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      fontWeight: '500',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      _hover: { bg: 'velo.muted', color: 'velo.fg' },
      '&[aria-selected=true]': { bg: 'velo.accentSubtleHover', color: 'velo.accentText', boxShadow: 'inset 0 0 0 1px {colors.velo.hairline}, inset 0 1px 0 {colors.velo.highlight}' }, // pressed look, clear (§12)
      _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
      '& svg': { w: '14px', h: '14px', flex: 'none' },
    },
    spacer: { flex: '1 1 0', minW: '0' },
    meta: { fontSize: 'uiSm', color: 'velo.fgMuted', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  },
  variants: {
    // labels: all tabs labelled (pane ≥ 380 px) or only the selected one
    labels: {
      all: {},
      active: { tab: { '&[aria-selected=false] [data-label]': { display: 'none' }, '&[aria-selected=false]': { px: '1.5' } } },
      none: { tab: { '& [data-label]': { display: 'none' }, px: '1.5' } }, // < 240px: icons only, so the mode controls still fit
    },
  },
  defaultVariants: { labels: 'all' },
  staticCss: [{ labels: ['all', 'active', 'none'] }],
})
