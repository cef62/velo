import { defineSlotRecipe } from '@pandacss/dev'

// Right-hand side panel with two tabs: Related · Info (⌘⇧C opens Related, ⌘I toggles the panel).
// docked: beside the note. overlay: over the note when docking would leave it < 480 px (Esc closes).
export const sidePanel = defineSlotRecipe({
  className: 'sidePanel',
  slots: ['root', 'tabs', 'tab', 'body'],
  base: {
    root: {
      w: 'sidePanel',
      flex: 'none',
      display: 'flex',
      flexDirection: 'column',
      minH: '0',
      bg: 'velo.chrome',
      boxShadow: 'inset 0 1px 0 {colors.velo.highlight}', // clear surface (§12)
      borderLeftWidth: '1px',
      borderColor: 'velo.divider',
    },
    tabs: { display: 'flex', alignItems: 'center', gap: '0.5', h: '40px', px: '2', borderBottomWidth: '1px', borderColor: 'velo.muted', flex: 'none' },
    tab: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      h: '40px',
      px: '2',
      mb: '-1px',
      borderBottom: '2px solid transparent',
      color: 'velo.fgMuted',
      fontSize: 'ui',
      fontWeight: '500',
      cursor: 'pointer',
      '&[aria-selected=true]': { color: 'velo.fg', borderBottomColor: 'velo.accent' },
      _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
    },
    body: { flex: '1', minH: '0', overflowY: 'auto', px: '1.5', pt: '1', pb: '2.5' },
  },
  variants: {
    mode: {
      docked: {},
      overlay: { root: { position: 'absolute', top: '{sizes.titleBar}', right: '0', bottom: '0', zIndex: '4', boxShadow: 'veloPopover', w: '280px' } }, // under the title bar: its controls stay reachable
    },
  },
  defaultVariants: { mode: 'docked' },
  staticCss: [{ mode: ['docked', 'overlay'] }],
})
