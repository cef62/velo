import { expect, test } from "vitest";
import { emptyWatermark, externalUrl, renderMarkdown, shouldAutoEdit } from "./preview";

test("wikilink existing", () => expect(renderMarkdown("see [[Foo Bar]]", () => true)).toContain('<a href="#" class="wikilink" data-title="Foo Bar">Foo Bar</a>'));
test("wikilink missing", () => expect(renderMarkdown("[[Nope]]", () => false)).toContain('class="wikilink missing"'));
test("renders_html_as_text", () => {
  const out = renderMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>", () => true);
  expect(out).not.toContain("<script");
  expect(out).not.toContain("<img");
});
test("escapes title", () => expect(renderMarkdown('[["><b>x</b>]]', () => true)).not.toContain("<b>"));
test("externalUrl only http(s)", () => {
  expect(externalUrl("https://a.b/c")).toBe("https://a.b/c");
  expect(externalUrl("http://a.b")).toBe("http://a.b");
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "velo://x", "#", "rel/path", ""]) expect(externalUrl(u)).toBeNull();
});
test("emptyWatermark copy", () => expect(emptyWatermark("⌘⇧P")).toBe("Empty note — press ⌘⇧P to edit"));
test("renderMarkdown empty unaffected", () => expect(renderMarkdown("", () => true)).toBe(""));
test("shouldAutoEdit", () => {
  expect(shouldAutoEdit({ created: true, body: "x", previewOn: false })).toBe(true);
  expect(shouldAutoEdit({ created: false, body: "", previewOn: true })).toBe(true);
  expect(shouldAutoEdit({ created: false, body: " \n\t", previewOn: true })).toBe(true);
  expect(shouldAutoEdit({ created: false, body: "hi", previewOn: true })).toBe(false);
  expect(shouldAutoEdit({ created: false, body: "", previewOn: false })).toBe(false);
});
