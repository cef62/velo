import { expect, test } from "vitest";
import { chipLayout, chipsFor } from "./searchChips";

const saved = [{ name: "Weekly review", query: "", tags: ["work", "idea"], no_links: false }];

test("chipsFor: the applied saved search is one chip (typing narrows it), else tags then No links", () => {
  expect(chipsFor(saved, "Weekly review", { query: "", tags: ["idea", "work"], noLinks: false })).toEqual([{ kind: "saved", label: "Weekly review", name: "Weekly review" }]);
  expect(chipsFor(saved, "Weekly review", { query: "q4", tags: ["idea", "work"], noLinks: false })).toEqual([{ kind: "saved", label: "Weekly review", name: "Weekly review" }]);
  expect(chipsFor(saved, null, { query: "", tags: ["idea", "work"], noLinks: false })).toHaveLength(2); // same tags chosen by hand: two chips
  expect(chipsFor(saved, null, { query: "x", tags: ["work"], noLinks: true })).toEqual([
    { kind: "tag", label: "#work", tag: "work" },
    { kind: "nolinks", label: "No links" },
  ]);
  expect(chipsFor(saved, null, { query: "x", tags: [], noLinks: false })).toEqual([]);
});

test("chipLayout: chips take at most half the field, the rest fold into +N", () => {
  expect(chipLayout(600, [], false)).toEqual({ shown: 0, folded: 0, collapse: false });
  expect(chipLayout(600, [60, 60], false)).toEqual({ shown: 2, folded: 0, collapse: false });
  // 1000 px, six 70 px tags: 6×70 + 5×4 = 440 ≤ 500: all fit
  expect(chipLayout(1000, [70, 70, 70, 70, 70, 70], false)).toEqual({ shown: 6, folded: 0, collapse: false });
  // 6 wider chips (100 px): 4 fit in 500 (4×100 + 3×4 = 412; 5 → 516 > 500) → "+2"
  expect(chipLayout(1000, [100, 100, 100, 100, 100, 100], false)).toEqual({ shown: 4, folded: 2, collapse: false });
});

test("chipLayout: typing with under 160 px of text room collapses every chip into one", () => {
  // 400 px, three 90 px chips: 2 fit in 200 (184), +1 folds (40): used 228 → 172 px left: no collapse
  expect(chipLayout(400, [90, 90, 90], true)).toEqual({ shown: 2, folded: 1, collapse: false });
  // 300 px, two 120 px chips: 1 fits in 150, +1 folds: used 164 → 136 px left → collapse
  expect(chipLayout(300, [120, 120], true)).toEqual({ shown: 0, folded: 2, collapse: true });
  expect(chipLayout(300, [120, 120], false).collapse).toBe(false); // not typing: fold, never collapse
});
