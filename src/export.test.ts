import { expect, test } from "vitest";
import { countsLine, exportFileName } from "./export";

const zero = { notes: 0, open: 0, done: 0, locked: 0, over_limit: 0, no_tasks: 0, unreadable: 0 };

test("the counts line lists only the non-zero left-out parts", () => {
  expect(countsLine({ ...zero, notes: 23, open: 41, done: 12, locked: 2 })).toBe("23 notes · 41 open tasks · 12 done · 2 locked notes left out");
  expect(countsLine({ ...zero, notes: 1, open: 1, done: 0, locked: 1, over_limit: 3, no_tasks: 1, unreadable: 2 })).toBe(
    "1 note · 1 open task · 0 done · 1 locked note left out · 3 over the 1,000 limit · 1 without tasks · 2 unreadable",
  );
});

test("the file name replaces characters files can't hold", () => {
  expect(exportFileName('a/b\\c:d*e?f"g<h>i|j', "2026-10-30")).toBe("a-b-c-d-e-f-g-h-i-j 2026-10-30.md");
  expect(exportFileName("#proj velo", "2026-10-30")).toBe("#proj velo 2026-10-30.md");
});
