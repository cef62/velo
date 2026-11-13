import { expect, test } from "vitest";
import { chipTags, focusAfterRemoval, extractTags, pruneSelection, tagBarItems, toggleTag } from "./tags";
import codeCases from "../tests/fixtures/tags-code.json";

test("toggle is fold-insensitive", () => {
  expect(toggleTag(["Work"], "work")).toEqual([]);
  expect(toggleTag([], "Idea")).toEqual(["Idea"]);
});
test("prune drops vanished tags", () => expect(pruneSelection(["work", "gone"], [{ tag: "Work", count: 2 }])).toEqual(["work"]));
// Same input and expectation as Rust text.rs extract_tags_rules.
test("extractTags mirrors Rust extract_tags_rules", () => {
  const b = "#Work and #idea, (#nested/path) C# x#y #1 #2024 http://h.com/#frag\n# Heading\n```\n#incode\n```\n#Café #work";
  expect(extractTags(b)).toEqual(["Work", "idea", "nested/path", "Café"]);
});
test("extractTags skips code like Rust (shared fixture)", () => {
  for (const c of codeCases) expect(extractTags(c.body), c.body).toEqual(c.tags);
});
test("tagBarItems marks selected tags case- and accent-insensitively", () => {
  expect(tagBarItems(["Proj", "café"], ["proj", "CAFE"])).toEqual([
    { tag: "Proj", selected: true },
    { tag: "café", selected: true },
  ]);
});
test("tagBarItems with no tags is empty", () => expect(tagBarItems([], ["x"])).toEqual([]));

test("chipTags keeps visible tags and adds selected ones with count 0", () => {
  const vis = [{ tag: "Work", count: 2 }, { tag: "home", count: 1 }];
  expect(chipTags(vis, [])).toEqual(vis);
  expect(chipTags(vis, ["work"])).toEqual(vis); // selected and visible: the visible count wins
  expect(chipTags(vis, ["solo", "Old"])).toEqual([...vis, { tag: "solo", count: 0 }, { tag: "Old", count: 0 }]);
});

test("focusAfterRemoval: saved delete matches the old rule", () => {
  // buttons: [saved x k][No links][tags...]; k and n are counted after the removal
  expect(focusAfterRemoval("saved", 1, 1, 4)).toBe(0); // last of two saved: the previous saved chip
  expect(focusAfterRemoval("saved", 0, 0, 3)).toBe(0); // only saved chip: No links
  expect(focusAfterRemoval("saved", 1, 3, 6)).toBe(1); // middle: the chip now there
});

test("focusAfterRemoval: tag deselect", () => {
  expect(focusAfterRemoval("tag", 4, 1, 4)).toBe(3); // last tag chip (index 4 before): the previous button
  expect(focusAfterRemoval("tag", 1, 0, 1)).toBe(0); // only tag chip, no saved: No links
  expect(focusAfterRemoval("tag", 3, 1, 6)).toBe(3); // middle: the next chip
});
