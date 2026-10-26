import MarkdownIt from "markdown-it";
import { readTag } from "./tags";

const md = new MarkdownIt({ html: false, linkify: true });
const esc = md.utils.escapeHtml;

// Set per renderMarkdown call; the renderer is synchronous so this is safe.
let exists: (title: string) => boolean = () => true;

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  const title = end < 0 ? "" : src.slice(pos + 2, end).trim();
  if (!title || title.includes("\n")) return false;
  if (!silent) state.push("wikilink", "", 0).content = title;
  state.pos = end + 2;
  return true;
});
md.renderer.rules.wikilink = (tokens, i) => {
  const t = tokens[i].content;
  return `<a href="#" class="wikilink${exists(t) ? "" : " missing"}" data-title="${esc(t)}">${esc(t)}</a>`;
};

// Code spans/fences are separate tokens, so tags inside them never reach this rule (Rust, which indexes, skips fences only).
md.inline.ruler.before("link", "tag", (state, silent) => {
  const tag = readTag(state.src, state.pos);
  if (!tag) return false;
  if (!silent) state.push("tag", "", 0).content = tag;
  state.pos += 1 + tag.length;
  return true;
});
md.renderer.rules.tag = (tokens, i) => `<a href="#" class="tag" data-tag="${esc(tokens[i].content)}">#${esc(tokens[i].content)}</a>`;

export function renderMarkdown(text: string, existsFn: (title: string) => boolean): string {
  exists = existsFn;
  return md.render(text);
}

/** The URL if it may be opened in the system browser (http/https only), else null. */
export function externalUrl(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

export const emptyWatermark = (toggleLabel: string) => "Empty note — press " + toggleLabel + " to edit";

/** Preview must never hide a note the user needs to type in: new notes and empty notes open in edit mode. */
export const shouldAutoEdit = (o: { created: boolean; body: string; previewOn: boolean }) => o.created || (o.previewOn && o.body.trim() === "");

/** What to do once a note is open. Enter always wants the caret in the editor; a wikilink click only when it lands on a new/empty note. */
export function afterOpen(o: { created: boolean; body: string; layout: "vertical" | "horizontal"; previewOn: boolean; source: "enter" | "wikilink" }) {
  const auto = shouldAutoEdit(o);
  if (o.source === "wikilink") return { leavePreview: auto, focusEditor: auto };
  // vertical layout: preview replaces the editor (display:none), where focus() silently does nothing
  return { leavePreview: auto || (o.previewOn && o.layout === "vertical"), focusEditor: true };
}

export interface Preview {
  toggle(): void;
  setMode(on: boolean): void;
  isOn(): boolean;
  /** Re-render, debounced 150 ms (editor change or title cache change). */
  refresh(): void;
}

/** Mounts the preview pane. Only renderMarkdown output is ever assigned to innerHTML. */
export function mountPreview(
  el: HTMLElement,
  opts: {
    getText: () => string;
    /** Current shortcut label for the empty-note watermark. */
    toggleLabel: () => string;
    exists: (title: string) => boolean;
    onWikilink: (title: string) => void;
    onTag: (tag: string) => void;
    openExternal: (url: string) => void;
    onToggle?: (visible: boolean) => void;
  },
): Preview {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    if (el.hidden) return;
    const text = opts.getText();
    el.classList.toggle("empty", text.trim() === "");
    if (text.trim() === "") el.textContent = emptyWatermark(opts.toggleLabel());
    else el.innerHTML = renderMarkdown(text, opts.exists);
  };
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a");
    if (!a) return;
    e.preventDefault(); // never navigate the app window
    if (a.classList.contains("wikilink")) opts.onWikilink(a.dataset.title ?? "");
    else if (a.classList.contains("tag")) opts.onTag(a.dataset.tag ?? "");
    else {
      const url = externalUrl(a.getAttribute("href") ?? "");
      if (url) opts.openExternal(url);
    }
  });
  const toggle = () => {
    el.hidden = !el.hidden;
    opts.onToggle?.(!el.hidden);
    draw();
  };
  return {
    toggle,
    setMode: (on) => on === el.hidden && toggle(),
    isOn: () => !el.hidden,
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(draw, 150);
    },
  };
}
