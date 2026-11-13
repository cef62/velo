import { expect, test } from "vitest";
import { Compartment, EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { frontMatterHide, middleChange, reloadChanges, reloadSpec, replaceAll, stampSelection, undoHistory } from "./fmhide";
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

test("reloadSpec: edits before and after the caret leave the caret and a selection on the same text", () => {
  let s = mk(true, "head\nkeep caret here\ntail");
  s = s.update({ selection: { anchor: 10, head: 15 } }).state; // "caret" on the middle line
  s = s.update(reloadSpec(s, "HEAD\nkeep caret here\nTAIL")!).state;
  expect(s.doc.toString()).toBe("HEAD\nkeep caret here\nTAIL");
  expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe("caret");
  s = s.update({ selection: { anchor: 12 } }).state;
  s = s.update(reloadSpec(s, "head2\nkeep caret here\ntail2")!).state;
  expect(s.selection.main.head).toBe(12 + 1);
});

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i));
const applyAll = (a: string, cs: { from: number; to: number; insert: string }[]) => {
  let out = "", at = 0;
  for (const c of cs) { expect(c.from).toBeGreaterThanOrEqual(at); expect(c.to).toBeGreaterThanOrEqual(c.from); out += a.slice(at, c.from) + c.insert; at = c.to; }
  return out + a.slice(at);
};
const splitsPair = (t: string, i: number) => i > 0 && i < t.length && (t.charCodeAt(i - 1) & 0xfc00) === 0xd800 && (t.charCodeAt(i) & 0xfc00) === 0xdc00;
const check = (a: string, raw: string) => {
  const b = raw.replace(/\r\n?/g, "\n");
  const cs = reloadChanges(a, b);
  expect(applyAll(a, cs)).toBe(b);
  for (const c of cs) { expect(splitsPair(a, c.from)).toBe(false); expect(splitsPair(a, c.to)).toBe(false); }
  if (a === b) expect(cs).toEqual([]);
  return cs;
};

test("reloadChanges: seeded random docs round-trip, sorted, disjoint, pair-safe; equal is empty", () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  const pool = ["", "a", "b", "a", "dup", "dup", "😀", "😁x", "\ud83d", "\ude00", "line"]; // duplicates, empty lines, pairs, lone surrogates
  const doc = () => lines(rnd(9), () => pool[rnd(pool.length)]).join(rnd(2) ? "\n" : "\r\n") + (rnd(2) ? "\n" : "");
  for (let k = 0; k < 4000; k++) {
    const a = doc().replace(/\r\n?/g, "\n");
    check(a, rnd(4) ? doc() : a);
  }
});

test("reloadChanges: duplicate-line traps, moved blocks, full replace, empty sides", () => {
  const dups = lines(300, () => "same");
  const a = dups.join("\n");
  expect(check(a, [...dups.slice(0, 150), "extra", ...dups.slice(150)].join("\n")).length).toBe(1);
  expect(check(a, dups.slice(1).join("\n")).length).toBe(1);
  expect(check("A\nB\nC\nD", "B\nC\nD\nA").length).toBe(2); // A moved below
  expect(check("a\nb\nc\nx\ny", "x\ny\nc\na\nb").length).toBeGreaterThan(0);
  check("a\nb\nc", "x\ny\nz");
  check("", "abc\n");
  check("abc\n", "");
  check("", "");
  check("a\nb", "a\nb\n"); // trailing newline only
});

test("reloadChanges: a gap above the budget with no unique line is one middle change", () => {
  const a = lines(1100, (i) => (i % 2 ? "a" : "b")).join("\n"), b = lines(1100, (i) => (i % 2 ? "b" : "a")).join("\n");
  expect(check(a, b)).toEqual([middleChange(a, b)]);
});

test("reloadChanges: a big region with unique lines still gives separate hunks", () => {
  const a = lines(2000);
  const b = [...a]; b[3] = "changed top"; b[1990] = "changed bottom";
  expect(check(a.join("\n"), b.join("\n")).length).toBe(2);
});

