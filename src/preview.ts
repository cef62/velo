import MarkdownIt from "markdown-it";

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

export interface Preview {
  toggle(): void;
  /** Re-render, debounced 150 ms (editor change or title cache change). */
  refresh(): void;
}

/** Mounts the preview pane. Only renderMarkdown output is ever assigned to innerHTML. */
export function mountPreview(
  el: HTMLElement,
  opts: {
    getText: () => string;
    exists: (title: string) => boolean;
    onWikilink: (title: string) => void;
    openExternal: (url: string) => void;
    onToggle?: (visible: boolean) => void;
  },
): Preview {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    if (!el.hidden) el.innerHTML = renderMarkdown(opts.getText(), opts.exists);
  };
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a");
    if (!a) return;
    e.preventDefault(); // never navigate the app window
    if (a.classList.contains("wikilink")) opts.onWikilink(a.dataset.title ?? "");
    else {
      const url = externalUrl(a.getAttribute("href") ?? "");
      if (url) opts.openExternal(url);
    }
  });
  return {
    toggle() {
      el.hidden = !el.hidden;
      opts.onToggle?.(!el.hidden);
      draw();
    },
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(draw, 150);
    },
  };
}
