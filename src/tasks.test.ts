import { expect, test } from "vitest";
import { TASK_ITEM } from "./preview";
import { dueRule, localToday, toggleTaskLine } from "./tasks";
import fixture from "../tests/fixtures/task-toggle.json";

test("task items the preview can toggle", () => {
  for (const l of ["- [ ] a", "* [x] a", "+ [X] a", "  - [ ] nested", "1. [ ] ordered", "2) [x] ordered", "> - [ ] quoted", "> > * [ ] deep"]) expect(TASK_ITEM.test(l), l).toBe(true);
  for (const l of ["[ ] no bullet", "- [] empty", "- [y] other", "text - [ ] mid", "-[ ] no space"]) expect(TASK_ITEM.test(l), l).toBe(false);
  expect(TASK_ITEM.exec("> - [ ] q")![1]).toBe("> - [");
});

test("toggleTaskLine matches the shared fixture", () => {
  for (const c of fixture) expect(toggleTaskLine(c.in, c.today), c.in).toBe(c.out);
});

test("localToday is YYYY-MM-DD", () => expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/));

test("due: input rule", () => {
  const before = "- [ ] call due:";
  const r = dueRule(before, " ")!;
  expect(before.slice(0, r.from) + r.insert).toBe("- [ ] call 📅 ");
  expect(dueRule("call due", " ")).toBeNull();
  expect(dueRule(before, "x")).toBeNull();
});
