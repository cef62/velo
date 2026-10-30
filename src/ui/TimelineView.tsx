import { Lock } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { css } from "styled-system/css";
import { listRow, sectionHeader } from "styled-system/recipes";
import type { TimelineRow } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Spinner } from "@/components/ui";
import { rowHeight } from "../app/fontscale";
import { visibleRange } from "../list";
import { filtersLine, groupByDay } from "../timeline";
import { useStore } from "./useStore";

const PAD = 4; // space around the rows inside the scroll content (css p: "1")

const pane = css({ flex: "1", display: "flex", flexDirection: "column", minH: "0", minW: "0" }); // fills the left pane under its bar
const scroller = css({ flex: "1", minH: "0", overflowY: "auto" });
const day = css({ alignItems: "flex-end", pt: "0" }); // a day header takes a full row: the text sits at its bottom
const srOnly = css({ srOnly: true });
const empty = css({ h: "full", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1.5", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm", p: "4", "& strong": { color: "velo.fg", fontWeight: "600" } });

type Item = { label: string; row?: TimelineRow; n?: number }; // no row = the day header; n = the row's position among rows

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
  // one active row, styled and announced: the selection when set, else the open note
  const active = items.some((it) => it.row?.path === tl.sel) ? tl.sel : openPath;
  const scrolledSel = useRef(tl.sel);
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
    // only a new selection scrolls: a reload must not snap back after the user scrolled away
    if (e && stopIdx >= 0 && (scrolledSel.current !== tl.sel || focusCur.current)) {
      scrolledSel.current = tl.sel;
      const y = PAD + stopIdx * rowH;
      if (y - rowH - PAD < e.scrollTop) e.scrollTop = y - rowH - PAD; // keep its day header in view too
      else if (y + rowH + PAD > e.scrollTop + e.clientHeight) e.scrollTop = y + rowH + PAD - e.clientHeight;
      if (focusCur.current) e.querySelector<HTMLElement>(`[data-row="${stopIdx}"]`)?.focus({ preventScroll: true });
      focusCur.current = false;
    }
    measure();
  }, [stopIdx, items.length, rowH, tl.sel]);

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
  const filters = filtersLine({ query, tags, noLinks, range: tl.range });

  return (
    <div className={pane}>
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
                if (!it.row) return <div key={`d${i}`} className={`${sectionHeader()} ${day}`} style={pos} aria-hidden>{it.label}</div>;
                const r = it.row;
                const c = listRow({ layout: "twoLine", state: r.path !== active ? "idle" : listActive ? "selected" : "selectedIdle" });
                return (
                  <div
                    key={r.path}
                    role="option"
                    id={`timeline-opt-${it.n}`} // the search field's aria-activedescendant
                    aria-selected={r.path === active}
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
