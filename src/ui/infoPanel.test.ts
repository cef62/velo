import { expect, it } from "vitest";
import { revisionLabel } from "./InfoPanel";

it("revisionLabel returns the summary and the agent flag", () => {
  expect(revisionLabel({ id: "1.md", ts: 1, size: 1, summary: "fixed typos", agent: true })).toEqual({ summary: "fixed typos", agent: true });
  expect(revisionLabel({ id: "1.md", ts: 1, size: 1, agent: false })).toEqual({ summary: null, agent: false });
});
