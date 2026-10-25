import { expect, test } from "vitest";
import { enterAction, fold, moveSelection } from "./search";

const h = (path: string, title: string) => ({ path, title, snippet: "", mtime: 0, encrypted: false });
test("fold", () => expect(fold("Résumé CAFÉ")).toBe("resume cafe"));
test("enter opens exact title match", () => expect(enterAction("foo", [h("Foobar.md", "Foobar"), h("FOO.md", "FOO")])).toEqual({ kind: "open", path: "FOO.md" }));
test("enter creates when no exact match", () => expect(enterAction(" foo ", [h("Foobar.md", "Foobar")])).toEqual({ kind: "create", title: "foo" }));
test("enter on empty query does nothing", () => expect(enterAction("  ", [])).toBeNull());
test("selection clamps", () => { expect(moveSelection(0, -1, 3)).toBe(0); expect(moveSelection(2, 1, 3)).toBe(2); expect(moveSelection(0, 1, 0)).toBe(-1); });
