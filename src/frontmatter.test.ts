import { describe, expect, it } from "vitest";
import { frontMatterRange, stampChange, stripFrontMatter, wordCount } from "./frontmatter";

describe("frontMatterRange", () => {
  it("none", () => {
    expect(frontMatterRange("hello")).toBeNull();
    expect(frontMatterRange("")).toBeNull();
    expect(frontMatterRange("--- \na: 1\n---\n")).toBeNull();
    expect(frontMatterRange("x\n---\na: 1\n---\n")).toBeNull();
  });
  it("closed", () => {
    const t = "---\na: 1\n---\nbody";
    expect(frontMatterRange(t)).toEqual({ from: 0, to: 13 });
    expect(frontMatterRange("---\n---")).toEqual({ from: 0, to: 7 });
  });
  it("unclosed or too far", () => {
    expect(frontMatterRange("---\na: 1\n")).toBeNull();
    expect(frontMatterRange("---\n" + "a: 1\n".repeat(250) + "---\n")).toBeNull();
  });
  it("CRLF", () => {
    const t = "---\r\na: 1\r\n---\r\nbody";
    expect(frontMatterRange(t)).toEqual({ from: 0, to: 16 });
    expect(stripFrontMatter(t)).toBe("body");
  });
});

describe("strip and count", () => {
  it("strips", () => {
    expect(stripFrontMatter("---\na: 1\n---\n")).toBe("");
    expect(stripFrontMatter("plain")).toBe("plain");
  });
  it("counts body words", () => {
    expect(wordCount("---\ncreated: x\n---\nhello big world")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("stampChange", () => {
  const B = "---\nmodified: 2\n---\n";
  it("replaces an unchanged block, inserts when none was sent", () => {
    expect(stampChange("---\nmodified: 1\n---\nbody", B, "---\nmodified: 1\n---\n")).toEqual({ from: 14, to: 15, insert: "2" }); // only the differing part
    expect(stampChange("body", B, null)).toEqual({ from: 0, to: 0, insert: B });
  });
  it("skips when the block changed meanwhile or already matches", () => {
    expect(stampChange("---\nmodified: x\n---\nbody", B, "---\nmodified: 1\n---\n")).toBeNull();
    expect(stampChange("---\na: 1\n---\nbody", B, null)).toBeNull(); // user typed a block during the save
    expect(stampChange(B + "body", B, B)).toBeNull();
  });
});
