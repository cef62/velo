import { expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { ISOLATED } from "./fmhide";

test("an isolated change is its own undo step after typing", () => {
  let s = EditorState.create({ doc: "see Bee", extensions: history() });
  s = s.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state;
  s = s.update({ changes: { from: 5, insert: "[[" }, ...ISOLATED }).state;
  let out = "";
  undo({ state: s, dispatch: (tr) => (out = tr.state.doc.toString()) });
  expect(out).toBe("xsee Bee"); // the typing survives the undo
});
