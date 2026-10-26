export const conditions = {
  extend: {
    // velo writes data-theme=light|dark on <html>, resolving System via matchMedia
    light: ':root &, [data-theme=light] &',
    dark: '[data-theme=dark] &',
    invalid: '&:is(:user-invalid, [data-invalid], [aria-invalid=true])',
    hover: '&:not(:disabled):hover',
    active: '&:not(:disabled):active',
    checked:
      '&:is(:checked, [data-checked], [data-state=checked], [aria-checked=true], [data-state=indeterminate])',
    on: '&:is([data-state=on])',
    pinned: '&:is([data-pinned])',
  },
} as const
