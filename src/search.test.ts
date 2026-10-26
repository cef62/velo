import { expect, test } from "vitest";
import { enterAction, fold, moveSelection } from "./search";

const h = (path: string, title: string) => ({ path, title, snippet: "", mtime: 0, encrypted: false });
test("fold", () => expect(fold("Résumé CAFÉ")).toBe("resume cafe"));
const foobar = h("Foobar.md", "Foobar");
test("enter opens the highlighted row", () => expect(enterAction("foo", [foobar, h("FOO.md", "FOO")], foobar)).toEqual({ kind: "open", path: "Foobar.md" }));
test("enter with empty query opens the highlighted row", () => expect(enterAction("", [foobar], foobar)).toEqual({ kind: "open", path: "Foobar.md" }));
test("enter with nothing highlighted: exact title opens, else create", () => {
  expect(enterAction("foo", [foobar, h("FOO.md", "FOO")], undefined)).toEqual({ kind: "open", path: "FOO.md" });
  expect(enterAction(" foo ", [], undefined)).toEqual({ kind: "create", title: "foo" });
});
test("shift+enter forces create unless the exact title exists", () => {
  expect(enterAction(" foo ", [foobar], foobar, true)).toEqual({ kind: "create", title: "foo" });
  expect(enterAction("foo", [foobar, h("FOO.md", "FOO")], foobar, true)).toEqual({ kind: "open", path: "FOO.md" });
});
test("enter on empty query with nothing highlighted does nothing", () => {
  expect(enterAction("  ", [], undefined)).toBeNull();
  expect(enterAction("  ", [foobar], foobar, true)).toBeNull();
});
test("selection clamps", () => { expect(moveSelection(0, -1, 3)).toBe(0); expect(moveSelection(2, 1, 3)).toBe(2); expect(moveSelection(0, 1, 0)).toBe(-1); });
