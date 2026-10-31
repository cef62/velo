import { palettes, DEFAULT_PALETTE, type PaletteSlug } from '../palettes'

// velo semantic colors for every palette (design/palettes/README.md §6). Values live in src/theme/palettes/<slug>.ts.
// Clear is the base; each other palette is a Panda condition on <html data-palette=…>, independent of data-theme.

export type Value = string | { _light: string; _dark: string }

export const OTHER_PALETTES = (Object.keys(palettes) as PaletteSlug[]).filter((s) => s !== DEFAULT_PALETTE)

/** `mist` → `paletteMist` (use as `_paletteMist`) */
export const paletteCondition = (slug: PaletteSlug) => `palette${slug[0].toUpperCase()}${slug.slice(1)}`

export const paletteConditions = Object.fromEntries(OTHER_PALETTES.map((s) => [paletteCondition(s), `[data-palette=${s}] &`]))

/** `{ base, _paletteMist, … }` → `{ value: { _light: { base, _paletteMist, … }, _dark: { … } } }`: Panda nests conditions only under string leaves. */
export function perMode(byCond: Record<string, Value>) {
  const mode = (m: '_light' | '_dark') =>
    Object.fromEntries(Object.entries(byCond).map(([c, v]) => [c, typeof v === 'string' ? v : v[m]]))
  return { value: { _light: mode('_light'), _dark: mode('_dark') } }
}

/** One token: `base` from Clear, `_palette<Slug>` per other palette whose value differs. */
export function byPalette(pick: (slug: PaletteSlug) => Value) {
  const base = pick(DEFAULT_PALETTE)
  const byCond: Record<string, Value> = { base }
  for (const s of OTHER_PALETTES) {
    const v = pick(s)
    if (JSON.stringify(v) !== JSON.stringify(base)) byCond[`_${paletteCondition(s)}`] = v
  }
  return perMode(byCond)
}

const clear = palettes[DEFAULT_PALETTE].colors
type VeloKey = keyof typeof clear

export const velo = Object.fromEntries(
  (Object.keys(clear) as VeloKey[]).map((k) => [k, byPalette((s) => palettes[s].colors[k].value)]),
) as Record<VeloKey, ReturnType<typeof byPalette>>

// panda.config.ts › semanticTokens.shadows.veloPopover
export const veloPopover = byPalette((s) => palettes[s].popover.value)
