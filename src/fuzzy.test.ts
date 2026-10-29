import { expect, test } from "vitest";
import { prepare, rank, tier } from "./fuzzy";

test("tiers in spec order", () => {
  expect(["mee", "meeting notes", "team meeting", "ameeba", "my extra e", "xyz"].map((f) => tier("mee", f))).toEqual([5, 4, 3, 2, 1, 0]);
  expect(tier("", "anything")).toBe(4);
});

type T = { name: string; modified: number };
const byModified = (a: T, b: T) => b.modified - a.modified;

test("rank folds accents and breaks ties by the tie function", () => {
  const items = prepare<T>([{ name: "Résumé", modified: 1 }, { name: "Resurrect", modified: 3 }, { name: "Other", modified: 9 }], (t) => t.name);
  expect(rank("resu", items, byModified).map((t) => t.name)).toEqual(["Resurrect", "Résumé"]);
});

test("rank caps at limit", () => {
  const items = prepare(Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, modified: i })), (t) => t.name);
  expect(rank("n", items, byModified)).toHaveLength(20);
  expect(rank("n", items, byModified, 5)).toHaveLength(5);
});

test("rank 10k items under 50 ms", () => {
  const word = () => Math.random().toString(36).slice(2, 2 + 3 + Math.floor(Math.random() * 6));
  const items = prepare(Array.from({ length: 10_000 }, (_, i) => ({ name: `${word()} ${word()} ${word()}`, modified: i })), (t) => t.name);
  const t0 = performance.now();
  rank("ab", items, byModified);
  expect(performance.now() - t0).toBeLessThan(50);
});
