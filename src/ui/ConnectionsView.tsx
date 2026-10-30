import { CalendarArrowUp, CalendarPlus, Orbit } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { SegmentGroup, Spinner } from "@/components/ui";
import { dateText as date, isTagNode, nodeKeyAction, nodeLabel, ringLayout, tabOrder, timeLayout, type Placed } from "../connections";
import { useStore } from "./useStore";

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
const top = css({ display: "flex", alignItems: "center", gap: "2", px: "2.5", py: "1", flex: "none", minW: "0" });
const centreTitle = css({ truncate: true, minW: "0", fontSize: "uiSm", color: "velo.fgMuted" });
const stage = css({ position: "relative", flex: "1", minH: "0", overflow: "hidden" });
const empty = css({ h: "full", display: "flex", alignItems: "center", justifyContent: "center", gap: "2", p: "4", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm" });
const edge = css({ stroke: "velo.border", strokeWidth: "1.25", fill: "none", "&[data-kind=mention]": { stroke: "velo.fgMuted", strokeDasharray: "3 3", opacity: "0.5" } });
// hovering a mention edge reveals Link it at its midpoint; the button sits in the group so the hover survives the move onto it
const mentionEdge = css({
  "& .hit": { stroke: "transparent", strokeWidth: "14", pointerEvents: "stroke" },
  "& .link": { opacity: "0", cursor: "pointer", pointerEvents: "none" },
  "&:hover .link": { opacity: "1", pointerEvents: "all" },
  "& .link rect": { fill: "velo.panel", stroke: "velo.accentBorder" },
  "& .link text": { fill: "velo.accentText", fontSize: "uiXs" },
});
const arrow = css({ fill: "velo.border" });
const axis = css({ stroke: "velo.divider", strokeWidth: "1" });
const axisText = css({ fill: "velo.fgMuted", fontSize: "uiXs" });
const node = css({
  cursor: "default",
  outline: "none",
  "& .dot": { fill: "velo.canvas", stroke: "velo.accentText", strokeWidth: "1.5" },
  "&[data-kind=centre] .dot": { fill: "velo.accent", stroke: "velo.accent" },
  "&[data-kind=tag] .dot": { fill: "velo.accentSubtle", stroke: "velo.accentBorder" },
  "&[data-kind=mention] .dot": { stroke: "velo.fgMuted" },
  "& .ring": { fill: "none", stroke: "transparent", strokeWidth: "2" },
  "&:hover .ring": { stroke: "velo.accentHalo" },
  "&:focus-visible .ring": { stroke: "velo.accent" },
  "& text": { fill: "velo.fg", fontSize: "uiXs" },
  "&[data-kind=centre] text": { fontWeight: "600" },
  "&[data-kind=tag] text": { fill: "velo.accentText" },
});
const card = css({
  position: "absolute",
  zIndex: "1",
  maxW: "240px",
  p: "2",
  bg: "velo.panel",
  color: "velo.fg",
  border: "1px solid",
  borderColor: "velo.border",
  borderRadius: "l2",
  boxShadow: "md",
  fontSize: "uiSm",
  pointerEvents: "none",
  "& strong": { display: "block", fontWeight: "600", truncate: true },
  "& div": { color: "velo.fgMuted", fontSize: "uiXs" },
  "& p": { mt: "1", lineClamp: "3" },
});

const radius = (p: Placed) => (p.kind === "centre" ? 9 : p.key.startsWith("#") && !p.key.includes(":") ? 5 : 6);
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
// a collapsed tag's title is "+N"; show the tag with it
const label = (p: Placed) => (isTagNode(p) && p.node.title.startsWith("+") ? `${p.key} ${p.node.title}` : p.node.title);
/** The node an edge starts from: tag notes hang off their tag node, everything else off the centre. */
const parentOf = (p: Placed) => (p.kind === "tag" && !isTagNode(p) ? p.key.slice(0, p.key.indexOf(":")) : "centre");

/** The segment between two nodes, trimmed to their circles so arrowheads touch the edge. */
function segment(a: Placed, b: Placed) {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const d = Math.hypot(dx, dy) || 1;
  const [ra, rb] = [radius(a) + 1, radius(b) + 3];
  return { x1: a.x + (dx * ra) / d, y1: a.y + (dy * ra) / d, x2: b.x - (dx * rb) / d, y2: b.y - (dy * rb) / d };
}

export function ConnectionsView({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const conn = useStore(store, (s) => s.connections);
  const sort = useStore(store, (s) => s.connectionsSort);
  const openPath = useStore(store, (s) => s.openPath);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [shown, setShown] = useState<string | null>(null); // hovered or focused node key, for the card
  const focusCentre = useRef(true); // the view takes focus when it opens, so its keys work at once (not the editor's)
  const marker = useId().replace(/[^\w-]/g, ""); // a plain id: it goes into url(#…)
  // the stage mounts and unmounts with the empty and error states: measure it from its ref
  const box = useCallback((e: HTMLDivElement | null) => {
    if (!e) return;
    const ro = new ResizeObserver(() => setSize({ w: e.clientWidth, h: e.clientHeight })); // divider drag, window resize
    ro.observe(e);
    return () => ro.disconnect();
  }, []);

  const data = conn?.data ?? null;
  const placed = useMemo(() => {
    if (!data || !size.w) return [];
    return sort === "ring" ? ringLayout(data, size.w, size.h) : timeLayout(data, sort === "created" ? "created" : "modified", size.w, size.h);
  }, [data, sort, size]);
  const byKey = useMemo(() => new Map(placed.map((p) => [p.key, p])), [placed]);

  // on open and after a re-centre, focus goes to the centre node
  useEffect(() => {
    if (!focusCentre.current || !placed.length) return;
    focusCentre.current = false;
    svg.current?.querySelector<SVGGElement>('[data-key="centre"]')?.focus();
  }, [placed]);

  const leave = () => {
    controller.setPaneMode("notes");
    // the focused node unmounts: hand focus to the note list's selected row, else to search (the list's keyboard home)
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>('[role=listbox] [aria-selected=true]');
      if (row) row.focus();
      else controller.focusSearch();
    });
  };
  const recentre = (p: Placed) => {
    if (isTagNode(p) || p.kind === "centre") return;
    focusCentre.current = true;
    void controller.recentre(p.node.path);
  };
  const activate = (p: Placed) => {
    if (isTagNode(p)) {
      controller.setTags([p.key.slice(1)]); // the tag filter shows every note with the tag, also past the 15 drawn
      leave();
    } else void controller.openFromGraph(p.node.path);
  };
  const mentionOf = (p: Placed) => (p.kind === "mention" ? data?.mentions.find((m) => m.node.path === p.node.path) ?? null : null);
  const menu = (p: Placed) => !isTagNode(p) && p.kind !== "centre" && void controller.openNodeMenu(p.node, mentionOf(p));
  const onKey = (e: KeyboardEvent, p: Placed) => {
    if (controller.isMenuKey(e.nativeEvent)) {
      e.preventDefault();
      return menu(p);
    }
    const act = nodeKeyAction(e.key, e.shiftKey);
    if (act === "open") activate(p);
    else if (act === "recentre") recentre(p);
    else if (act === "next" || act === "prev") {
      const order = tabOrder(placed);
      const step = act === "next" ? 1 : -1;
      const next = order[(order.indexOf(p.key) + step + order.length) % order.length];
      svg.current?.querySelector<SVGGElement>(`[data-key="${CSS.escape(next)}"]`)?.focus();
    } else return; // Esc bubbles to the pane
    e.preventDefault();
  };

  const card_ = shown ? byKey.get(shown) : undefined;
  const timeAxis = sort !== "ring" && placed.length > 0;
  const axisY = Math.max(0, size.h - 18); // in the room timeLayout leaves under the bottom labels
  const dates = placed.map((p) => p.node[sort === "created" ? "created" : "modified"]);

  return (
    <div className={pane} onKeyDown={(e) => nodeKeyAction(e.key, e.shiftKey) === "leave" && leave()}>
      <div className={top}>
        <SegmentGroup.Root size="sm" value={sort} onValueChange={(d) => d.value !== sort && void controller.setConnectionsSort(d.value as typeof sort)} aria-label="Connections layout">
          <SegmentGroup.Indicator />
          {(
            [
              ["ring", "Ring", <Orbit key="i" size={14} />],
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
        {data && openPath && <span className={centreTitle}>{data.centre.title}</span>}
      </div>
      {openPath === null ? (
        <div className={empty}>Open a note to see its connections</div>
      ) : conn?.err ? (
        <div className={empty} role="alert">{conn.err}</div>
      ) : (
        <div ref={box} className={stage}>
          {!data && (
            <div className={empty}>
              <Spinner size="sm" /> Loading…
            </div>
          )}
          {data && placed.length === 1 && <div className={css({ position: "absolute", insetX: "0", bottom: "2", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm" })}>No connections yet</div>}
          {data && (
            <svg ref={svg} width={size.w} height={size.h} role="group" aria-label={`Connections of ${data.centre.title}`}>
              <defs>
                <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className={arrow} />
                </marker>
              </defs>
              {timeAxis && (
                <g aria-hidden>
                  <line x1={8} x2={size.w - 8} y1={axisY} y2={axisY} className={axis} />
                  <text x={8} y={axisY + 12} className={axisText}>{date(Math.min(...dates))}</text>
                  <text x={size.w - 8} y={axisY + 12} textAnchor="end" className={axisText}>{date(Math.max(...dates))}</text>
                </g>
              )}
              <g aria-hidden>
                {placed.map((p) => {
                  const from = byKey.get(parentOf(p));
                  if (p.kind === "centre" || !from) return null;
                  // links in point at the centre; links out away from it
                  const s = p.kind === "in" ? segment(p, from) : segment(from, p);
                  const m = data.centre.locked ? null : mentionOf(p);
                  const head = p.kind === "out" || p.kind === "in" ? `url(#${marker})` : undefined;
                  const line = <line {...s} className={edge} data-kind={p.kind} markerEnd={head} />;
                  if (!m) return <g key={p.key}>{line}</g>;
                  const [mx, my] = [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
                  return (
                    <g key={p.key} className={mentionEdge}>
                      <line {...s} className="hit" />
                      {line}
                      <g className="link" transform={`translate(${mx} ${my})`} onClick={() => void controller.linkMention(m)}>
                        <title>{`Wrap the first of ${m.count} in [[${m.name}]]`}</title>
                        <rect x={-24} y={-9} width={48} height={18} rx={9} />
                        <text textAnchor="middle" y={4}>Link it</text>
                      </g>
                    </g>
                  );
                })}
              </g>
              {placed.map((p) => (
                <g
                  key={p.key}
                  data-key={p.key}
                  data-kind={p.kind}
                  className={node}
                  role="button"
                  tabIndex={0}
                  aria-label={nodeLabel(p, data, sort === "created" ? "created" : "modified")}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => activate(p)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    menu(p);
                  }}
                  onDoubleClick={() => recentre(p)}
                  onKeyDown={(e) => onKey(e, p)}
                  onMouseEnter={() => setShown(p.key)}
                  onMouseLeave={() => setShown(null)}
                  onFocus={() => setShown(p.key)}
                  onBlur={() => setShown(null)}
                >
                  <circle className="ring" r={radius(p) + 3} />
                  <circle className="dot" r={radius(p)} />
                  <text y={radius(p) + 12} textAnchor="middle">{short(label(p))}</text>
                </g>
              ))}
            </svg>
          )}
          {card_ && !isTagNode(card_) && (
            <div
              className={card}
              style={{
                left: Math.max(4, Math.min(card_.x + 12, size.w - 244)),
                top: card_.y + 12,
                transform: card_.y > size.h / 2 ? "translateY(calc(-100% - 24px))" : undefined,
              }}
            >
              <strong>{card_.node.title}</strong>
              <div>Created {date(card_.node.created)}</div>
              <div>Modified {date(card_.node.modified)}</div>
              {card_.node.preview && <p>{card_.node.preview}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
