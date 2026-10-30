import { defineSlotRecipe } from '@pandacss/dev'

// Command palette (⌘P): Park UI Dialog for the shell + Ark Combobox (or a plain input + listbox)
// for the list. Actions only; notes stay in the search field.
// Items: label (query matches in <mark>), optional context ("Velo roadmap", "select text first"),
// the live binding as <Kbd>. Disabled items stay listed with their reason.
export const commandPalette = defineSlotRecipe({
  className: 'commandPalette',
  slots: ['content', 'inputRow', 'input', 'list', 'item', 'context', 'footer'],
  base: {
    content: {
      w: 'palette',
      maxW: 'calc(100vw - 32px)',
      mt: '10vh',
      bg: 'velo.panel',
      borderWidth: '1px',
      borderColor: 'velo.border',
      borderRadius: 'l3',
      boxShadow: 'veloPopover',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    },
    inputRow: { display: 'flex', alignItems: 'center', gap: '2.5', h: '48px', px: '3.5', borderBottomWidth: '1px', borderColor: 'velo.muted', color: 'velo.fgMuted' },
    input: { flex: '1', bg: 'transparent', border: '0', outline: '0', fontSize: '15px', color: 'velo.fg', _placeholder: { color: 'velo.fgMuted' } },
    list: { p: '1.5', maxH: '360px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1px' },
    item: {
      display: 'flex',
      alignItems: 'center',
      gap: '2.5',
      h: '34px',
      px: '2.5',
      borderRadius: 'l2',
      fontSize: 'ui',
      color: 'velo.fg',
      cursor: 'default',
      '& mark': { bg: 'transparent', color: 'inherit', fontWeight: '700' },
      '& [data-part=kbd]': { ml: 'auto' },
      '&[data-highlighted]': {
        bg: 'velo.selection',
        color: 'velo.selectionFg',
        '& .commandPalette__context': { color: 'velo.selectionMuted' },
        '& [data-part=kbd]': { bg: 'transparent', color: 'velo.selectionFg', borderColor: 'velo.selectionMuted', boxShadow: 'none' },
      },
      '&[data-disabled]': { opacity: '0.45' },
    },
    context: { fontSize: 'uiSm', color: 'velo.fgMuted', ml: '2' },
    footer: { display: 'flex', alignItems: 'center', gap: '3.5', h: '34px', px: '3.5', borderTopWidth: '1px', borderColor: 'velo.muted', fontSize: 'uiXs', color: 'velo.fgMuted' },
  },
})