test("reloadChanges: a 10k-line note under the char cap with two edited lines is fast", () => {
  const a = lines(10000, (i) => `line ${i} ${"x".repeat(5)}`);
  const b = [...a]; b[5] = "top edit"; b[9990] = "bottom edit";
  const [x, y] = [a.join("\n"), b.join("\n")];
  expect(x.length).toBeGreaterThan(1e5);
  const t = performance.now();
  const cs = reloadChanges(x, y);
  expect(performance.now() - t).toBeLessThan(150);
  expect(cs.length).toBe(2);
  expect(applyAll(x, cs)).toBe(y);
});

test("reloadChanges: a partly changed line keeps its common prefix and suffix", () => {
  expect(reloadChanges("abc def\nx", "abc DEF\nx")).toEqual([{ from: 4, to: 7, insert: "DEF" }]);
  let s = mk(true, "abc def\nx\ny");
  s = s.update({ selection: { anchor: 3 } }).state; // after "abc"
  s = s.update(reloadSpec(s, "abc DEF\nx\nY")!).state;
  expect(s.selection.main.head).toBe(3);
});

test("reloadChanges: common prefix and suffix lines are trimmed before the LCS budget applies", () => {
  const same = lines(1500, () => "same");
  const a = [...same, "1", "d", "d", "2", ...same].join("\n"), b = [...same, "3", "d", "d", "4", ...same].join("\n");
  expect(check(a, b).length).toBe(2); // untrimmed it would be 3004 x 3004 cells: over budget, one hunk
  expect(check([...same, "1", "d", "d", "2"].join("\n"), [...same, "3", "d", "d", "4"].join("\n")).length).toBe(2);
  expect(check(["1", "d", "d", "2", ...same].join("\n"), ["3", "d", "d", "4", ...same].join("\n")).length).toBe(2);
});

test("reloadChanges: the LCS budget is exactly 1,000,000 cells", () => {
  const mkSide = (k: number, first: string, last: string) => [first, ...lines(k, () => "d"), last].join("\n");
  expect(check(mkSide(998, "1", "2"), mkSide(998, "3", "4")).length).toBe(2); // 1000 x 1000: exact LCS
  expect(check(mkSide(998, "1", "2"), mkSide(999, "3", "4")).length).toBe(1); // 1000 x 1001: one hunk
});

test("reloadChanges: the nesting shape that made patience quadratic and overflowed the stack stays cheap and right", () => {
  const D = 10000, o = Array(1000).fill("f"), n = Array(1000).fill("g");
  for (let d = 1; d <= D; d++) { o.push(`m${d}`); if (d > 1) o.push(`m${d - 1}`); n.push(`m${d}`); }
  const [x, y] = [o.join("\n"), n.join("\n")];
  const t = performance.now();
  const cs = reloadChanges(x, y);
  expect(performance.now() - t).toBeLessThan(150);
  expect(applyAll(x, cs)).toBe(y);
});

test("reloadChanges: a differing region above the char cap is exactly the single middle change, just under it is diffed", () => {
  const mkDoc = (n: number, first: string, last: string) => [first + "a".repeat(n), "mid", "b".repeat(n) + last].join("\n");
  // old + new region: 4 x 150k = 600k chars (> 512 KB) vs 4 x 100k = 400k (<)
  const [bigA, bigB] = [mkDoc(150000, "1", "2"), mkDoc(150000, "3", "4")];
  expect(reloadChanges(bigA, bigB)).toEqual([middleChange(bigA, bigB)]);
  const [smallA, smallB] = [mkDoc(100000, "1", "2"), mkDoc(100000, "3", "4")];
  expect(check(smallA, smallB).length).toBe(2);
});

const nesting = (D: number) => {
  const o = Array(1000).fill("f"), n = Array(1000).fill("g");
  for (let d = 1; d <= D; d++) { o.push(`m${d}`); if (d > 1) o.push(`m${d - 1}`); n.push(`m${d}`); }
  return [o.join("\n"), n.join("\n")];
};

