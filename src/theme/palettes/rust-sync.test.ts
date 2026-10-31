import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { palettes } from ".";

test("Rust PALETTES (settings.rs) lists the same slugs as the TS palettes", () => {
  const rs = readFileSync(new URL("../../../src-tauri/src/settings.rs", import.meta.url), "utf8");
  const list = rs.match(/pub const PALETTES: \[&str; \d+\] = \[([^\]]*)\]/)?.[1];
  expect(list?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1))).toEqual(Object.keys(palettes));
});
