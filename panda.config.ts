import { neutral } from "./src/theme/colors/neutral";
import { green } from "./src/theme/colors/green";
import { red } from "./src/theme/colors/red";
import { velo, veloPopoverClear } from "./src/theme/tokens/velo";
import { amber } from "./src/theme/colors/amber";
import { animationStyles } from "./src/theme/animation-styles";
import { zIndex } from "./src/theme/tokens/z-index";
import { shadows } from "./src/theme/tokens/shadows";
import { durations } from "./src/theme/tokens/durations";
import { colors } from "./src/theme/tokens/colors";
import { textStyles } from "./src/theme/text-styles";
import { layerStyles } from "./src/theme/layer-styles";
import { keyframes } from "./src/theme/keyframes";
import { globalCss } from "./src/theme/global-css";
import { conditions } from "./src/theme/conditions";
import { slotRecipes, recipes } from "./src/theme/recipes";
import { defineConfig } from '@pandacss/dev'

export default defineConfig({
  presets: ['@pandacss/preset-base', '@pandacss/preset-panda'],
  jsxFramework: 'react',
  preflight: true,
  include: ['./src/**/*.{js,jsx,ts,tsx}'],
  plugins: [
    {
      name: 'Remove Panda Preset Colors',
      hooks: {
        'preset:resolved': ({ utils, preset, name }) =>
          name === '@pandacss/preset-panda' ? utils.omit(preset, ['theme.tokens.colors', 'theme.semanticTokens.colors']) : preset,
      },
    },
  ],
  exclude: [],

  theme: {
    extend: {
      animationStyles: animationStyles,
      recipes: recipes,
      slotRecipes: slotRecipes,
      keyframes: keyframes,
      layerStyles: layerStyles,
      textStyles: textStyles,

      tokens: {
        colors: colors,
        fonts: {
          ui: { value: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
          body: { value: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
          mono: { value: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' },
        },
        fontSizes: {
          ui: { value: '13px' }, // header chrome, does not scale with the user setting
          uiSm: { value: '12px' },
          uiXs: { value: '11px' },
        },
        sizes: {
          readingColumn: { value: '46em' },
          control: { value: '32px' },
          controlSm: { value: '28px' },
          header: { value: '48px' },
          titleBar: { value: '48px' },
          // v2 (design/park-ui/v2/README.md §7)
          paneBar: { value: '36px' }, // left pane bar: mode tabs + that mode's controls
          paneTab: { value: '28px' }, // tab / menu-button height inside pane bars (= controlSm)
          sidePanel: { value: '300px' }, // Related · Info panel, docked
          searchMax: { value: '680px' }, // the header search stops growing here
          searchMin: { value: '180px' }, // and never shrinks below this
          palette: { value: '560px' }, // command palette width
          relatedRow: { value: '44px' }, // min height of a Related row (title + context line)
        },
        durations: durations,
        zIndex: zIndex
      },

      semanticTokens: {
        colors: {
          fg: {
            default: {
              value: {
                _light: "{colors.gray.12}",
                _dark: "{colors.gray.12}"
              }
            },

            muted: {
              value: {
                _light: "{colors.gray.11}",
                _dark: "{colors.gray.11}"
              }
            },

            subtle: {
              value: {
                _light: "{colors.gray.10}",
                _dark: "{colors.gray.10}"
              }
            }
          },

          border: {
            value: {
              _light: "{colors.gray.4}",
              _dark: "{colors.gray.4}"
            }
          },

          error: {
            value: {
              _light: "{colors.red.9}",
              _dark: "{colors.red.9}"
            }
          },

          amber: amber,
          gray: neutral,
          velo: velo,
          red: red,
          green: green

        },

        shadows: {
          ...shadows,
          veloPopover: veloPopoverClear,
        },

        radii: {
          l1: {
            value: "{radii.sm}"
          },

          l2: {
            value: "{radii.md}"
          },

          l3: {
            value: "{radii.lg}"
          }
        }
      }
    },
  },

  outdir: "styled-system",
  globalCss: globalCss,
  conditions: conditions
})