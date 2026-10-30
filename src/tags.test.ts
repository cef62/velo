import { expect, test } from "vitest";
import { extractTags, pruneSelection, tagBarItems, toggleTag } from "./tags";
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
