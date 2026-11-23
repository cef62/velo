import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { MIN_LIST, MIN_LIST_W, MIN_NOTE, NOTE_TRACK, clampSize, listMinW, nudge } from "./divider";

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

test("the horizontal layout keeps the wider list minimum", () => {
  expect(clampSize(10, 1000, MIN_LIST_W)).toBe(MIN_LIST_W);
  expect(clampSize(10, 1000)).toBe(MIN_LIST);
});

test("the grid tracks in App.tsx match MIN_LIST_W and NOTE_TRACK", () => {
  const app = readFileSync("src/ui/App.tsx", "utf8");
  expect(app).toContain(`minmax(min(var(--velo-list-min-w, ${MIN_LIST_W}px), calc(100% - ${NOTE_TRACK + 1}px)), var(--list-w`);
  expect(app).toContain(`minmax(${NOTE_TRACK}px, 1fr)`);
});

test("the list minimum grows with the font and never drops below 216", () => {
  expect(listMinW(14)).toBe(216);
  expect(listMinW(10)).toBe(216);
  expect(listMinW(32)).toBe(387);
  const w = [10, 14, 20, 26, 32].map((f) => listMinW(f));
  expect(w).toEqual([...w].sort((a, b) => a - b));
  expect(listMinW(21)).toBeGreaterThan(listMinW(20));
});

test("the list minimum leaves the note its column in the smallest window (600)", () => {
  expect(listMinW(32, 600)).toBe(279);
  expect(listMinW(14, 600)).toBe(216);
  expect(listMinW(32, 1000)).toBe(387);
  expect(clampSize(10, 600, listMinW(32, 600))).toBe(279);
});
