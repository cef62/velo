import { expect, test } from "vitest";
import { History } from "./history";

test("back/forward and truncation", () => { const h = new History(); h.visit("a"); h.visit("b"); h.visit("c");
  expect(h.back(() => true)).toBe("b"); expect(h.back(() => true)).toBe("a"); expect(h.back(() => true)).toBeNull();
  expect(h.forward(() => true)).toBe("b"); h.visit("d"); expect(h.forward(() => true)).toBeNull(); expect(h.back(() => true)).toBe("b"); });
test("repeat visit collapses", () => { const h = new History(); h.visit("a"); h.visit("a"); expect(h.back(() => true)).toBeNull(); });
test("missing entries skipped", () => { const h = new History(); h.visit("a"); h.visit("gone"); h.visit("c");
  expect(h.back((p) => p !== "gone")).toBe("a"); expect(h.forward((p) => p !== "gone")).toBe("c"); });
test("rename follows", () => { const h = new History(); h.visit("a.md"); h.visit("b.md"); h.rename("a.md", "a.md.age"); expect(h.back(() => true)).toBe("a.md.age"); });
test("canBack/canForward", () => { const h = new History(); expect([h.canBack, h.canForward]).toEqual([false, false]);
  h.visit("a"); h.visit("b"); expect([h.canBack, h.canForward]).toEqual([true, false]); h.back(() => true); expect([h.canBack, h.canForward]).toEqual([false, true]); });
test("remove keeps the cursor on the same entry", () => { const h = new History(); for (const p of ["a", "b", "c", "d"]) h.visit(p);
  h.back(() => true); h.back(() => true); // at b
  h.remove("a"); expect(h.back(() => true)).toBeNull(); expect(h.forward(() => true)).toBe("c");
  h.remove("d"); expect(h.forward(() => true)).toBeNull(); expect(h.back(() => true)).toBe("b"); });
test("remove of the cursor entry lands on the right neighbor", () => { const h = new History(); for (const p of ["a", "b", "c"]) h.visit(p);
  h.back(() => true); h.remove("b"); expect(h.back(() => true)).toBe("a"); expect(h.forward(() => true)).toBe("c"); });
test("auto load is recorded on first edit only", () => { const h = new History(); h.loaded("a", "explicit"); h.loaded("b", "auto");
  expect(h.canForward).toBe(false); h.edited("b"); expect(h.back(() => true)).toBe("a"); h.forward(() => true); h.edited("b"); expect(h.canForward).toBe(false); });
test("auto load not recorded without edit; nav and explicit", () => { const h = new History(); h.loaded("a", "explicit"); h.loaded("b", "auto"); h.loaded("c", "explicit");
  h.edited("b"); expect(h.back(() => true)).toBe("a"); h.loaded("a", "nav"); h.edited("a"); expect(h.forward(() => true)).toBe("c"); });
test("back from an auto-shown note returns to the note it replaced", () => { const h = new History(); h.loaded("x", "explicit"); h.loaded("a", "explicit"); h.loaded("b", "auto");
  expect(h.canBack).toBe(true); expect(h.back(() => true)).toBe("a"); h.loaded("a", "nav"); expect(h.back(() => true)).toBe("x"); });
test("undo of a back from an auto-shown note leaves the cursor in place", () => { const h = new History(); h.loaded("x", "explicit"); h.loaded("a", "explicit"); h.loaded("b", "auto");
  expect(h.back(() => true)).toBe("a"); h.undo(); expect(h.back(() => true)).toBe("a");
  h.loaded("a", "nav"); expect(h.back(() => true)).toBe("x"); h.undo(); expect(h.back(() => true)).toBe("x"); });
test("auto-shown note equal to the cursor entry steps back normally", () => { const h = new History(); h.loaded("x", "explicit"); h.loaded("a", "explicit"); h.loaded("a", "auto");
  expect(h.back(() => true)).toBe("x"); });
