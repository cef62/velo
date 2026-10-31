import { describe, expect, it } from "vitest";
import { palettes, type PaletteSlug } from ".";
import { applyPalette } from "./apply";
import { OTHER_PALETTES, velo, veloPopover } from "../tokens/velo";
import { parkColors, parkScales } from "./park";

const slugs = Object.keys(palettes) as PaletteSlug[];

describe("palettes", () => {
  it("every palette has exactly Clear's velo token keys", () => {
    const keys = Object.keys(palettes.clear.colors).sort();
    for (const s of slugs) expect(Object.keys(palettes[s].colors).sort(), s).toEqual(keys);
  });

  it("built tokens resolve every palette × mode to its file's value", () => {
    for (const s of slugs)
      for (const m of ["_light", "_dark"] as const) {
        const pick = (v: Record<string, string>) => v[`_palette${s[0].toUpperCase()}${s.slice(1)}`] ?? v.base;
        for (const [k, t] of Object.entries(palettes[s].colors)) expect(pick(velo[k as keyof typeof velo].value[m]), `${s} ${m} ${k}`).toBe(t.value[m]);
        expect(pick(veloPopover.value[m])).toBe(palettes[s].popover.value[m]);
      }
  });

  it("has a condition per non-default palette", () => {
    expect(OTHER_PALETTES).toEqual(["mist", "paper", "electric", "reef", "contrast"]);
    for (const s of OTHER_PALETTES) expect(velo.accent.value._light).toHaveProperty(`_palette${s[0].toUpperCase()}${s.slice(1)}`);
  });

  it("maps Park scales per palette; green.solid stays velo.positive", () => {
    const g = parkColors.gray as unknown as Record<string, { value: { _light: Record<string, string> } }>;
    expect(g["1"].value._light._paletteMist).toBe("{colors.slate.1}");
    expect(g["12"].value._light._paletteContrast).toBe("{colors.velo.fg}");
    const orange = parkColors.orange as unknown as Record<string, { value: { _dark: Record<string, string> } }>;
    expect(orange["9"].value._dark._palettePaper).toBe("{colors.velo.accent}");
    expect(JSON.stringify((parkColors.green as Record<string, unknown>).solid)).toContain("velo.positive");
    expect(parkScales.mist.accent).toBe("iris");
    expect(parkScales.contrast.accent).toBe("blue");
    const surface = (parkColors.blue as unknown as { surface: { border: { DEFAULT: { value: { _dark: Record<string, string> } } } } }).surface;
    expect(surface.border.DEFAULT.value._dark._paletteContrast).toBe("{colors.velo.accentBorder}");
  });
});

describe("custom steps", () => {
  type S = Record<string, { value: { _light: Record<string, string>; _dark: Record<string, string> } }>;
  const at = (scale: string, step: string, cond: string, m: "_light" | "_dark" = "_light") =>
    (parkColors[scale as keyof typeof parkColors] as unknown as S)[step].value[m][cond];
  it("a-steps take the same velo references as the solid steps", () => {
    const cases: [string, string, Record<string, string>][] = [
      ["orange", "_palettePaper", { 9: "accent", 10: "accentHover", 11: "accentText" }],
      ["grass", "_palettePaper", { 9: "positive", 10: "positiveHover", 11: "positiveText" }],
      ["blue", "_paletteElectric", { 9: "accent", 10: "accentHover", 11: "accentText" }],
      ["teal", "_paletteReef", { 9: "accent", 10: "accentHover", 11: "accentText" }],
      ["blue", "_paletteContrast", { 7: "accentBorder", 8: "accentBorder", 9: "accent", 10: "accentHover", 11: "accentText", 12: "accentHover" }],
    ];
    for (const [scale, cond, steps] of cases)
      for (const [n, t] of Object.entries(steps)) for (const k of [n, `a${n}`]) expect(at(scale, k, cond), `${scale}.${k}`).toBe(`{colors.velo.${t}}`);
    expect(at("green", "a11", "_paletteContrast", "_dark")).toBe("{colors.velo.positiveText}");
    expect(at("red", "a11", "_paletteContrast", "_dark")).toBe("{colors.velo.danger}");
  });

  it("text on a custom solid fill is the palette's velo fg token", () => {
    const fg = (scale: string) =>
      ((parkColors[scale as keyof typeof parkColors] as unknown as { solid: { fg: S } }).solid.fg.DEFAULT.value);
    for (const [scale, cond, token] of [["orange", "_palettePaper", "accentFg"], ["grass", "_palettePaper", "positiveFg"], ["blue", "_paletteElectric", "accentFg"], ["teal", "_paletteReef", "accentFg"], ["blue", "_paletteContrast", "accentFg"]])
      for (const m of ["_light", "_dark"] as const) expect(fg(scale)[m][cond], `${scale} ${cond} ${m}`).toBe(`{colors.velo.${token}}`);
  });
});

describe("applyPalette", () => {
  const root = () => ({ dataset: {} as Record<string, string> }) as unknown as HTMLElement;
  it("sets data-palette for a non-default palette", () => {
    const r = root();
    applyPalette("mist", r);
    expect(r.dataset.palette).toBe("mist");
  });
  it("removes it for clear, unknown or empty", () => {
    for (const v of ["clear", "bogus", null, "", "toString"]) {
      const r = root();
      r.dataset.palette = "reef";
      applyPalette(v, r);
      expect(r.dataset.palette, String(v)).toBeUndefined();
    }
  });
});

describe("checkbox recipe", () => {
  it("unchecked border is inputBorder, High contrast's accentBorder", async () => {
    const { checkbox } = await import("../recipes/checkbox");
    const control = (checkbox.variants!.variant.solid as { control: Record<string, unknown> }).control;
    expect(control.borderColor).toBe("velo.inputBorder");
    expect(control["[data-palette=contrast] &[data-state=unchecked]"]).toEqual({ borderColor: "velo.accentBorder" });
  });
});
