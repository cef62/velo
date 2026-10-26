import { expect, test } from "vitest";
import { Compartment, EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { frontMatterHide } from "./fmhide";

const FM = "---\ncreated: 1\n---\n"; // 19 chars
const mk = (hidden: boolean, doc = FM + "body") => EditorState.create({ doc, extensions: frontMatterHide(hidden) });

test("hidden: the caret can't land inside or before the block", () => {
  const s = mk(true);
  expect(s.update({ selection: EditorSelection.cursor(0) }).state.selection.main.head).toBe(FM.length);
  const all = s.update({ selection: EditorSelection.range(0, s.doc.length) }).state.selection.main;
  expect([all.from, all.to]).toEqual([FM.length, s.doc.length]); // select all = the body
  expect(s.update({ selection: EditorSelection.cursor(20) }).state.selection.main.head).toBe(20);
});

test("hidden: user edits can't touch the block, other changes can", () => {
  const s = mk(true);
  expect(s.update({ changes: { from: FM.length - 1, to: FM.length }, userEvent: "delete.backward" }).state.doc.toString()).toBe(FM + "body");
  // (an insert exactly at 0 sits on the filter's edge; the caret guard keeps user input from ever starting there)
  expect(s.update({ changes: { from: 2, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe(FM + "body");
  expect(s.update({ changes: { from: FM.length, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe(FM + "xbody");
  expect(s.update({ changes: { from: 0, to: FM.length, insert: "---\n---\n" } }).state.doc.toString()).toBe("---\n---\nbody"); // stamp
});

test("shown: the block is editable", () => {
  const s = mk(false);
  expect(s.update({ selection: EditorSelection.cursor(0) }).state.selection.main.head).toBe(0);
  expect(s.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe("x" + FM + "body");
});

test("hidden: a replace touching block and body keeps the body part", () => {
  const s = mk(true, FM + "x 1 1");
  const tr = s.update({ changes: [{ from: 13, to: 14, insert: "9" }, { from: 21, to: 22, insert: "9" }, { from: 23, to: 24, insert: "9" }], userEvent: "input.replace.all" });
  expect(tr.state.doc.toString()).toBe(FM + "x 9 9");
});

test("hidden: undo works, also for a block edit made while shown", () => {
  const hide = new Compartment();
  let s = EditorState.create({ doc: FM + "body", extensions: [history(), hide.of(frontMatterHide(false))] });
  const run = (cmd: typeof undo) => cmd({ state: s, dispatch: (tr: Transaction) => void (s = tr.state) });
  s = s.update({ changes: { from: 4, insert: "z" }, userEvent: "input.type" }).state; // in the shown block
  s = s.update({ effects: hide.reconfigure(frontMatterHide(true)) }).state;
  s = s.update({ changes: { from: s.doc.length, insert: "!" }, userEvent: "input.type" }).state;
  expect(run(undo)).toBe(true);
  expect(s.doc.toString()).toBe("---\nzcreated: 1\n---\nbody");
  expect(run(undo)).toBe(true);
  expect(s.doc.toString()).toBe(FM + "body");
  expect(run(redo)).toBe(true);
  expect(s.doc.toString()).toBe("---\nzcreated: 1\n---\nbody");
});
