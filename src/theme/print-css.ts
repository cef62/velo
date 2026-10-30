// PDF export: PrintHost puts the rendered export in [data-print] under <body>; printing shows only that.
// Fixed light colours: the export prints the same whatever data-theme says.
const ink = '#1a1a1a'
const muted = '#5c5c5c'
const rule = '#d4d4d4'
const tint = '#f3f3f3'
export const printGlobalCss = {
  '[data-print]': {
    display: 'none',
    '@media print': {
      display: 'block',
      color: ink,
      background: '#fff',
      fontFamily: 'body',
      fontSize: '11pt',
      lineHeight: '1.55',
      '& h1': { fontSize: '1.6em', lineHeight: '1.25', fontWeight: '700', m: '0 0 0.55em' },
      '& h2': { fontSize: '1.25em', lineHeight: '1.3', fontWeight: '650', m: '1.4em 0 0.45em', breakAfter: 'avoid' },
      '& h3, & h4, & h5, & h6': { fontSize: '1.05em', fontWeight: '650', m: '1.2em 0 0.4em', breakAfter: 'avoid' },
      '& p': { m: '0 0 0.8em' },
      '& ul, & ol': { m: '0 0 0.8em', pl: '1.4em' }, // preflight clears list-style
      '& ul': { listStyle: 'disc' },
      '& ol': { listStyle: 'decimal' },
      '& li': { my: '0.1em', breakInside: 'avoid' },
      '& li.task-list-item': { listStyle: 'none', ml: '-1.4em' },
      '& input.task': { m: '0 0.5em 0 0', verticalAlign: '-0.1em', accentColor: ink },
      '& blockquote, & .markdown-alert': { m: '0 0 0.8em', pl: '1em', borderLeft: '3px solid', borderColor: rule, color: muted },
      '& pre': { fontFamily: 'mono', fontSize: '0.85em', bg: tint, p: '0.6em 0.9em', m: '0 0 0.8em', whiteSpace: 'pre-wrap', breakInside: 'avoid' },
      '& code': { fontFamily: 'mono', fontSize: '0.88em', bg: tint, px: '0.3em' },
      '& pre code': { bg: 'transparent', p: '0', fontSize: '1em' },
      '& hr': { border: '0', borderTop: '1px solid', borderColor: rule, my: '1.5em' },
      '& a': { color: ink, textDecoration: 'underline' },
      '& .tag': { color: muted },
      '& table': { borderCollapse: 'collapse', m: '0 0 0.8em' },
      '& th, & td': { border: '1px solid', borderColor: rule, py: '0.25em', px: '0.6em', textAlign: 'left' },
      '& .footnotes': { fontSize: '0.9em', color: muted },
    },
  },
  '@media print': {
    'html, body': { background: '#fff' },
    'body > *:not([data-print])': { display: 'none !important' },
  },
}
