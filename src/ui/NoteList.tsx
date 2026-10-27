import { Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { css } from "styled-system/css";
import { listRow } from "styled-system/recipes";
import { Kbd, Spinner } from "@/components/ui";
import { rowHeight } from "../app/fontscale";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { ago, visibleRange } from "../list";
import { HighlightedText } from "./HighlightedText";
import { useStore } from "./useStore";

const LOAD_AHEAD = 50; // start paging this many rows before the loaded end
const PAD = 4; // space around the rows inside the scroll content (css p: "1")

const scroller = css({
  h: "var(--list-h, 30%)",
  flex: "none",
  overflowY: "auto",
  "[data-layout=horizontal] &": { h: "auto", minH: "0" },
});
const loader = css({ position: "absolute", left: "0", right: "0", display: "flex", alignItems: "center", gap: "2", px: "2.5", color: "velo.fgMuted", fontSize: "var(--velo-snippet-fs)" });
const empty = css({ h: "full", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.5", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm", p: "4", "& strong": { color: "velo.fg", fontWeight: "600" }, "& span": { display: "inline-flex", alignItems: "center", gap: "1.5" } });

export function NoteList({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  useStore(store, (s) => s.listVersion); // rows are read through controller.row, so a page/refresh must re-render
  const listReset = useStore(store, (s) => s.listReset);
  const count = useStore(store, (s) => s.count);
  const hasMore = useStore(store, (s) => s.hasMore);
  const sel = useStore(store, (s) => s.sel);
  const listActive = useStore(store, (s) => s.listActive);
  const layout = useStore(store, (s) => s.layout);
  const fontSize = useStore(store, (s) => s.fontSize);
  const query = useStore(store, (s) => s.query);
  const isMac = useStore(store, (s) => s.isMac);
  const rowH = rowHeight(fontSize, layout);
  const el = useRef<HTMLDivElement>(null);
  // Rendered window; state only changes when the first/last row changes, not on every scroll pixel.
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);

  const measure = () => {
    const e = el.current;
    if (!e) return;
    const s = store.get();
    const [x, y] = visibleRange(Math.max(0, e.scrollTop - PAD), e.clientHeight, rowHeight(s.fontSize, s.layout), s.count);
    setA(x);
    setB(y);
  };
  useLayoutEffect(() => {
    const e = el.current!;
    const ro = new ResizeObserver(measure); // divider drag, window resize
    ro.observe(e);
    return () => ro.disconnect();
  }, []);

  // New result set: back to the top; then keep the selected row visible (also after a font/layout change).
  const lastReset = useRef(listReset);
  useLayoutEffect(() => {
    const e = el.current!;
    if (lastReset.current !== listReset) {
      lastReset.current = listReset;
      e.scrollTop = 0;
    }
    if (sel >= 0) {
      const top = PAD + sel * rowH;
      if (top - PAD < e.scrollTop) e.scrollTop = top - PAD;
      else if (top + rowH + PAD > e.scrollTop + e.clientHeight) e.scrollTop = top + rowH + PAD - e.clientHeight;
    }
    measure();
  }, [sel, listReset, rowH]);
  useLayoutEffect(measure, [count, rowH]); // never moves scrollTop (paging must not snap back to the selection)

  useEffect(() => {
    if (hasMore && b >= count - LOAD_AHEAD) void controller.ensureRows(count);
  }, [controller, hasMore, b, count]);

  const state = listActive ? "selected" : "selectedIdle";
  const rows = [];
  const idx = [];
  for (let i = a; i < Math.min(b, count); i++) idx.push(i);
  if (sel >= 0 && sel < count && (sel < a || sel >= b)) idx.push(sel); // keep the tab stop alive when scrolled away
  for (const i of idx) {
    const h = controller.row(i);
    if (!h) continue;
    const on = i === sel;
    const c = listRow({ layout: layout === "horizontal" ? "twoLine" : "compact", state: on ? state : "idle" });
    const title = (
      <>
        {h.encrypted && <span className={c.lock}><Lock aria-hidden="true" /></span>}
        <span className={c.title}><HighlightedText text={h.title} query={query} /></span>
      </>
    );
    const date = <span className={c.date}>{ago(h.mtime)}</span>;
    const snippet = <span className={c.snippet}>{h.encrypted ? (layout === "horizontal" ? "Locked" : "") : <HighlightedText text={h.snippet} query={query} />}</span>;
    rows.push(
      <div
        key={h.path}
        role="option"
        aria-selected={on}
        aria-setsize={count}
        aria-posinset={i + 1}
        tabIndex={on ? 0 : -1}
        data-row={i}
        data-selected={on || undefined}
        className={c.root}
        style={{ position: "absolute", left: 0, right: 0, top: i * rowH }}
        onClick={() => void controller.select(i)}
        onContextMenu={(e) => {
          e.preventDefault();
          void controller.openContextMenu(i);
        }}
      >
        {layout === "horizontal" ? (
          <>
            <div className={css({ display: "flex", alignItems: "center", gap: "2.5", minW: "0" })}>{title}{date}</div>
            {snippet}
          </>
        ) : (
          <>{title}{snippet}{date}</>
        )}
      </div>,
    );
  }

  return (
    <div ref={el} className={scroller} data-active={listActive || undefined} onScroll={measure}>
      {count === 0 && query ? (
        <div className={empty}>
          <strong>No notes match “{query}”</strong>
          <span>Press <Kbd>{isMac ? "⇧↩" : "Shift+Enter"}</Kbd> to create a note with that title, <Kbd>{isMac ? "⌥↩" : "Alt+Enter"}</Kbd> for a task list</span>
          <span>or <Kbd>Esc</Kbd> to clear the search</span>
        </div>
      ) : (
        <div style={{ padding: PAD }}>
        <div role="listbox" aria-label="Notes" tabIndex={sel < 0 || sel >= count ? 0 : undefined} style={{ position: "relative", height: (count + (hasMore ? 1 : 0)) * rowH }}>
          {rows}
          {hasMore && (
            <div className={loader} style={{ top: count * rowH, height: rowH }}>
              <Spinner size="sm" /> Loading…
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  );
}
