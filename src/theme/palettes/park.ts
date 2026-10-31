// Park UI scales per palette (design/palettes/README.md §3): which Radix scale backs colors.gray, green, red and the
// default colorPalette, plus the "custom" steps that take the palette's velo.* values. Radix files: scripts/gen-radix.mjs.
import { neutral } from '../colors/neutral'
import { green as radixGreen } from '../colors/green'
import { red as radixRed } from '../colors/red'
import { slate } from '../colors/slate'
import { sand } from '../colors/sand'
import { iris } from '../colors/iris'
import { jade } from '../colors/jade'
import { orange } from '../colors/orange'
import { grass } from '../colors/grass'
import { crimson } from '../colors/crimson'
import { blue } from '../colors/blue'
import { teal } from '../colors/teal'
import { paletteCondition, perMode, type Value } from '../tokens/velo'
import type { PaletteSlug } from '.'

type Scale = 'gray' | 'slate' | 'sand' | 'iris' | 'jade' | 'orange' | 'grass' | 'crimson' | 'blue' | 'teal' | 'green' | 'red'

export const parkScales: Record<PaletteSlug, { gray: Scale; accent: Scale; green: Scale; red: Scale }> = {
  clear: { gray: 'gray', accent: 'gray', green: 'green', red: 'red' },
  mist: { gray: 'slate', accent: 'iris', green: 'jade', red: 'red' },
  paper: { gray: 'sand', accent: 'orange', green: 'grass', red: 'crimson' },
  electric: { gray: 'slate', accent: 'blue', green: 'grass', red: 'red' },
  reef: { gray: 'gray', accent: 'teal', green: 'grass', red: 'crimson' },
  // the table's accent (blue) is velo.accent* via blue.11–12; Park controls stay black / white
  contrast: { gray: 'gray', accent: 'gray', green: 'green', red: 'red' },
}

type Leaf = { value: unknown } // Value, ByCond or perMode() output
type ByCond = { base: Value } & Record<string, Value> // before perMode()
type Tree = { [k: string]: Tree | Leaf }
const isLeaf = (t: Tree | Leaf): t is Leaf => 'value' in t
const byCond = (v: unknown): ByCond => (typeof v === 'object' && v && 'base' in v ? { ...(v as ByCond) } : { base: v as Value })

/** Every leaf of `base` (the Clear scale) gets `_palette<Slug>: {colors.<target>.<path>}` where the palette maps `role` elsewhere. */
function alias(base: Tree, role: 'gray' | 'green' | 'red', skip: string[] = [], path: string[] = []): Tree {
  return Object.fromEntries(
    Object.entries(base).map(([k, t]) => {
      if (skip.includes(k)) return [k, t]
      const p = k === 'DEFAULT' ? path : [...path, k]
      if (!isLeaf(t)) return [k, alias(t, role, [], p)]
      const v = byCond(t.value)
      for (const [slug, m] of Object.entries(parkScales)) if (m[role] !== role) v[`_${paletteCondition(slug as PaletteSlug)}`] = `{colors.${m[role]}.${p.join('.')}}`
      return [k, { value: v }]
    }),
  )
}

/** Step overrides under one palette: `{ 9: 'accent' }` → steps 9 and a9 = {colors.velo.accent} there (a-steps back Park's
 * outline / plain / kbd text); `dark` overrides only _dark; `alpha: false` leaves the a-steps alone. */
function custom(scale: Tree, slug: PaletteSlug, steps: Record<string, string>, dark = false, alpha = true): Tree {
  const out = { ...scale }
  const all = alpha ? Object.entries(steps).flatMap(([n, t]) => [[n, t], [`a${n}`, t]]) : Object.entries(steps)
  for (const [step, token] of all) {
    const v = byCond((out[step] as Leaf).value)
    const ref = `{colors.velo.${token}}`
    v[`_${paletteCondition(slug)}`] = dark ? { _light: (v.base as { _light: string })._light, _dark: ref } : ref
    out[step] = { value: v }
  }
  return out
}

/** Text on the custom solid fill (steps 9–10): `solid.fg` = {colors.velo.<token>} under that palette. */
function solidFg(scale: Tree, slug: PaletteSlug, token: string): Tree {
  const solid = scale.solid as Tree
  const fg = solid.fg as Tree
  const v = byCond((fg.DEFAULT as Leaf).value)
  v[`_${paletteCondition(slug)}`] = `{colors.velo.${token}}`
  return { ...scale, solid: { ...solid, fg: { ...fg, DEFAULT: { value: v } } } }
}

/** Leaves still in `{ base, _palette… }` form → Panda's per-mode shape. */
const finish = (t: Tree): Tree =>
  Object.fromEntries(
    Object.entries(t).map(([k, c]) => [k, !isLeaf(c) ? finish(c) : typeof c.value === 'object' && c.value && 'base' in c.value ? perMode(c.value as ByCond) : c]),
  )

const accent3 = { 9: 'accent', 10: 'accentHover', 11: 'accentText' }
const positive3 = { 9: 'positive', 10: 'positiveHover', 11: 'positiveText' }

export const parkColors = Object.fromEntries(Object.entries({
  // green.solid stays velo.positive (already palette-aware), so it is not aliased
  gray: custom(alias(neutral, 'gray'), 'contrast', { 1: 'canvas', 12: 'fg' }, false, false), // contrast: ends pushed to #fff / #000
  green: custom(alias(radixGreen, 'green', ['solid']), 'contrast', { 11: 'positiveText' }, true),
  red: custom(alias(radixRed, 'red'), 'contrast', { 11: 'danger' }, true),
  slate,
  sand,
  iris,
  jade,
  orange: solidFg(custom(orange, 'paper', accent3), 'paper', 'accentFg'),
  grass: solidFg(custom(grass, 'paper', positive3), 'paper', 'positiveFg'),
  crimson,
  blue: solidFg(solidFg(custom(custom(blue, 'electric', accent3), 'contrast', { 11: 'accentText', 12: 'accentHover' }), 'electric', 'accentFg'), 'contrast', 'accentFg'),
  teal: solidFg(custom(teal, 'reef', accent3), 'reef', 'accentFg'),
}).map(([k, t]) => [k, finish(t as Tree)]))

/** globalCss: the default colorPalette on <html>, per palette (none where it repeats Clear's). */
export const paletteColorPalettes = Object.fromEntries(
  Object.entries(parkScales)
    .filter(([slug, m]) => slug === 'clear' || m.accent !== parkScales.clear.accent)
    .map(([slug, m]) => [slug === 'clear' ? 'html' : `html[data-palette=${slug}]`, { colorPalette: m.accent }]),
)
