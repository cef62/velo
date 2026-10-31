import { describe, expect, it } from "vitest";
import { banner, paneDivider, inlineTag, keyCap, listRow, lockScreen, searchChip, searchMatch, tagChip, titleBar } from "../../../styled-system/recipes";

const nonEmpty = (s: string) => expect(s).toMatch(/\S/);

describe("velo recipes", () => {
  it("simple recipes return classes", () => {
    for (const r of [searchMatch(), inlineTag(), banner({ tone: "conflict" })]) nonEmpty(r);
    for (const kind of ["tag", "saved", "more"] as const) nonEmpty(searchChip({ kind }));
    for (const orientation of ["horizontal", "vertical"] as const) nonEmpty(paneDivider({ orientation }));
    for (const slot of ["root", "card", "icon", "title", "row"] as const) nonEmpty(lockScreen()[slot]);
  });

  it("keyCap covers state x changed and conflict differs from default", () => {
    for (const state of ["idle", "recording", "conflict"] as const)
      for (const changed of [true, false]) nonEmpty(keyCap({ state, changed }));
    expect(keyCap({ state: "conflict" })).not.toBe(keyCap());
  });

  it("listRow covers layout x state for every slot", () => {
    for (const layout of ["compact", "twoLine"] as const)
      for (const state of ["idle", "selected", "selectedIdle"] as const) {
        const c = listRow({ layout, state });
        for (const slot of ["root", "title", "snippet", "date", "lock"] as const) nonEmpty(c[slot]);
      }
    expect(listRow({ state: "selected" }).root).not.toBe(listRow({ state: "selectedIdle" }).root);
  });

  it("tagChip and titleBar slots", () => {
    for (const selected of [true, false])
      for (const kind of ["tag", "saved"] as const) {
        const c = tagChip({ selected, kind });
        nonEmpty(c.root);
        nonEmpty(c.count);
      }
    const t = titleBar();
    for (const slot of ["root", "title", "status", "actions"] as const) nonEmpty(t[slot]);
  });
});

describe("searchMatch", () => {
  it("uses the idle match tokens unless the list is active", async () => {
    const { searchMatch: config } = await import("./velo/search-match");
    const base = config.base as Record<string, unknown>;
    expect(base).toMatchObject({ bg: "velo.matchBg", color: "velo.matchFg" });
    expect(base["[data-selected=true] &"]).toEqual({ bg: "velo.matchOnIdleBg", color: "velo.matchOnIdleFg" });
    expect(base["[data-active=true] [data-selected=true] &"]).toEqual({ bg: "velo.matchOnSelectionBg", color: "velo.matchOnSelectionFg" });
  });

  it("velo tokens default to the Clear palette, match tokens included", async () => {
    const { velo, veloPopover } = await import("../tokens/velo");
    const clear = await import("../palettes/clear");
    for (const [k, t] of Object.entries(clear.colors)) {
      expect(velo[k as keyof typeof velo].value._light.base).toBe(t.value._light);
      expect(velo[k as keyof typeof velo].value._dark.base).toBe(t.value._dark);
    }
    expect(veloPopover.value._light.base).toBe(clear.popover.value._light);
    for (const k of ["matchBg", "matchFg", "matchOnSelectionBg", "matchOnSelectionFg", "matchOnIdleBg", "matchOnIdleFg"]) expect(velo).toHaveProperty(k);
  });
});
