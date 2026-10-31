import { describe, expect, it } from "vitest";
import { applyPalette, palettes, type PaletteSlug } from ".";
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
