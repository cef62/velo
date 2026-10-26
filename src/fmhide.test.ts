import { expect, test } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { frontMatterHide } from "./fmhide";

const FM = "---\ncreated: 1\n---\n"; // 18 chars
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
  expect(s.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe(FM + "body");
  expect(s.update({ changes: { from: FM.length, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe(FM + "xbody");
  expect(s.update({ changes: { from: 0, to: FM.length, insert: "---\n---\n" } }).state.doc.toString()).toBe("---\n---\nbody"); // stamp
});

test("shown: the block is editable", () => {
  const s = mk(false);
  expect(s.update({ selection: EditorSelection.cursor(0) }).state.selection.main.head).toBe(0);
  expect(s.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).toBe("x" + FM + "body");
});
