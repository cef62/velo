/**
 * velo — Park UI preset + velo semantic tokens.
 *
 * Park UI: accent = Radix Indigo, gray = Radix Slate, radius = "md".
 * velo-specific tokens live under `velo.*` and carry explicit light/dark hex
 * values (all checked for WCAG AA, see README), so they do not depend on how a
 * given Park UI release names its palette tokens. Once you've confirmed the
 * names in your installed version (e.g. `indigo.10`, `gray.11`), you can swap
 * the hexes for token references.
 *
 * NOTE on the createPreset signature: recent @park-ui/panda-preset releases take
 * imported color objects (shown below). Older releases took strings:
 *   createPreset({ accentColor: 'indigo', grayColor: 'slate', borderRadius: 'md' })
 * Use whichever matches the version in package.json.
 */
import { definePreset } from '@pandacss/dev'
import { createPreset } from '@park-ui/panda-preset'
import indigo from '@park-ui/panda-preset/colors/indigo'
import slate from '@park-ui/panda-preset/colors/slate'

export const parkPreset = createPreset({
  accentColor: indigo,
  grayColor: slate,
  radius: 'md',
})

const c = (base: string, dark: string) => ({ value: { base, _dark: dark } })

export const veloPreset = definePreset({
  name: 'velo',
  theme: {
    extend: {
      tokens: {
        fonts: {
          ui: { value: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
          body: { value: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
          mono: { value: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' },
        },
        fontSizes: {
          ui: { value: '13px' }, // header chrome — does NOT scale with the user setting
          uiSm: { value: '12px' },
          uiXs: { value: '11px' },
        },
        sizes: {
          readingColumn: { value: '46em' },
          control: { value: '32px' }, // header inputs / buttons / segments
          controlSm: { value: '28px' },
          header: { value: '48px' },
          titleBar: { value: '48px' },
        },
      },
      semanticTokens: {
        colors: {
          velo: {
            // surfaces
            canvas: c('#ffffff', '#111113'), // editor + list   (white / slate.1)
            chrome: c('#f9f9fb', '#18191b'), // header, tag panel, first-run (slate.2)
            panel: c('#ffffff', '#18191b'), // dialogs, menus
            subtle: c('#f0f0f3', '#212225'), // row hover, segment track, code bg (slate.3)
            muted: c('#e8e8ec', '#272a2d'), // ghost hover (slate.4)
            segmentOn: c('#ffffff', '#363a3f'),

            // borders
            divider: c('#e0e1e6', '#2e3135'), // slate.5
            border: c('#d9d9e0', '#363a3f'), // slate.6
            inputBorder: c('#cdced6', '#43484e'), // slate.7
            grip: c('#cdced6', '#43484e'), // divider grip at rest

            // text
            fg: c('#1c2024', '#edeef0'), // 16.4:1 / 16.3:1
            fgMuted: c('#60646c', '#b0b4ba'), // snippets, dates — 5.9:1 / 9.1:1
            mark: c('#60646c', '#8e929b'), // markdown syntax marks — 5.9:1 / 6.1:1

            // accent
            accent: c('#3e63dd', '#3e63dd'), // indigo.9 — solid buttons, chips on, caret, focus ring
            accentHover: c('#3358d4', '#5472e4'), // indigo.10
            accentText: c('#3a5bc7', '#9eb1ff'), // indigo.11 — links, wikilinks, #tags
            accentSubtle: c('#edf2fe', '#182449'), // indigo.3 — tag-in-text bg, preview strip
            accentSubtleHover: c('#e1e9ff', '#1d2e62'), // indigo.4 — pressed icon buttons
            accentLine: c('#abbdf9', '#3a4f97'), // indigo.7 — link underline
            accentBorder: c('#8da4ef', '#435db1'), // indigo.8 — input focus, divider hover
            accentHalo: c('#d2deff', '#253974'), // indigo.5 — recording key-cap, search match

            // list selection
            selection: c('#3358d4', '#304384'), // list/search active — white text 6.0:1 / 9.3:1
            selectionFg: c('#ffffff', '#ffffff'),
            selectionMuted: c('#e1e9ff', '#d6e1ff'), // snippet/date on selection — 5.0:1 / 7.1:1
            selectionIdle: c('#e1e9ff', '#1d2e62'), // selected, focus in editor

            // status
            danger: c('#ce2c31', '#ff9592'), // red.11 — errors, missing wikilinks
            dangerBorder: c('#e5484d', '#e5484d'), // red.9
            dangerSubtle: c('#feebec', '#3b1219'), // red.3
            warningBg: c('#fff7c2', '#302008'), // amber.3 — conflict banner
            warningBorder: c('#f3d673', '#5c3d05'), // amber.6
            warningFg: c('#4f3422', '#ffe7b3'), // amber.12 — 10.5:1 / 13:1

            overlay: c('rgba(28,32,36,.36)', 'rgba(0,0,0,.6)'),
          },
        },
        shadows: {
          veloPopover: {
            value: {
              base: '0 1px 2px rgba(16,24,64,.06), 0 12px 32px rgba(16,24,64,.14)',
              _dark: '0 0 0 1px #2e3135, 0 16px 40px rgba(0,0,0,.55)',
            },
          },
        },
      },
    },
  },
})