test("reloadChanges: under the char cap, the shared work budget stops the nesting shape early (5 hunks, not 101)", () => {
  const [x, y] = nesting(24000); // differing region about 464 KB: under MAX_REGION_CHARS, so it reaches lineDiff
  const cs = reloadChanges(x, y);
  expect(applyAll(x, cs)).toBe(y);
  expect(cs.length).toBeLessThanOrEqual(10); // without the shared budget the patience recursion goes 100 levels deep: 101 hunks
});

test("reloadChanges: the outer line prefix/suffix trim keeps a big note with two small edits under the char cap", () => {
  const same = lines(30000, (i) => `unchanged line number ${i} with some padding text`); // about 1.4 MB
  const a = [...same.slice(0, 15000), "edit one", ...same.slice(15000, 15010), "edit two", ...same.slice(15010)];
  const b = [...same.slice(0, 15000), "EDIT ONE", ...same.slice(15000, 15010), "EDIT TWO", ...same.slice(15010)];
  const [x, y] = [a.join("\n"), b.join("\n")];
  expect(x.length).toBeGreaterThan(600 * 1024);
  expect(check(x, y).length).toBe(2); // untrimmed, the cap would count the whole note and return one change
});

test("reloadChanges: the nesting shape at D = 100k is bounded by the shared work budget, not just the depth cap", () => {
  const D = 100000, o = Array(1000).fill("f"), n = Array(1000).fill("g");
  for (let d = 1; d <= D; d++) { o.push(`m${d}`); if (d > 1) o.push(`m${d - 1}`); n.push(`m${d}`); }
  const [x, y] = [o.join("\n"), n.join("\n")];
  const t = performance.now();
  const cs = reloadChanges(x, y);
  expect(performance.now() - t).toBeLessThan(300); // about 870 ms with only the depth cap
  expect(applyAll(x, cs)).toBe(y);
});

test("reloadChanges: a last line without a newline matches the same line once a newline follows (and back)", () => {
  for (const [a, b, at, kept] of [["a\nb\nfoo", "a\nB\nfoo\nbar", 5, "foo"], ["a\nB\nfoo\nbar", "a\nb\nfoo", 5, "foo"], ["head\nkeep caret here", "HEAD\nkeep caret here\ntail", 8, "keep caret here"], ["a\nb\nfoo\n", "a\nB\nfoo", 5, "foo"]] as const) {
    check(a, b);
    let s = mk(true, a);
    s = s.update({ selection: { anchor: at } }).state;
    s = s.update(reloadSpec(s, b)!).state;
    expect(s.doc.toString()).toBe(b);
    const l = s.doc.lineAt(s.selection.main.head);
    expect([l.text, s.selection.main.head - l.from]).toEqual([kept, at - a.indexOf(kept)]);
  }
});

