import { expect, test } from "vitest";
import { emptyWatermark, externalUrl, afterOpen, renderInline, renderMarkdown, shouldAutoEdit } from "./preview";

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
test("afterOpen", () => {
  const base = { created: false, body: "hi", layout: "vertical" as const, previewOn: true };
  expect(afterOpen({ ...base, source: "enter" })).toEqual({ leavePreview: true, focusEditor: true });
  expect(afterOpen({ ...base, layout: "horizontal", source: "enter" })).toEqual({ leavePreview: false, focusEditor: true });
  expect(afterOpen({ ...base, created: true, source: "wikilink" })).toEqual({ leavePreview: true, focusEditor: true });
  expect(afterOpen({ ...base, source: "wikilink" })).toEqual({ leavePreview: false, focusEditor: false });
  expect(afterOpen({ ...base, body: " ", source: "wikilink" })).toEqual({ leavePreview: true, focusEditor: true });
});
test("preview renders tag chips, not in code or headings", () => {
  const out = renderMarkdown("# Head\n\n#work and `#code` C#\n\n```\n#fence\n```", () => true);
  expect(out).toContain('class="tag" data-tag="work"');
  expect(out).not.toContain('data-tag="code"');
  expect(out).not.toContain('data-tag="fence"');
  expect(out).not.toContain('data-tag="Head"');
});
test("tag chip escapes", () => expect(renderMarkdown('#a"b', () => true)).not.toContain('data-tag="a"b"'));
test("task lists: checkboxes with source lines, nested and in quotes", () => {
  const out = renderMarkdown("intro\n\n- [ ] todo\n- [x] done\n  - [X] nested\n\n> - [ ] quoted\n\n- not [ ] a task", () => true);
  expect(out).toContain('<input type="checkbox" class="task" data-line="2"> todo');
  expect(out).toContain('<input type="checkbox" class="task" data-line="3" checked> done');
  expect(out).toContain('data-line="4" checked> nested');
  expect(out).toContain('data-line="6"> quoted');
  expect(out.match(/class="task"/g)).toHaveLength(4);
  expect(out).toContain('<li class="task-list-item">');
});
test("GitHub alerts, tables, strikethrough, autolinks, footnotes", () => {
  const out = renderMarkdown("> [!WARNING]\n> Careful **now**\n\n> plain quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ https://x.y\n\nNote[^1].\n\n[^1]: The footnote.", () => true);
  expect(out).toContain('<blockquote class="markdown-alert markdown-alert-warning">');
  expect(out).toContain('<p class="markdown-alert-title">Warning</p>');
  expect(out).toContain("<p>Careful <strong>now</strong></p>");
  expect(out).toContain("<blockquote>\n<p>plain quote");
  expect(out).toContain("<table>");
  expect(out).toContain("<s>old</s>");
  expect(out).toContain('<a href="https://x.y">https://x.y</a>');
  expect(out).toContain('class="footnotes"');
});

test("front matter is stripped before rendering", () => {
  const out = renderMarkdown("---\ncreated: 2026-10-27\ntags: [a]\n---\n# Hi", () => true);
  expect(out).not.toContain("created");
  expect(out).not.toContain("<hr>");
  expect(out).toContain("<h1>Hi</h1>");
});

test("task lines still count the stripped front matter", () => {
  expect(renderMarkdown("---\na: 1\n---\n- [ ] t", () => true)).toContain('data-line="3"');
});

test("renderInline: marks, no block wrapper, html escaped", () => {
  expect(renderInline("**b** and [[N]] #t")).toBe('<strong>b</strong> and <a href="#" class="wikilink" data-title="N">N</a> <a href="#" class="tag" data-tag="t">#t</a>');
  expect(renderInline("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;");
});
