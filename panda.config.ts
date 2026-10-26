import { slate } from "./src/theme/colors/slate";
import { indigo } from "./src/theme/colors/indigo";
import { green } from "./src/theme/colors/green";
import { red } from "./src/theme/colors/red";
import { velo } from "./src/theme/tokens/velo";
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
          ui: { value: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
          body: { value: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif' },
          mono: { value: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' },
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
          gray: slate,
          indigo: indigo,
          velo: velo,
          red: red,
          green: green

        },

        shadows: {
          ...shadows,
          veloPopover: {
            value: {
              _light: '0 1px 2px rgba(16,24,64,.06), 0 12px 32px rgba(16,24,64,.14)',
              _dark: '0 0 0 1px #2e3135, 0 16px 40px rgba(0,0,0,.55)',
            },
          },
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