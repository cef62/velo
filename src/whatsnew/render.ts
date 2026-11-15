import MarkdownIt from "markdown-it";

// Release-note text as inline Markdown, like preview.ts's renderInline (html: false, linkify) but with images off:
// `![alt](url)` shows as text and a link, so the window never requests anything. No wikilinks or tags: not notes.
const md = new MarkdownIt({ html: false, linkify: true }).disable("image");

export const renderNote = (text: string) => md.renderInline(text);
