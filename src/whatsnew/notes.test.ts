import { expect, test } from "vitest";
// @ts-expect-error plain .mjs, no type declarations
import { releaseNotes } from "../../scripts/release-notes.mjs";
import { MAX_ITEMS, headline, parseReleaseNotes } from "./notes";

const NOTES = `### Minor Changes

- Added a What's new window. It opens from the update pill.
  It shows what an update brings before you install it.

  Fixes are listed apart.
- Added a second thing.

### Patch Changes

- Fixed one bug.
- 1a2b3c4: Fixed another bug!

---

macOS: the app is ad-hoc signed.`;

test("groups by heading, splits title and detail, cuts the install hints", () => {
  const n = parseReleaseNotes(NOTES);
  expect(n.highlights).toEqual([
    { title: "Added a What's new window", detail: ["It opens from the update pill.", "It shows what an update brings before you install it.", "Fixes are listed apart."] },
    { title: "Added a second thing", detail: [] },
  ]);
  expect(n.fixes).toEqual([
    { title: "Fixed one bug", detail: [] },
    { title: "Fixed another bug!", detail: [] }, // leftover hash prefix stripped
  ]);
  expect(n.other).toEqual([]);
  expect(n.text).not.toContain("macOS");
  expect(headline(n)).toBe("Added a What's new window");
});

test("reads what the release script writes", () => {
  const changelog = "## 1.0.0\n\n### Patch Changes\n\n- abcdef1: Fixed a. More about a.\n- abcdef2: Fixed b.\n";
  const n = parseReleaseNotes(releaseNotes(changelog, "1.0.0"));
  expect(n.fixes).toEqual([
    { title: "Fixed a", detail: ["More about a."] },
    { title: "Fixed b", detail: [] },
  ]);
  expect(headline(n)).toBe("2 fixes");
  expect(n.text).toBe("### Patch Changes\n\n- Fixed a. More about a.\n- Fixed b.");
});

test("CRLF gives the same result", () => {
  expect(parseReleaseNotes(NOTES.replace(/\n/g, "\r\n"))).toEqual(parseReleaseNotes(NOTES));
});

test("empty input, plain text and bullets without headings", () => {
  expect(parseReleaseNotes("")).toEqual({ highlights: [], fixes: [], other: [], more: 0, text: "" });
  expect(headline(parseReleaseNotes(""))).toBeNull();
  const plain = parseReleaseNotes("Just some words.\nNo list here.");
  expect([plain.highlights, plain.fixes, plain.other]).toEqual([[], [], []]);
  expect(plain.text).toBe("Just some words.\nNo list here.");
  const old = parseReleaseNotes("- Fixed a.\n- Fixed b.\n\nmacOS: hints without a separator.");
  expect(old.other.map((i) => i.title)).toEqual(["Fixed a", "Fixed b"]); // the hints paragraph is not a bullet
  expect(old.fixes).toEqual([]);
});

test("an unknown heading goes to other; major counts as a highlight; one fix", () => {
  const n = parseReleaseNotes("### Updated Dependencies\n\n- bumped x\n\n### Major Changes\n\n- Big thing\n\n### Patch Changes\n\n- One fix");
  expect(n.other.map((i) => i.title)).toEqual(["bumped x"]);
  expect(n.highlights.map((i) => i.title)).toEqual(["Big thing"]);
  expect(headline({ ...n, highlights: [] })).toBe("1 fix");
});

test("hostile input stays text and is capped", () => {
  const n = parseReleaseNotes(`### Patch Changes\n\n- <img src=x onerror=alert(1)> [x](javascript:alert(1)). ${"A".repeat(1000)}`);
  expect(n.fixes[0].title).toBe("<img src=x onerror=alert(1)> [x](javascript:alert(1))"); // rendered later, without HTML
  const long = parseReleaseNotes(`### Patch Changes\n\n- ${"B".repeat(5000)}`);
  expect(long.fixes[0].title.length).toBeLessThanOrEqual(301);
  const many = parseReleaseNotes(`### Patch Changes\n\n${Array.from({ length: 200 }, (_, i) => `- Fixed ${i}.`).join("\n")}`);
  expect(many.fixes).toHaveLength(MAX_ITEMS);
  expect(many.more).toBe(200 - MAX_ITEMS);
  const huge = parseReleaseNotes(`### Patch Changes\n\n- ${"x ".repeat(5_000_000)}`);
  expect(huge.text.length).toBeLessThanOrEqual(20_000);
});

test("a separator inside the notes: only the last one cuts", () => {
  const n = parseReleaseNotes("### Minor Changes\n\n- New.\n  ---\n  more\n\n---\n\nhints");
  expect(n.highlights).toEqual([{ title: "New", detail: ["---", "more"] }]);
});
