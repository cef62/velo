import { searchMatch } from "styled-system/recipes";
import { highlightRanges } from "../highlight";

/** `text` with the query's matches wrapped in <mark>. */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={s} className={searchMatch()}>
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
