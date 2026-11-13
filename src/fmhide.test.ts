import { expect, test } from "vitest";
import { Compartment, EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { frontMatterHide, middleChange, reloadSpec, replaceAll, stampSelection, undoHistory } from "./fmhide";
import { stampChange } from "./frontmatter";

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

test("hidden: after a full replace (load, restore) typing lands after the block", () => {
  let s = mk(true, "old");
  s = s.update(replaceAll(s.doc, FM + "restored")).state;
  expect(s.selection.main.head).toBe(FM.length);
  const at = s.selection.main.head;
  s = s.update({ changes: { from: at, insert: "x" }, userEvent: "input.type" }).state;
  expect(s.doc.toString()).toBe(FM + "xrestored");
});

test("shown: a stamp keeps the caret on the front-matter line being edited", () => {
  const sent = "---\ntags: [a, b]\nmodified: 2026-01-01T00:00:00+00:00\n---\n";
  const block = "---\ntags: [a, b]\nmodified: 2026-10-27T09:00:00+00:00\n---\n";
  let s = mk(false, sent + "body");
  const caret = sent.indexOf("b]"); // inside the tags line
  s = s.update({ selection: EditorSelection.cursor(caret) }).state;
  const c = stampChange(s.doc.toString(), block, sent)!;
  const changes = s.changes(c);
  s = s.update({ changes, selection: s.selection.map(changes, 1) }).state;
  expect(s.doc.toString()).toBe(block + "body");
  expect(s.selection.main.head).toBe(caret);
});

test("a load empties the undo history: undo never brings back the previous note", () => {
  const h = undoHistory();
  let s = EditorState.create({ doc: "note A", extensions: [h.extension] });
  const run = (cmd: typeof undo) => cmd({ state: s, dispatch: (tr: Transaction) => void (s = tr.state) });
  s = s.update({ changes: { from: 6, insert: "!" }, userEvent: "input.type" }).state;
  s = s.update(replaceAll(s.doc, "note B")).state; // load B
  for (const spec of h.reset) s = s.update(spec).state;
  expect(run(undo)).toBe(false);
  expect(s.doc.toString()).toBe("note B");
  s = s.update({ changes: { from: 6, insert: "?" }, userEvent: "input.type" }).state;
  expect(run(undo)).toBe(true); // edits after the load still undo
  expect(s.doc.toString()).toBe("note B");
});

test("stampSelection: no selection unless the caret sits on the stamp (a selection closes an open autocomplete)", () => {
  const body = mk(false, FM + "see [[me");
  const c = body.changes(stampChange(body.doc.toString(), "---\ncreated: 1\nmodified: 2\n---\n", FM)!);
  expect(stampSelection(body.selection.replaceRange(EditorSelection.cursor(body.doc.length)), c)).toBeUndefined();
  const empty = EditorState.create({ doc: "" });
  const e = empty.changes({ from: 0, insert: FM });
  expect(stampSelection(empty.selection, e)!.main.head).toBe(FM.length);
});

const apply = (a: string, b: string) => { const c = middleChange(a, b); return c ? a.slice(0, c.from) + c.insert + a.slice(c.to) : a; };

test("middleChange: equal is null; every edit shape round-trips with the smallest span", () => {
  expect(middleChange("abc", "abc")).toBeNull();
  expect(middleChange("", "")).toBeNull();
  expect(middleChange("bc", "abc")).toEqual({ from: 0, to: 0, insert: "a" }); // insert at start
  expect(middleChange("ac", "abc")).toEqual({ from: 1, to: 1, insert: "b" }); // middle
  expect(middleChange("ab", "abc")).toEqual({ from: 2, to: 2, insert: "c" }); // end
  expect(middleChange("abc", "ac")).toEqual({ from: 1, to: 2, insert: "" }); // delete
  expect(middleChange("abc", "aXc")).toEqual({ from: 1, to: 2, insert: "X" }); // replace
  expect(middleChange("", "abc")).toEqual({ from: 0, to: 0, insert: "abc" });
  expect(middleChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
});

test("middleChange: prefix and suffix never overlap", () => {
  for (const [a, b] of [["aaa", "aa"], ["aa", "aaa"], ["abab", "ab"], ["ab", "abab"], ["aXa", "aa"], ["aba", "ababa"]]) {
    const c = middleChange(a, b)!;
    expect(c.from).toBeLessThanOrEqual(c.to);
    expect(c.from + (a.length - c.to)).toBeLessThanOrEqual(Math.min(a.length, b.length));
    expect(apply(a, b)).toBe(b);
  }
});

test("middleChange: never splits a surrogate pair", () => {
  // 😀 = D83D DE00, 😁 = D83D DE01: same high surrogate, different low
  const c = middleChange("a😀b", "a😁b")!;
  expect(c).toEqual({ from: 1, to: 3, insert: "😁" });
  expect(apply("a😀b", "a😁b")).toBe("a😁b");
  // same low surrogate, different high (😀 vs another pair ending DE00)
  const d = middleChange("a\ud83d\ude00", "a\ud83e\ude00")!;
  expect(d).toEqual({ from: 1, to: 3, insert: "\ud83e\ude00" });
});

test("reloadSpec: caret and a selection range stay on the same text when lines are added above", () => {
  let s = mk(true, "line1\nline2\nline3");
  s = s.update({ selection: { anchor: 8, head: 10 } }).state; // inside line2
  s = s.update(reloadSpec(s, "new\nline1\nline2\nline3")!).state;
  expect([s.selection.main.anchor, s.selection.main.head]).toEqual([12, 14]);
  expect(s.sliceDoc(12, 14)).toBe("ne");
});

test("reloadSpec: CRLF text on an LF document is a minimal change ending in the same doc as a full replace", () => {
  let s = mk(true, "a\nb\nc");
  s = s.update({ selection: { anchor: 4 } }).state; // start of "c"
  const full = s.update(replaceAll(s.doc, "x\r\na\r\nb\r\nc")).state.doc.toString();
  const spec = reloadSpec(s, "x\r\na\r\nb\r\nc")!;
  const r = s.update(spec).state;
  expect(r.doc.toString()).toBe(full);
  expect(r.doc.toString()).toBe("x\na\nb\nc");
  expect(r.selection.main.head).toBe(6); // moved with its text
  expect(reloadSpec(r, "x\r\na\r\nb\r\nc")).toBeNull(); // unchanged CRLF reload: nothing to do
});

test("reloadSpec: identical text is null", () => {
  expect(reloadSpec(mk(true, "same"), "same")).toBeNull();
});

test("hidden: a reload that grows the front matter leaves the caret after the block", () => {
  let s = mk(true, "body text");
  s = s.update({ selection: { anchor: 0 } }).state;
  s = s.update(reloadSpec(s, FM + "body text")!).state;
  expect(s.selection.main.head).toBeGreaterThanOrEqual(FM.length);
});
