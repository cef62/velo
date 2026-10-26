import { describe, expect, it } from "vitest";
import { banner, paneDivider, inlineTag, keyCap, listRow, previewPill, searchMatch, tagChip, titleBar } from "../../../styled-system/recipes";

const nonEmpty = (s: string) => expect(s).toMatch(/\S/);

describe("velo recipes", () => {
  it("simple recipes return classes", () => {
    for (const r of [searchMatch(), inlineTag(), previewPill()]) nonEmpty(r);
    for (const orientation of ["horizontal", "vertical"] as const) nonEmpty(paneDivider({ orientation }));
    for (const tone of ["conflict", "filter", "preview"] as const) nonEmpty(banner({ tone }));
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
    for (const selected of [true, false]) {
      const c = tagChip({ selected });
      nonEmpty(c.root);
      nonEmpty(c.count);
    }
    const t = titleBar();
    for (const slot of ["root", "title", "status", "actions"] as const) nonEmpty(t[slot]);
  });
});
