import { expect, test } from "vitest";
import { fontScale, rowHeight } from "./fontscale";

test("font scale matches the design table", () => {
  expect([12, 14, 20].map((s) => { const f = fontScale(s); return [f.editor, f.rowCompact, f.rowTwoLine, f.title]; }))
    .toEqual([[14, 26, 40, 15], [16, 30, 46, 17], [22, 43, 66, 24]]);
  expect(fontScale(4).listTitle).toBe(10); expect(fontScale(99).listTitle).toBe(32);
  expect(rowHeight(14, "vertical")).toBe(30); expect(rowHeight(14, "horizontal")).toBe(46);
});
