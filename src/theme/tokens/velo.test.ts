import { describe, expect, it } from "vitest";
import { token, type Token } from "../../../styled-system/tokens";
import { green } from "../colors/green";

// v2 "clear" theme (design/park-ui/v2/README.md §12)
describe("clear tokens", () => {
  it("defines the new semantic colors", () => {
    for (const n of ["accentFg", "hairline", "highlight", "positive", "positiveHover", "positiveFg", "positiveText", "positiveSubtle", "positiveBorder"])
      expect(token.var(`colors.velo.${n}` as Token)).toBe(`var(--colors-velo-${n.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())})`);
  });

  it("green solid buttons use the positive pair, not green.9 + white (~3.2:1)", () => {
    expect(green.solid.bg.DEFAULT.value).toEqual({ _light: "{colors.velo.positive}", _dark: "{colors.velo.positive}" });
    expect(green.solid.fg.DEFAULT.value).toEqual({ _light: "{colors.velo.positiveFg}", _dark: "{colors.velo.positiveFg}" });
  });
});
