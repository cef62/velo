import { expect, test } from "vitest";
import { stepPaneTab } from "./paneTabs";

test("←/→ step through Notes · Tasks · Timeline and clamp at the ends", () => {
  expect(stepPaneTab("notes", "ArrowRight")).toBe("tasks");
  expect(stepPaneTab("tasks", "ArrowRight")).toBe("timeline");
  expect(stepPaneTab("timeline", "ArrowRight")).toBeNull();
  expect(stepPaneTab("notes", "ArrowLeft")).toBeNull();
  expect(stepPaneTab("timeline", "Home")).toBe("notes");
  expect(stepPaneTab("notes", "End")).toBe("timeline");
  expect(stepPaneTab("notes", "ArrowDown")).toBeNull();
});
