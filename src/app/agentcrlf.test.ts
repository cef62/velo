import { expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import type { NoteDoc } from "../api";
import { appendSpec } from "../fmhide";
import { Controller, changedSpan } from "./controller";
import { FakeEditor, FakePreview, fakeApi, fakeUi } from "./fakes";
import { createStore, initialState } from "./store";

/** The fake editor with the real CodeMirror document: it splits \r\n, \r and \n into lines and reads back with \n, as the app's editor does (#134). */
class CmEditor extends FakeEditor {
  state = EditorState.create({ doc: "" });
  load(doc: NoteDoc) {
    const ok = super.load(doc);
    this.state = EditorState.create({ doc: doc.text });
    return ok;
  }
  getText = () => this.state.doc.toString();
  applyChange(c: { from: number; to: number; insert: string }) {
    this.state = this.state.update({ changes: c }).state;
    this.dirty = true;
    return true;
  }
  appendLine(text: string) {
    this.state = this.state.update(appendSpec(this.state.doc, text)).state; // the production spec: the fake cannot drift
    this.dirty = true;
    return true;
  }
}

async function write(note: string, req: { kind: "replace" | "append"; insert: string }) {
  const { api } = fakeApi({ A: note });
  const c = new Controller(createStore(initialState(true)), api, fakeUi().ui, { isMac: true, platform: "mac" });
  const editor = new CmEditor();
  c.attachEditor(editor);
  c.attachPreview(new FakePreview());
  await c.show("/n/A.md");
  const before = editor.getText();
  await c.onAgentWrite({ id: 1, path: "/n/A.md", base: "h", summary: "s", ...req });
  return { before, after: editor.getText() };
}

test("a byte-identical replace with CRLF text on an open CRLF note changes nothing", async () => {
  const r = await write("a\r\nb\r\nc", { kind: "replace", insert: "a\r\nb\r\nc" });
  expect(r.before).toBe("a\nb\nc");
  expect(r.after).toBe("a\nb\nc");
});

test("an edit of one line of an open CRLF note leaves no blank line", async () => {
  expect((await write("a\r\nb\r\nc", { kind: "replace", insert: "a\r\nX\r\nc" })).after).toBe("a\nX\nc");
});

test("an agent LF text into an open CRLF note changes nothing visible", async () => {
  expect((await write("a\r\nb\r\nc", { kind: "replace", insert: "a\nb\nc" })).after).toBe("a\nb\nc");
});

test("lone CR and mixed endings in agent text read as one break each", async () => {
  expect((await write("a\nb\nc", { kind: "replace", insert: "a\rb\r\nc" })).after).toBe("a\nb\nc");
  expect((await write("a\r\nb\r\nc", { kind: "replace", insert: "a\rX\r\nc\rd" })).after).toBe("a\nX\nc\nd");
});

test("an append of CRLF text to an open CRLF note adds no blank line", async () => {
  expect((await write("a\r\nb", { kind: "append", insert: "- [ ] x\r\n- [ ] y" })).after).toBe("a\nb\n- [ ] x\n- [ ] y");
});

test.each([
  ["CRLF", "x\r\ny"],
  ["lone CR", "x\ry"],
  ["mixed", "x\r\ny\rz\nw"],
])("appendSpec with %s text: no throw, no blank line, caret at the end", (_n, text) => {
  for (const doc of ["a", "a\n", "a\r\nb\r\n", ""]) {
    const s = EditorState.create({ doc });
    const out = s.update(appendSpec(s.doc, text)).state;
    const sep = s.doc.length === 0 || s.doc.toString().endsWith("\n") ? "" : "\n";
    expect(out.doc.toString()).toBe(s.doc.toString() + sep + text.replace(/\r\n?/g, "\n"));
    expect(out.selection.main.head).toBe(out.doc.length);
  }
});

test("changedSpan reads CRLF and lone CR in the new text as LF", () => {
  expect(changedSpan("a\nb\nc", "a\r\nb\r\nc")).toEqual({ from: 5, to: 5, insert: "" });
  expect(changedSpan("a\nb\nc", "a\rb\nd")).toEqual({ from: 4, to: 5, insert: "d" });
});
