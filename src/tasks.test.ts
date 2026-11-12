import { expect, test } from "vitest";
import { TASK_ITEM } from "./preview";
import { Text } from "@codemirror/state";
import type { TaskItem } from "./api";
import { byNote, dueRule, localToday, sameTask, toggleTaskAt, toggleTaskLine } from "./tasks";
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
  expect(dueRule("overdue:", " ")).toBeNull();
  expect(dueRule("x due:", " ")).toEqual({ from: 2, insert: "📅 " });
  expect(dueRule("due:", " ")).toEqual({ from: 0, insert: "📅 " });
});

test("toggleTaskAt: the whole-line change for the line holding pos (rich checkbox + Editor.toggleTask)", () => {
  const doc = Text.of(["# T", "- [ ] buy milk", "- [x] done ✅ 2026-01-01", "plain"]);
  const l2 = doc.line(2), l3 = doc.line(3);
  expect(toggleTaskAt(doc, l2.from + 3, "2026-10-27")).toEqual({ from: l2.from, to: l2.to, insert: "- [x] buy milk @done(2026-10-27)" });
  expect(toggleTaskAt(doc, l3.from + 3, "2026-10-27")).toEqual({ from: l3.from, to: l3.to, insert: "- [ ] done" });
  expect(toggleTaskAt(doc, doc.line(4).from, "2026-10-27")).toBeNull();
});

test("byNote groups by path in first-appearance order", () => {
  const t = (path: string, text: string) => ({ path, title: path.toUpperCase(), text });
  const g = byNote([t("b", "1"), t("a", "2"), t("b", "3")]);
  expect(g.map((x) => [x.title, x.items.map((i) => i.text)])).toEqual([["B", ["1", "3"]], ["A", ["2"]]]);
  expect(byNote([])).toEqual([]);
});

test("a task row re-renders when only archived changes", () => {
  const t: TaskItem = { path: "/n/A.md", title: "A", line: 1, text: "x", due: null, done: false, done_on: null, line_text: "- [ ] x", archived: false };
  expect(sameTask(t, { ...t })).toBe(true);
  expect(sameTask(t, { ...t, archived: true })).toBe(false);
});
