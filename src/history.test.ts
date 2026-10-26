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
