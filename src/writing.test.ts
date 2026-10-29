import { expect, test } from "vitest";
import { extractTitle } from "./writing";

test("extractTitle strips markers and cuts at 60", () => {
  expect(extractTitle("## Plan\nmore")).toBe("Plan");
  expect(extractTitle("- [ ] buy milk")).toBe("buy milk");
  expect(extractTitle("\n\n  * item")).toBe("item");
  expect(Array.from(extractTitle("é".repeat(80)))).toHaveLength(60);
});
