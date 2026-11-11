import { beforeEach, expect, test } from "vitest";
import { MAX, clampPos, dropPos, getPos, renamePos, setPos } from "./positions";

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
beforeEach(() => store.clear());

const pos = (n: number) => ({ a: n, h: n, t: n, m: 0 });

test("the 51st note evicts the least recently used", () => {
  for (let i = 0; i <= MAX; i++) setPos(`n${i}.md`, pos(i));
  expect(getPos("n0.md")).toBeUndefined();
  expect(getPos("n1.md")).toEqual(pos(1));
  setPos("n1.md", pos(9)); // touching n1 makes n2 the oldest
  setPos("new.md", pos(0));
  expect(getPos("n1.md")).toEqual(pos(9));
  expect(getPos("n2.md")).toBeUndefined();
});

test("rename moves an entry, drop removes it", () => {
  setPos("a.md", pos(3));
  renamePos("a.md", "a.md.age");
  expect(getPos("a.md")).toBeUndefined();
  expect(getPos("a.md.age")).toEqual(pos(3));
  dropPos("a.md.age");
  expect(getPos("a.md.age")).toBeUndefined();
});

test("clampPos caps offsets at the document length", () => {
  expect(clampPos({ a: 90, h: 100, t: 50, m: -7 }, 60)).toEqual({ a: 60, h: 60, t: 50, m: -7 });
});

test("malformed stored data reads as empty", () => {
  for (const bad of ["{", "{}", '[["a.md",{"a":"x"}]]', "[1]"]) {
    store.set("velo.positions", bad);
    expect(getPos("a.md")).toBeUndefined();
  }
  setPos("a.md", pos(1)); // and writing recovers
  expect(getPos("a.md")).toEqual(pos(1));
});
