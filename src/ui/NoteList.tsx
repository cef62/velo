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

const scroller = css({
  h: "var(--list-h, 30%)",
  flex: "none",
  overflowY: "auto",
  p: "1",
  "[data-layout=horizontal] &": { h: "auto", minH: "0" },
});
const loader = css({ position: "absolute", left: "0", right: "0", display: "flex", alignItems: "center", gap: "2", px: "2.5", color: "velo.fgMuted", fontSize: "var(--velo-snippet-fs)" });
const empty = css({ h: "full", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.5", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm", p: "4", "& strong": { color: "velo.fg", fontWeight: "600" }, "& span": { display: "inline-flex", alignItems: "center", gap: "1.5" } });

export function NoteList({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  useStore(store, (s) => s.listVersion);
  const { count, hasMore, sel, listActive, layout, fontSize, query, isMac, listReset } = useStore(store);
  const rowH = rowHeight(fontSize, layout);
  const el = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 0 });

  const measure = () => el.current && setView({ top: el.current.scrollTop, h: el.current.clientHeight });
  useLayoutEffect(() => {
    const e = el.current!;
    measure();
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
      const top = sel * rowH;
      if (top < e.scrollTop) e.scrollTop = top;
      else if (top + rowH > e.scrollTop + e.clientHeight) e.scrollTop = top + rowH - e.clientHeight;
    }
    measure();
  }, [sel, listReset, rowH]);

  const [a, b] = visibleRange(view.top, view.h, rowH, count);
  useEffect(() => {
    if (hasMore && b >= count - LOAD_AHEAD) void controller.ensureRows(count);
  }, [controller, hasMore, b, count]);

  const state = listActive ? "selected" : "selectedIdle";
  const rows = [];
  for (let i = a; i < b; i++) {
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
          <span>Press <Kbd>{isMac ? "⇧↩" : "Shift+Enter"}</Kbd> to create a note with that title</span>
          <span>or <Kbd>Esc</Kbd> to clear the search</span>
        </div>
      ) : (
        <div role="listbox" aria-label="Notes" style={{ position: "relative", height: (count + (hasMore ? 1 : 0)) * rowH }}>
          {rows}
          {hasMore && (
            <div className={loader} style={{ top: count * rowH, height: rowH }}>
              <Spinner size="sm" /> Loading…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
