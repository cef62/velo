import { expect, test } from "vitest";
import { activeFilterCount, appliedSearch, cleanName, defaultName, removeFrom, renameIn, sameFilters, upsert } from "./saved";

const s = (name: string, query = "") => ({ name, query, tags: [], no_links: false });

test("sameFilters trims the query and folds tags", () => {
  expect(sameFilters({ name: "a", query: " velo ", tags: ["Proj"], no_links: false }, { query: "velo", tags: ["proj"], noLinks: false })).toBe(true);
  expect(sameFilters({ name: "a", query: "velo", tags: ["proj"], no_links: false }, { query: "velo", tags: ["work"], noLinks: false })).toBe(false);
  expect(sameFilters({ name: "a", query: "", tags: [], no_links: true }, { query: "", tags: [], noLinks: false })).toBe(false);
});

test("cleanName trims and limits to 60", () => {
  expect(cleanName("   ")).toBeNull();
  expect(cleanName("x".repeat(61))).toBeNull();
  expect(cleanName("x".repeat(60))).toBe("x".repeat(60));
  expect(cleanName(" a ")).toBe("a");
});

test("defaultName: query, else first tag, else No links", () => {
  expect(defaultName({ query: " velo ", tags: ["proj"], noLinks: false })).toBe("velo");
  expect(defaultName({ query: "", tags: ["proj"], noLinks: false })).toBe("#proj");
  expect(defaultName({ query: "", tags: [], noLinks: true })).toBe("No links");
});

test("upsert replaces a folded-equal name in place, else appends", () => {
  expect(upsert([s("Velo", "a"), s("b")], s("velo", "z"))).toEqual([s("velo", "z"), s("b")]);
  expect(upsert([s("a")], s("b"))).toEqual([s("a"), s("b")]);
});

test("renameIn keeps position and drops a replaced name; removeFrom folds", () => {
  expect(renameIn([s("a"), s("b"), s("c")], "a", "x")).toEqual([s("x"), s("b"), s("c")]);
  expect(renameIn([s("a"), s("b")], "A", "B")).toEqual([s("B")]);
  expect(removeFrom([s("a"), s("Velo")], "velo")).toEqual([s("a")]);
});

test("activeFilterCount: tags + No links, or 1 for the applied saved search even while typing narrows it", () => {
  const saved = [{ name: "w", query: "", tags: ["work", "idea"], no_links: false }, { name: "t", query: "todo", tags: [], no_links: false }];
  expect(activeFilterCount(saved, null, { query: "x", tags: [], noLinks: false })).toBe(0);
  expect(activeFilterCount(saved, "t", { query: "todo", tags: [], noLinks: false })).toBe(1); // a text-only saved search still counts
  expect(activeFilterCount(saved, null, { query: "", tags: ["work"], noLinks: true })).toBe(2);
  expect(activeFilterCount(saved, "w", { query: "", tags: ["idea", "work"], noLinks: false })).toBe(1);
  expect(activeFilterCount(saved, "w", { query: "more", tags: ["idea", "work"], noLinks: false })).toBe(1); // typed text narrows the applied search
  expect(activeFilterCount(saved, "w", { query: "", tags: ["idea"], noLinks: false })).toBe(1); // a tag change ends it: plain tags again
  expect(appliedSearch(saved, "gone", { query: "", tags: [], noLinks: false })).toBeNull();
});
