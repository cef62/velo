import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { css } from "styled-system/css";
import { palettes, type PaletteSlug } from "../theme/palettes";

const slugs = Object.keys(palettes) as PaletteSlug[];

// Each mini preview paints one palette in one mode, whatever the window's palette and theme: its colors come in as
// inline --p-<token> variables taken straight from the palette's token file.
type Tokens = Record<string, { value: { _light: string; _dark: string } }>;
const vars = (slug: PaletteSlug, mode: "_light" | "_dark") =>
  Object.fromEntries(Object.entries(palettes[slug].colors as Tokens).map(([k, v]) => [`--p-${k}`, v.value[mode]])) as CSSProperties;

const grid = css({ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "14px" });
const card = css({
  display: "flex", flexDirection: "column", gap: "10px", p: "10px", borderRadius: "12px", border: "1px solid", borderColor: "velo.inputBorder",
  bg: "velo.canvas", color: "velo.fg", cursor: "pointer", textAlign: "left", minW: "0",
  "&[aria-checked=true]": { borderColor: "velo.accent", boxShadow: "0 0 0 2px var(--colors-velo-accent)" },
  _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "3px" },
});
const pair = css({ display: "flex", gap: "6px" });
const mini = css({
  display: "flex", flexDirection: "column", flex: "1", minW: "0", h: "150px", borderRadius: "8px", overflow: "hidden",
  border: "1px solid var(--p-hairline)", bg: "var(--p-canvas)", color: "var(--p-fg)", font: "500 10px/1 Inter, system-ui, sans-serif", whiteSpace: "nowrap",
  "& .h": { h: "24px", flex: "none", bg: "var(--p-chrome)", borderBottom: "1px solid var(--p-divider)", display: "flex", alignItems: "center", gap: "5px", px: "8px" },
  "& .h i": { w: "44%", h: "12px", borderRadius: "4px", bg: "var(--p-canvas)", border: "1px solid var(--p-accentBorder)" },
  "& .h b": { ml: "auto", w: "16px", h: "12px", borderRadius: "4px", bg: "var(--p-accent)" },
  "& .r": { m: "6px 6px 0", h: "22px", flex: "none", borderRadius: "5px", display: "flex", alignItems: "center", px: "7px", overflow: "hidden" },
  "& .r.s": { bg: "var(--p-selection)", color: "var(--p-selectionFg)" },
  "& mark": { bg: "var(--p-matchBg)", color: "var(--p-matchFg)", borderRadius: "2px", px: "1px", fontWeight: "600" },
  "& .r.s mark": { bg: "var(--p-matchOnSelectionBg)", color: "var(--p-matchOnSelectionFg)" },
  "& .t": { m: "6px 10px 0", fontWeight: "400", lineHeight: "1.5", color: "var(--p-fgMuted)", overflow: "hidden" },
  "& .t u": { color: "var(--p-accentText)", textDecorationColor: "var(--p-accentLine)" },
  // wraps to two lines at the ~95px a mini gets in the dialog, so every chip stays whole
  "& .f": { m: "auto 6px 6px", display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" },
  "& .f span": { flex: "none", h: "14px", px: "4px", borderRadius: "4px", font: "600 8px/14px Inter, system-ui, sans-serif" },
  "& .f .g": { bg: "var(--p-positive)", color: "var(--p-positiveFg)" },
  "& .f .d": { bg: "var(--p-dangerSubtle)", color: "var(--p-danger)" },
  "& .f .c": { borderRadius: "999px", fontWeight: "500", bg: "var(--p-accentSubtle)", color: "var(--p-accentText)" },
});
const nm = css({ display: "flex", flexDirection: "column", gap: "3px", px: "2px", pb: "2px", "& b": { fontSize: "13px" }, "& span": { fontSize: "12px", color: "velo.fgMuted", lineHeight: "1.4" } });

function Mini({ slug, mode }: { slug: PaletteSlug; mode: "_light" | "_dark" }) {
  return (
    <div className={mini} style={vars(slug, mode)} aria-hidden>
      <div className="h"><i /><b /></div>
      <div className="r s">Velo&nbsp;<mark>road</mark>map</div>
      <div className="r"><mark>Road</mark>&nbsp;trip</div>
      <div className="t">See <u>docs</u>.</div>
      <div className="f"><span className="g">Save</span><span className="d">Oct 28</span><span className="c">#work</span></div>
    </div>
  );
}

/** Settings › Appearance: a radiogroup of palette cards. One tab stop; arrows move focus, Space or click selects. */
export function PalettePicker({ value, onChange }: { value: string; onChange: (slug: PaletteSlug) => void }) {
  const [focus, setFocus] = useState(() => Math.max(0, slugs.indexOf(value as PaletteSlug)));
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const key = (e: KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step) {
      const n = (i + step + slugs.length) % slugs.length;
      setFocus(n);
      refs.current[n]?.focus();
    } else if (e.key === " ") onChange(slugs[i]);
    else return;
    e.preventDefault();
  };
  return (
    <div role="radiogroup" aria-label="Palette" className={grid}>
      {slugs.map((s, i) => {
        const { name, mood } = palettes[s].meta;
        return (
          <div key={s} ref={(el) => void (refs.current[i] = el)} role="radio" aria-checked={value === s} aria-label={`${name}: ${mood}`} tabIndex={i === focus ? 0 : -1}
            className={card} onClick={() => (setFocus(i), onChange(s))} onKeyDown={(e) => key(e, i)}>
            <div className={pair}><Mini slug={s} mode="_light" /><Mini slug={s} mode="_dark" /></div>
            <div className={nm}><b>{name}</b><span>{mood}</span></div>
          </div>
        );
      })}
    </div>
  );
}
