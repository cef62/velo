import { describe, expect, it } from "vitest";
import { token, type Token } from "../../../styled-system/tokens";

// v2 "clear" theme (design/park-ui/v2/README.md §12)
describe("clear tokens", () => {
  it("defines the new semantic colors", () => {
    for (const n of ["accentFg", "hairline", "highlight", "positive", "positiveHover", "positiveFg", "positiveText", "positiveSubtle", "positiveBorder"])
      expect(token.var(`colors.velo.${n}` as Token)).toBe(`var(--colors-velo-${n.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())})`);
  });

    expect(green.solid.fg.DEFAULT.value).toEqual({ _light: "{colors.velo.positiveFg}", _dark: "{colors.velo.positiveFg}" });
  });
});
