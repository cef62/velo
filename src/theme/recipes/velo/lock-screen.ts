import { defineSlotRecipe } from '@pandacss/dev'

// Shown in the editor area when the open note is locked: icon, "This note is locked",
// passphrase input + Unlock, inline error (role=alert). Focus goes to the input on open;
// Enter unlocks, Esc returns focus to the list. Creating a lock keeps the confirm dialog.
export const lockScreen = defineSlotRecipe({
  className: 'lockScreen',
  slots: ['root', 'card', 'icon', 'title', 'row'],
  base: {
    root: { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', bg: 'velo.canvas' },
    card: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3', w: '320px', maxW: 'calc(100% - 32px)', textAlign: 'center' },
    icon: { w: '40px', h: '40px', borderRadius: 'l3', bg: 'velo.accentSubtle', color: 'velo.accentText', display: 'flex', alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: '15px', fontWeight: '600', color: 'velo.fg' },
    row: { display: 'flex', gap: '2', w: 'full' },
  },
})
