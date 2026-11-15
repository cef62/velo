import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error plain .mjs (it runs in CI without a build step); no type declarations
import { FALLBACK, HINTS, releaseNotes } from "./release-notes.mjs";

const CHANGELOG = `# velo

## 0.19.0

### Minor Changes

- 1a2b3c4: Added a What's new window.
  It shows what an update brings before you install it.

  Fixes are listed apart.
- 5d6e7f8: Added a second thing.

### Patch Changes

- 9a8b7c6: Fixed one bug.

## 0.18.2

### Patch Changes

- 95b49ff: Fixed an agent edit.
- 401f70f: Fixed Enter.

## 0.18.0

### Minor Changes

- 3bba6d5: Added Check for Updates to the command palette.

## 0.17.1

## 0.17.0
`;

const tail = `\n\n---\n\n${HINTS}\n`;

test("keeps the headings, the continuation lines and blank lines inside a bullet; drops the hash", () => {
  expect(releaseNotes(CHANGELOG, "0.19.0")).toBe(
    `### Minor Changes

- Added a What's new window.
  It shows what an update brings before you install it.

  Fixes are listed apart.
- Added a second thing.

### Patch Changes

- Fixed one bug.${tail}`,
  );
});

test("a patch-only and a minor-only section", () => {
  expect(releaseNotes(CHANGELOG, "0.18.2")).toBe(`### Patch Changes\n\n- Fixed an agent edit.\n- Fixed Enter.${tail}`);
  expect(releaseNotes(CHANGELOG, "0.18.0")).toBe(`### Minor Changes\n\n- Added Check for Updates to the command palette.${tail}`);
});

test("an empty or missing section falls back to the CHANGELOG pointer", () => {
  expect(releaseNotes(CHANGELOG, "0.17.1")).toBe(`${FALLBACK}${tail}`);
  expect(releaseNotes(CHANGELOG, "9.9.9")).toBe(`${FALLBACK}${tail}`);
  expect(releaseNotes(CHANGELOG, "0.17.0")).toBe(`${FALLBACK}${tail}`); // last section, no bullets
});

test("CRLF checkouts give the same notes", () => {
  expect(releaseNotes(CHANGELOG.replace(/\n/g, "\r\n"), "0.18.2")).toBe(releaseNotes(CHANGELOG, "0.18.2"));
});

test("the command line prints the notes for the workflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "velo-notes-"));
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
  const out = execFileSync(process.execPath, [join(__dirname, "release-notes.mjs"), "0.18.0", join(dir, "CHANGELOG.md")], { encoding: "utf8" });
  expect(out).toBe(releaseNotes(CHANGELOG, "0.18.0"));
});
