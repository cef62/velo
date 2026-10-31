import { defineSlotRecipe } from '@pandacss/dev'

// A row in the Related tab: title + date, then the context line (the sentence that links / mentions,
// with the matched words in <b>). Space expands the peek (preview + dates) in place.
// role="treeitem" inside role="tree"; the tree is one Tab stop, ↑/↓ move, ←/→ collapse/expand.
export const relatedRow = defineSlotRecipe({
  className: 'relatedRow',
  slots: ['root', 'line', 'title', 'date', 'context', 'peek', 'actions'],
  base: {
    root: {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: '0.5',
      minH: 'relatedRow',
      py: '1.5',
      px: '2.5',
      borderRadius: 'l2',
      minW: '0',
      cursor: 'default',
      _hover: { bg: 'velo.muted' },
      '&[aria-selected=true]': { bg: 'velo.selectionIdle' }, // the open note: always the idle look, so the tree never sets data-active (matches use matchOnIdle*)
      _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
    },
    line: { display: 'flex', alignItems: 'baseline', gap: '2', minW: '0' },
    title: { fontSize: 'ui', fontWeight: '500', color: 'velo.fg', truncate: true, flex: '1 1 auto', minW: '0' },
    date: { fontSize: 'uiXs', color: 'velo.fgMuted', flex: 'none', fontVariantNumeric: 'tabular-nums' },
    context: { fontSize: 'uiSm', color: 'velo.fgMuted', truncate: true, '& b': { fontWeight: '600', color: 'velo.fg' } },
    peek: { fontSize: 'uiSm', lineHeight: '1.5', color: 'velo.fgMuted', lineClamp: '4', mt: '0.5' },
    actions: { display: 'flex', gap: '1.5', mt: '1' },
  },
  variants: {
    kind: {
      note: {},
      missing: { title: { color: 'velo.danger' } }, // [[target]] with no note: ⇧↩ creates it
      mention: {}, // unlinked mention: ⇧↩ (or the Link it button on hover/focus) links it
      nested: { root: { pl: '7' } }, // a note under a #tag group
    },
  },
  defaultVariants: { kind: 'note' },
  staticCss: [{ kind: ['note', 'missing', 'mention', 'nested'] }],
})
