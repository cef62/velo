/**
 * Editor typography — shared by Plain, Rich and Preview.
 * Add to panda.config: `globalCss: { ...editorGlobalCss }`.
 *
 * Markup contract (produced by velo's editor / renderer):
 *   .velo-doc            reading column wrapper (Plain, Rich and Preview)
 *   .velo-doc.is-plain   Plain style: every syntax mark visible
 *   .md-mark             a syntax mark (#, **, _, >, -, [ ], [[ ]], ```, ---)
 *                        Rich: hidden except inside .is-active-line
 *   .is-active-line      the line holding the caret (Rich only)
 *   a.md-link            [text](url)
 *   a.md-wikilink        [[Note]]   — add .is-missing when no such note
 *   .md-tag              #tag      — chip in Rich/Preview, accent text in Plain
 *   li.md-task > input[type=checkbox]   clickable task
 */
export const editorGlobalCss = {
  '.velo-doc': {
    maxWidth: '46em',
    mx: 'auto',
    px: '40px',
    pt: '28px',
    pb: '40px',
    fontFamily: 'body',
    fontSize: 'var(--velo-editor-fs, 16px)',
    lineHeight: '1.7',
    color: 'velo.fg',
    caretColor: 'var(--colors-velo-accent)',
    '@media (max-width: 720px)': { px: '20px', pt: '18px' },

    '& h1': { fontSize: '1.6em', lineHeight: '1.25', fontWeight: '700', letterSpacing: '-0.015em', m: '0 0 0.55em' },
    '& h2': { fontSize: '1.22em', lineHeight: '1.3', fontWeight: '650', letterSpacing: '-0.01em', m: '1.3em 0 0.45em' },
    '& h3': { fontSize: '1.08em', lineHeight: '1.35', fontWeight: '650', m: '1.2em 0 0.4em' },
    '& p': { m: '0 0 0.85em' },
    '& ul, & ol': { m: '0 0 0.85em', pl: '1.4em' },
    '& li': { my: '0.12em' },
    '& li::marker': { color: 'velo.fgMuted' },
    '& li.md-task': { listStyle: 'none', ml: '-1.4em', display: 'flex', alignItems: 'flex-start', gap: '0.55em' },
    '& li.md-task > input[type=checkbox]': {
      w: '1em',
      h: '1em',
      mt: '0.36em',
      accentColor: 'var(--colors-velo-accent)',
      flex: 'none',
      cursor: 'pointer',
    },
    '& li.md-task.is-done > span': {
      color: 'velo.fgMuted',
      textDecoration: 'line-through',
      textDecorationColor: 'var(--colors-velo-grip)',
    },
    '& blockquote': {
      m: '0 0 0.85em',
      py: '0.05em',
      pl: '1em',
      borderLeft: '3px solid',
      borderColor: 'velo.accentHalo',
      color: 'velo.fgMuted',
    },
    '& pre': {
      fontFamily: 'mono',
      fontSize: '0.84em',
      lineHeight: '1.6',
      bg: 'velo.subtle',
      borderWidth: '1px',
      borderColor: 'velo.divider',
      borderRadius: 'l2',
      py: '0.75em',
      px: '1em',
      m: '0 0 0.85em',
      overflowX: 'auto',
    },
    '& code': { fontFamily: 'mono', fontSize: '0.86em', bg: 'velo.subtle', py: '0.1em', px: '0.35em', borderRadius: 'l1' },
    '& pre code': { bg: 'transparent', p: '0', fontSize: '1em' },
    '& hr': { border: '0', borderTop: '1px solid', borderColor: 'velo.border', my: '1.5em' },

    '& a.md-link': {
      color: 'velo.accentText',
      textDecoration: 'underline',
      textDecorationColor: 'var(--colors-velo-accent-line)',
      textUnderlineOffset: '3px',
    },
    '& a.md-wikilink': {
      color: 'velo.accentText',
      textDecoration: 'none',
      borderBottom: '1px solid',
      borderColor: 'velo.accentLine',
    },
    '& a.md-wikilink.is-missing': { color: 'velo.danger', borderBottomStyle: 'dashed', borderColor: 'velo.danger' },

    // #tags: chip in Rich + Preview, coloured text in Plain
    '& .md-tag': {
      display: 'inline-flex',
      alignItems: 'center',
      h: '1.45em',
      px: '0.45em',
      borderRadius: 'l1',
      bg: 'velo.accentSubtle',
      color: 'velo.accentText',
      fontSize: '0.8em',
      fontWeight: '500',
      lineHeight: '1',
      verticalAlign: '0.1em',
    },

    // syntax marks
    '& .md-mark': { color: 'velo.mark', fontWeight: '400', fontStyle: 'normal' },
    '&:not(.is-plain) .md-mark': { display: 'none' },
    '&:not(.is-plain) .is-active-line .md-mark': { display: 'inline' },
  },
  '.velo-doc.is-plain .md-tag': {
    display: 'inline',
    h: 'auto',
    p: '0',
    bg: 'transparent',
    fontSize: '1em',
    verticalAlign: 'baseline',
  },
  '.velo-doc.is-plain a.md-link, .velo-doc.is-plain a.md-wikilink': { textDecoration: 'none', borderBottom: '0' },

  // empty-note watermark in Preview
  '.velo-empty-watermark': {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2.5',
    color: 'velo.fgMuted',
    fontSize: '15px',
    userSelect: 'none',
    pointerEvents: 'none',
  },
}
