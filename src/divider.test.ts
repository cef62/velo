import { expect, test } from "vitest";
import { MIN_LIST, MIN_NOTE, clampSize, nudge } from "./divider";

test("divider size keeps both panes usable", () => {
  expect(clampSize(300, 1000)).toBe(300);
  expect(clampSize(10, 1000)).toBe(MIN_LIST);
  expect(clampSize(990, 1000)).toBe(1000 - MIN_NOTE);
  expect(clampSize(250.6, 1000)).toBe(251);
});

test("keyboard nudges by one row, Shift by ten", () => {
  expect(nudge(300, "ArrowDown", false, 30)).toBe(330);
  expect(nudge(300, "ArrowLeft", false, 30)).toBe(270);
  expect(nudge(300, "ArrowRight", true, 30)).toBe(600);
  expect(nudge(300, "ArrowUp", true, 30)).toBe(0);
  expect(nudge(300, "a", false, 30)).toBeNull();
});