test("reloadSpec: a throwing or wrong diff falls back to the single middle change with the right text", () => {
  const s = mk(true, "a\nb\nc\nd");
  const want = "a\nB\nc\nD";
  const bad: ((a: string, b: string) => { from: number; to: number; insert: string }[])[] = [
    () => { throw new RangeError("boom"); },
    () => [{ from: 0, to: 1, insert: "zz" }], // applies, but not to the new text
    () => [{ from: 6, to: 7, insert: "D" }, { from: 2, to: 3, insert: "B" }], // unsorted
    () => [{ from: 0, to: 99, insert: want }], // out of range
  ];
  for (const diff of bad) {
    const spec = reloadSpec(s, want, diff)!;
    expect(s.update(spec).state.doc.toString()).toBe(want);
    const cs: unknown[] = [];
    spec.changes.iterChanges((fa, ta, _fb, _tb, ins) => cs.push([fa, ta, ins.toString()]));
    expect(cs).toEqual([[2, 7, "B\nc\nD"]]);
  }
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

// Reload then read back where a selection landed, as [line text, column] of anchor and head.
const reloaded = (a: string, b: string, anchor: number, head = anchor) => {
  let s = mk(true, a);
  s = s.update({ selection: { anchor, head } }).state;
  s = s.update(reloadSpec(s, b)!).state;
  expect(s.doc.toString()).toBe(b);
  const at = (p: number) => { const l = s.doc.lineAt(p); return [l.text, p - l.from]; };
  return { s, head: at(s.selection.main.head), sel: s.sliceDoc(s.selection.main.from, s.selection.main.to) };
};

test("reloadSpec: a caret at a line start stays on its line when lines are inserted directly above it", () => {
  expect(reloaded("head\nkeep caret here\ntail", "head\nextra\nkeep caret here\nTAIL", 5).head).toEqual(["keep caret here", 0]);
  expect(reloaded("head\nkeep\ntail", "head\nx\ny\nkeep\ntail", 5).head).toEqual(["keep", 0]);
});

test("reloadSpec: a caret at a line end stays there when lines are inserted directly below it", () => {
  expect(reloaded("head\nkeep\ntail", "head\nkeep\nx\ny\ntail", 9).head).toEqual(["keep", 4]);
  expect(reloaded("head\nkeep", "head\nkeep\nx\ny", 9).head).toEqual(["keep", 4]); // end of document, lines appended
  expect(reloaded("head\nkeep", "HEAD\nkeep\n", 9).head).toEqual(["keep", 4]); // unterminated last line gains a newline
});

test("reloadSpec: a caret on an empty line stays on it with lines inserted above and below", () => {
  expect(reloaded("a\n\nb", "a\nx\n\ny\nb", 2).head).toEqual(["", 0]);
  expect(reloaded("a\n\n", "a\nx\n\ny\n", 2).head).toEqual(["", 0]);
});

test("reloadSpec: a caret at the document start stays with its line when lines are inserted at the top", () => {
  expect(reloaded("first\nsecond", "x\ny\nfirst\nsecond", 0).head).toEqual(["first", 0]);
});

test("reloadSpec: a selection of whole lines still selects exactly those lines with lines inserted above and below", () => {
  const fwd = reloaded("a\nb\nc\nd", "a\nX\nb\nc\nY\nd", 2, 6); // "b\nc\n"
  expect(fwd.sel).toBe("b\nc\n");
  const back = reloaded("a\nb\nc\nd", "a\nX\nb\nc\nY\nd", 6, 2); // dragged upward
  expect([back.sel, back.s.selection.main.head < back.s.selection.main.anchor]).toEqual(["b\nc\n", true]);
});

test("reloadSpec: a caret inside a replaced line keeps its column", () => {
  expect(reloaded("a\nbcd\nc", "a\nbXd\nc", 4).head).toEqual(["bXd", 2]);
});

test("reloadSpec: lines inserted above a caret at the body start keep it on the body, not in the hidden front matter", () => {
  const s = mk(true, FM + "body").update({ selection: { anchor: FM.length } }).state;
  const r = s.update(reloadSpec(s, FM + "x\nbody")!).state;
  expect(r.doc.lineAt(r.selection.main.head).text).toBe("body");
});

test("reloadSpec: a reload that only inserts whole lines keeps the line text and column under the caret (seeded)", () => {
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let t = 0; t < 300; t++) {
    const old = Array.from({ length: 1 + rnd(8) }, (_, i) => (rnd(4) ? `line ${i}` : ""));
    old.push("last"); // an empty last line plus lines appended after it is ambiguous with the same lines inserted before it
    const nw = [...old];
    for (let k = rnd(4); k >= 0; k--) nw.splice(rnd(nw.length + 1), 0, ...Array.from({ length: 1 + rnd(3) }, (_, j) => `ins ${t}.${k}.${j}`));
    const a = old.join("\n"), pos = rnd(a.length + 1), ls = pos ? a.lastIndexOf("\n", pos - 1) + 1 : 0;
    const r = reloaded(a, nw.join("\n"), pos);
    expect(r.head, `${JSON.stringify(a)} -> ${JSON.stringify(nw.join("\n"))} @${pos}`).toEqual([a.slice(ls).split("\n")[0], pos - ls]);
  }
});
