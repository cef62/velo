// TS twin of src-tauri/src/frontmatter.rs: display, hiding and word count only. Keep the block rules identical.
const MAX_LINES = 200;

/** Range of a leading `---` block (line 1 exactly `---`, closed within 200 lines); `to` is past the closing newline. */
export function frontMatterRange(text: string): { from: 0; to: number } | null {
  let pos = 0;
  for (let i = 0; i < MAX_LINES && pos < text.length; i++) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(pos, nl < 0 ? end : nl).replace(/\r$/, "");
    if (i === 0 && line !== "---") return null;
    if (i > 0 && line === "---") return { from: 0, to: end };
    pos = end;
  }
  return null;
}

export function stripFrontMatter(text: string): string {
  const r = frontMatterRange(text);
  return r ? text.slice(r.to) : text;
}

export function wordCount(text: string): number {
  return stripFrontMatter(text).split(/\s+/).filter(Boolean).length;
}

/**
 * The change that applies a save's stamped `block` to the editor's `current` text: it replaces the current block
 * (or inserts at 0 when none was sent). null = skip: the user changed the block during the save, or nothing to do.
 */
export function stampChange(current: string, block: string, sentBlock: string | null): { from: 0; to: number; insert: string } | null {
  const r = frontMatterRange(current);
  const cur = r ? current.slice(0, r.to) : null;
  if (cur !== sentBlock || cur === block) return null;
  return { from: 0, to: r?.to ?? 0, insert: block };
}
