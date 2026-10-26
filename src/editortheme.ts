import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection, dropCursor, highlightSpecialChars, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

// Colors are CSS variables from styles.css, so light/dark follow the OS like the rest of the app.
export const writingHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.92em" },
  { tag: t.quote, color: "var(--mute)", fontStyle: "italic" },
  // Markdown punctuation (#, **, >, -, [ ], ```), rules and link labels: present but quiet.
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: "var(--mute)" },
]);

const writingTheme = EditorView.theme({
  "&": { height: "100%", background: "var(--bg)", color: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" },
  ".cm-content": { maxWidth: "46em", margin: "0 auto", padding: "16px 24px", caretColor: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground": { background: "var(--sel)" },
  ".cm-selectionMatch": { background: "color-mix(in srgb, var(--sel) 50%, transparent)" },
  ".cm-panels": { background: "var(--bg)", color: "var(--fg)", borderColor: "var(--line)" },
});

const darkMq = window.matchMedia?.("(prefers-color-scheme: dark)");
// data-theme (Settings → Theme) overrides the OS; no attribute = follow the OS
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : !!darkMq?.matches;
};

/** Editor setup for prose: no gutters or code-editor chrome, readable in light and dark. */
export function writingSetup(): Extension[] {
  const dark = new Compartment(); // tells CodeMirror's base theme (search panel, cursor) which scheme is on
  const followScheme = ViewPlugin.define((view) => {
    const onChange = () => view.dispatch({ effects: dark.reconfigure(EditorView.darkTheme.of(isDark())) });
    darkMq?.addEventListener("change", onChange);
    const themeAttr = new MutationObserver(onChange);
    themeAttr.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return { destroy: () => (darkMq?.removeEventListener("change", onChange), themeAttr.disconnect()) };
  });
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }), // GFM: tables, ~~strike~~, task lists, like the preview
    syntaxHighlighting(writingHighlight),
    writingTheme,
    EditorView.lineWrapping,
    dark.of(EditorView.darkTheme.of(isDark())),
    followScheme,
  ];
}
