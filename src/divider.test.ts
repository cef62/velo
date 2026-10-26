import { expect, test } from "vitest";
import { MIN_LIST, MIN_NOTE, clampSize } from "./divider";

test("divider size keeps both panes usable", () => {
  expect(clampSize(300, 1000)).toBe(300);
  expect(clampSize(10, 1000)).toBe(MIN_LIST);
  expect(clampSize(990, 1000)).toBe(1000 - MIN_NOTE);
  expect(clampSize(250.6, 1000)).toBe(251);
});
