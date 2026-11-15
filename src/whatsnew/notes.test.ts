import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
// @ts-expect-error plain .mjs, no type declarations
import { releaseNotes } from "../../scripts/release-notes.mjs";
import { MAX_ITEMS, MAX_TITLE, headline, headlineIsFirst, parseReleaseNotes } from "./notes";
import { renderNote } from "./render";

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
  expect(n.count).toEqual({ highlights: 2, fixes: 2, other: 0 });
  expect(n.text).not.toContain("macOS");
  expect(headline(n)).toBe("Added a What's new window");
  expect(headlineIsFirst(n)).toBe(true);
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

test("every real CHANGELOG section round-trips with a short headline", () => {
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const versions = [...changelog.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  expect(versions.length).toBeGreaterThan(20);
  for (const v of versions) {
    const section = changelog.split(`## ${v}\n`)[1].split(/^## /m)[0];
    const bullets = section.split("\n").filter((l) => l.startsWith("- ")).length;
    const n = parseReleaseNotes(releaseNotes(changelog, v));
    expect(n.count.highlights + n.count.fixes + n.count.other, v).toBe(bullets || 1); // 1: the fallback line
    expect(headline(n)!.length, v).toBeLessThanOrEqual(MAX_TITLE + 1);
    for (const it of n.highlights) expect(it.title.length, v).toBeLessThanOrEqual(MAX_TITLE + 1);
  }
  const archived = parseReleaseNotes(releaseNotes(changelog, "0.17.0"));
  expect(headline(archived)).toBe("Added archived notes"); // cut at its colon; the rest becomes the lead
  expect(archived.highlights[0].detail[0]).toMatch(/^Archive a note from its ⋯ menu/);
});

test("long first sentences: cut at a colon, or shortened with the full text kept", () => {
  const colon = parseReleaseNotes(`### Minor Changes\n\n- Added X: ${"word ".repeat(30)}end. Next.`);
  expect(colon.highlights[0].title).toBe("Added X");
  expect(colon.highlights[0].detail).toEqual([`${"Word ".repeat(1)}${"word ".repeat(29)}end.`, "Next."]);
  const long = `Added ${"thing ".repeat(30)}done`;
  const plain = parseReleaseNotes(`### Minor Changes\n\n- ${long}.\n### Patch Changes\n\n- Fixed a.\n- Fixed b.`);
  expect(plain.highlights[0].title.endsWith("…")).toBe(true);
  expect(plain.highlights[0].title.length).toBeLessThanOrEqual(MAX_TITLE + 1);
  expect(plain.highlights[0].detail).toEqual([`${long}.`]);
  expect(headline(plain)).toBe("1 new thing and 2 fixes"); // no short title: the counts
  expect(headlineIsFirst(plain)).toBe(false);
});

test("an abbreviation does not end the title", () => {
  expect(parseReleaseNotes("### Minor Changes\n\n- Added e.g. this. And more.").highlights[0]).toEqual({ title: "Added e.g. this", detail: ["And more."] });
});

test("CRLF gives the same result", () => {
  expect(parseReleaseNotes(NOTES.replace(/\n/g, "\r\n"))).toEqual(parseReleaseNotes(NOTES));
});

test("empty input, plain text, bullets without headings, a loose paragraph", () => {
  expect(parseReleaseNotes("")).toEqual({ highlights: [], fixes: [], other: [], count: { highlights: 0, fixes: 0, other: 0 }, text: "" });
  expect(headline(parseReleaseNotes(""))).toBeNull();
  const plain = parseReleaseNotes("Just some words.\nNo list here.");
  expect([plain.highlights, plain.fixes, plain.other]).toEqual([[], [], []]);
  expect(plain.text).toBe("Just some words.\nNo list here.");
  const old = parseReleaseNotes("- Fixed a.\n- Fixed b.\n\nmacOS: hints without a separator.\n  indented after it");
  expect(old.other).toEqual([
    { title: "Fixed a", detail: [] },
    { title: "Fixed b", detail: [] }, // the loose paragraph and the indented line after it are not its detail
  ]);
});

test("an unknown heading goes to other; major counts as a highlight; one fix", () => {
  const n = parseReleaseNotes("### Updated Dependencies\n\n- bumped x\n\n### Major Changes\n\n- Big thing\n\n### Patch Changes\n\n- One fix");
  expect(n.other.map((i) => i.title)).toEqual(["bumped x"]);
  expect(n.highlights.map((i) => i.title)).toEqual(["Big thing"]);
  expect(headline({ ...n, highlights: [], count: { ...n.count, highlights: 0 } })).toBe("1 fix");
});

test("counts stay true past the caps, and no bullet is dropped by length", () => {
  const many = parseReleaseNotes(`### Patch Changes\n\n${Array.from({ length: 200 }, (_, i) => `- Fixed ${i}.`).join("\n")}`);
  expect(many.fixes).toHaveLength(MAX_ITEMS);
  expect(many.count.fixes).toBe(200);
  expect(headline(many)).toBe("200 fixes");
  const long = parseReleaseNotes(`### Patch Changes\n\n${Array.from({ length: 120 }, (_, i) => `- Fixed ${i} ${"x".repeat(220)}.`).join("\n")}\n\n---\n\nhints`);
  expect(long.count.fixes).toBe(120);
  const huge = parseReleaseNotes(`### Minor Changes\n\n- One.\n  ${"y ".repeat(20_000)}\n  ---\n- Two.\n\n---\n\nhints`);
  expect(huge.highlights.map((i) => i.title)).toEqual(["One", "Two"]); // the real separator is past 20,000 chars
  expect(huge.text.length).toBeLessThanOrEqual(20_001);
});

test("hostile input stays text, images make no request, only safe links", () => {
  const n = parseReleaseNotes(`### Patch Changes\n\n- <img src=x onerror=alert(1)> [x](javascript:alert(1)). ${"A".repeat(1000)}`);
  const html = renderNote(n.fixes[0].title);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a"); // the javascript: link stays text
  expect(html).toContain("&lt;img");
  expect(renderNote("![pic](http://host/p.png) and https://example.com")).toBe('!<a href="http://host/p.png">pic</a> and <a href="https://example.com">https://example.com</a>');
  const huge = parseReleaseNotes(`### Patch Changes\n\n- ${"x ".repeat(5_000_000)}`);
  expect(huge.text.length).toBeLessThanOrEqual(20_001);
  expect(huge.fixes[0].title.length).toBeLessThanOrEqual(1_001);
});

test("a separator inside the notes: only the last one cuts", () => {
  const n = parseReleaseNotes("### Minor Changes\n\n- New.\n  ---\n  more\n\n---\n\nhints");
  expect(n.highlights).toEqual([{ title: "New", detail: ["---", "more"] }]);
});
