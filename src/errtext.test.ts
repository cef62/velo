import { expect, test } from "vitest";
import { errText } from "./errtext";

test("indexing rejections read as Still indexing, raw or from the saver", () => {
  expect(errText("indexing")).toBe("Still indexing…");
  expect(errText("Save failed: indexing")).toBe("Still indexing…");
  expect(errText("not-found")).toBe("Note no longer exists");
  expect(errText("Save failed: locked")).toBe("Save failed: locked");
});
