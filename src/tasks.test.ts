import { expect, test } from "vitest";
import { TASK_ITEM } from "./preview";

test("task items the preview can toggle", () => {
  for (const l of ["- [ ] a", "* [x] a", "+ [X] a", "  - [ ] nested", "1. [ ] ordered", "2) [x] ordered", "> - [ ] quoted", "> > * [ ] deep"]) expect(TASK_ITEM.test(l), l).toBe(true);
  for (const l of ["[ ] no bullet", "- [] empty", "- [y] other", "text - [ ] mid", "-[ ] no space"]) expect(TASK_ITEM.test(l), l).toBe(false);
  expect(TASK_ITEM.exec("> - [ ] q")![1]).toBe("> - [");
});
