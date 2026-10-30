import { CalendarArrowUp, CalendarPlus, Lock } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { css } from "styled-system/css";
import { listRow } from "styled-system/recipes";
import type { TimelineRow } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, SegmentGroup, Spinner } from "@/components/ui";
import { rowHeight } from "../app/fontscale";
import { visibleRange } from "../list";
import { groupByDay } from "../timeline";
import { useStore } from "./useStore";

const PAD = 4; // space around the rows inside the scroll content (css p: "1")

// Same box as the note list's scroller, so the divider sizes it the same way.
const pane = css({
  h: "var(--list-h, 30%)",
  flex: "none",
  display: "flex",
  flexDirection: "column",
  minH: "0",
  minW: "0",
  "[data-layout=horizontal] &": { h: "auto" },
});
const top = css({ display: "flex", alignItems: "center", gap: "2", px: "2.5", py: "1", flex: "none", minW: "0", flexWrap: "wrap" });
const scroller = css({ flex: "1", minH: "0", overflowY: "auto" });
const day = css({ display: "flex", alignItems: "flex-end", px: "2.5", pb: "1", fontSize: "uiXs", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em", color: "velo.fgMuted" });
const srOnly = css({ srOnly: true });
const empty = css({ h: "full", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.5", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm", p: "4", "& strong": { color: "velo.fg", fontWeight: "600" } });

type Item = { label: string; row?: TimelineRow; n?: number }; // no row = the day header; n = the row's position among rows
const RANGES = [["7", "7 days"], ["30", "30 days"], ["all", "All"]] as const;

export function TimelineView({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const tl = useStore(store, (s) => s.timeline);
  const openPath = useStore(store, (s) => s.openPath);
  const fontSize = useStore(store, (s) => s.fontSize);
  const query = useStore(store, (s) => s.query);
  const tags = useStore(store, (s) => s.selectedTags);
  const noLinks = useStore(store, (s) => s.noLinks);
  const listActive = useStore(store, (s) => s.listActive); // focus in the search field: ↑/↓ there move the selection
  // shortcut: day headers take a full row's height so the window math stays uniform; use per-item offsets if that looks too airy
  const rowH = rowHeight(fontSize, "horizontal");
  // shortcut: the day is read on render, so Today/Yesterday move past midnight only at the next render (scroll, reload, focus); add a midnight timer if that matters
  const today = new Date().toDateString();
  const items = useMemo(() => {
    let n = 0;
    return groupByDay(tl.rows ?? [], new Date()).flatMap((g): Item[] => [{ label: g.label }, ...g.rows.map((row) => ({ label: g.label, row, n: ++n }))]);
  }, [tl.rows, today]);
  const time = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), []);
  const el = useRef<HTMLDivElement>(null);
  const [[a, b], setWin] = useState<[number, number]>([0, 0]);
  const focusCur = useRef(false); // ↑/↓ on a row moved the stop: focus it once it is mounted
  // the selection (from the search field or the rows) is the roving tab stop; the first row when none or gone
  const stop = items.findIndex((it) => it.row?.path === tl.sel) >= 0 ? tl.sel! : (items[1]?.row?.path ?? "");
  const setCur = (path: string) => controller.setTimelineSel(path);
  const stopIdx = items.findIndex((it) => it.row?.path === stop);

  const measure = () => {
    const e = el.current;
    if (e) setWin(visibleRange(Math.max(0, e.scrollTop - PAD), e.clientHeight, rowH, items.length));
  };
  useLayoutEffect(() => {
    const e = el.current;
    if (!e) return;
    const ro = new ResizeObserver(measure); // divider drag, window resize
    ro.observe(e);
    return () => ro.disconnect();
  }, [rowH, items.length]);
  useLayoutEffect(() => {
    const e = el.current;
    if (e && stopIdx >= 0) {
      const y = PAD + stopIdx * rowH;
      if (y - rowH - PAD < e.scrollTop) e.scrollTop = y - rowH - PAD; // keep its day header in view too
      else if (y + rowH + PAD > e.scrollTop + e.clientHeight) e.scrollTop = y + rowH + PAD - e.clientHeight;
      if (focusCur.current) e.querySelector<HTMLElement>(`[data-row="${stopIdx}"]`)?.focus({ preventScroll: true });
      focusCur.current = false;
    }
    measure();
  }, [stopIdx, items.length, rowH]);

  const move = (e: KeyboardEvent) => {
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!d || stopIdx < 0) return;
    e.preventDefault();
    let i = stopIdx + d;
    if (i >= 0 && !items[i]?.row) i += d; // skip the day header
    if (!items[i]?.row) return;
    focusCur.current = true;
    setCur(items[i].row!.path);
  };
  const open = (path: string) => {
    setCur(path);
    void controller.show(path); // the pane stays on the timeline; a locked note asks for the passphrase
  };

  const idx: number[] = [];
  for (let i = a; i < Math.min(b, items.length); i++) idx.push(i);
  if (stopIdx >= 0 && (stopIdx < a || stopIdx >= b)) idx.push(stopIdx); // keep the tab stop alive when scrolled away
  const filters = [query && `“${query}”`, ...tags.map((t) => `#${t}`), noLinks && "No links", tl.range !== "all" && `last ${tl.range} days`].filter(Boolean).join(" · ");

  return (
    <div className={pane}>
      <div className={top}>
        <SegmentGroup.Root size="sm" value={tl.by} onValueChange={(d) => d.value !== tl.by && void controller.setTimelineBy(d.value as typeof tl.by)} aria-label="Timeline date">
          <SegmentGroup.Indicator />
          {(
            [
              ["created", "Created", <CalendarPlus key="i" size={14} />],
              ["updated", "Updated", <CalendarArrowUp key="i" size={14} />],
            ] as const
          ).map(([v, text, glyph]) => (
            <SegmentGroup.Item key={v} value={v}>
              {glyph}
              <SegmentGroup.ItemText>{text}</SegmentGroup.ItemText>
              <SegmentGroup.ItemHiddenInput aria-label={text} />
            </SegmentGroup.Item>
          ))}
        </SegmentGroup.Root>
        <SegmentGroup.Root size="sm" value={tl.range} onValueChange={(d) => d.value !== tl.range && void controller.setTimelineRange(d.value as typeof tl.range)} aria-label="Timeline range">
          <SegmentGroup.Indicator />
          {RANGES.map(([v, text]) => (
            <SegmentGroup.Item key={v} value={v}>
              <SegmentGroup.ItemText>{text}</SegmentGroup.ItemText>
              <SegmentGroup.ItemHiddenInput aria-label={text} />
            </SegmentGroup.Item>
          ))}
        </SegmentGroup.Root>
        <Button variant="outline" size="xs" ml="auto" onClick={() => void controller.startExport()}>
          Export…
        </Button>
      </div>
      <div ref={el} className={scroller} onScroll={measure}>
        {tl.err ? (
          <div className={empty} role="alert">{tl.err}</div>
        ) : !tl.rows ? (
          <div className={empty}>
            <span><Spinner size="sm" /> Loading…</span>
          </div>
        ) : items.length === 0 ? (
          <div className={empty}>
            <strong>No notes match</strong>
            {filters && <span>{filters}</span>}
          </div>
        ) : (
          <div style={{ padding: PAD }}>
            <div role="listbox" id="timeline-list" aria-label="Timeline" onKeyDown={move} style={{ position: "relative", height: items.length * rowH }}>
              {idx.map((i) => {
                const it = items[i];
                const pos = { position: "absolute", left: 0, right: 0, top: i * rowH, height: rowH } as const;
                if (!it.row) return <div key={`d${i}`} className={day} style={pos} aria-hidden>{it.label}</div>;
                const r = it.row;
                const c = listRow({ layout: "twoLine", state: listActive && i === stopIdx ? "selected" : r.path === openPath ? "selectedIdle" : "idle" });
                return (
                  <div
                    key={r.path}
                    role="option"
                    id={`timeline-opt-${it.n}`} // the search field's aria-activedescendant
                    aria-selected={r.path === openPath}
                    aria-setsize={tl.rows?.length}
                    aria-posinset={it.n}
                    tabIndex={i === stopIdx ? 0 : -1} // roving: one tab stop for the whole list, ↑/↓ move
                    data-row={i}
                    className={c.root}
                    style={pos}
                    onFocus={() => setCur(r.path)}
                    onClick={() => open(r.path)}
                    onKeyDown={(e) => e.key === "Enter" && open(r.path)}
                  >
                    <div className={css({ display: "flex", alignItems: "center", gap: "2.5", minW: "0" })}>
                      {r.locked && <span className={c.lock}><Lock aria-label="Locked" /></span>}
                      <span className={c.title}>{r.title}</span>
                      <span className={c.date}><span className={srOnly}>{it.label}, </span>{time.format(r.date)}</span>
                    </div>
                    <span className={c.snippet}>{r.locked ? "" : r.snippet}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
