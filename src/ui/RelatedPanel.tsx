import { ArrowLeft, ChevronDown, Hash, Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { css } from "styled-system/css";
import { relatedRow, sectionHeader } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Kbd } from "@/components/ui";
import { dateText, defaultClosed, relatedRows, stem, stepRelated, type RelatedRow } from "../related";
import { formatBinding, NONE } from "../shortcuts";
import { HighlightedText } from "./HighlightedText";
import { useStore } from "./useStore";

// The Related tab (design v2 §5): a keyboard tree that follows the open note. One Tab stop (roving),
// ↑/↓ move over headers and rows, ←/→ collapse and expand, ↩ opens and stays, ⌘↩ opens and jumps to the
// editor, Space peeks, ⇧↩ links a mention or creates a missing target, Esc returns to the editor.
const ago = (ms: number) => {
  const d = Date.now() - ms;
  const [u, n] = ([["y", 31536e6], ["mo", 2592e6], ["w", 6048e5], ["d", 864e5], ["h", 36e5], ["m", 6e4]] as const).find(([, n]) => d >= n) ?? ["m", 6e4];
  return d < 6e4 ? "now" : `${Math.floor(d / n)}${u}`;
};
const tree = css({ display: "flex", flexDirection: "column", gap: "1px", outline: "none" });
const tagRow = css({ display: "flex", alignItems: "center", gap: "1.5", h: "30px", px: "2.5", pl: "5", borderRadius: "l2", fontSize: "uiSm", fontWeight: "500", color: "velo.accentText", cursor: "default", _hover: { bg: "velo.muted" }, "&[aria-selected=true]": { bg: "velo.selectionIdle" }, _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "-2px" }, "& svg": { w: "3", h: "3", color: "velo.fgMuted", flex: "none" }, "& [data-count]": { ml: "auto", fontWeight: "400", color: "velo.fgMuted", fontVariantNumeric: "tabular-nums" } });
const moreRow = css({ display: "flex", alignItems: "center", gap: "1.5", h: "28px", px: "2.5", pl: "7", borderRadius: "l2", fontSize: "uiSm", color: "velo.accentText", cursor: "default", _hover: { bg: "velo.muted" }, "&[aria-selected=true]": { bg: "velo.selectionIdle" }, _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "-2px" } });
const trail = css({ display: "flex", alignItems: "center", gap: "1.5", h: "30px", px: "2.5", mb: "0.5", borderBottom: "1px solid", borderColor: "velo.muted", fontSize: "uiSm", color: "velo.fgMuted", cursor: "pointer", w: "full", textAlign: "left", _hover: { color: "velo.fg" }, "& svg": { w: "3.5", h: "3.5", flex: "none" }, "& span": { truncate: true } });
const empty = css({ display: "flex", flexDirection: "column", gap: "2", p: "7 4.5", color: "velo.fgMuted", fontSize: "ui", lineHeight: "1.5", "& strong": { color: "velo.fg", fontWeight: "600" } });
const actions = css({ display: "none", "[data-row]:hover &, [data-row]:focus-within &": { display: "flex" } });
const hint = css({ color: "velo.fgMuted", fontSize: "uiXs", whiteSpace: "nowrap" });
let consumedFocusReq = 0; // the last ⌘⇧C request the tree answered (module-level: the panel remounts with every open)

export function RelatedPanel({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const related = useStore(store, (s) => s.related);
  const openPath = useStore(store, (s) => s.openPath);
  const title = useStore(store, (s) => s.title);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const focusRelated = useStore(store, (s) => s.focusRelated);
  // only the open note's tree: a stale one (another note, or one locked away) must never show or answer keys
  const data = related?.centre === openPath ? (related?.data ?? null) : null;
  const centre = data ? related!.centre : null;
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [cur, setCur] = useState(""); // the row that is the tab stop, by id; the first row when gone
  const [peek, setPeek] = useState<string | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false); // a key moved the stop: focus it once rendered
  const hadFocus = useRef(false); // focus was in the tree: a re-render that unmounts the row must not drop it to <body>
  const lastCentre = useRef<string | null>(null);
  useEffect(() => {
    if (data && centre !== lastCentre.current) {
      lastCentre.current = centre; // a new note: big tag groups start closed, no peek
      setClosed(defaultClosed(data));
      setPeek(null);
    }
  }, [data, centre]);
  useEffect(() => () => void (consumedFocusReq = store.get().focusRelated), [store]); // the panel closed before the tree landed: the request is spent
  const rows = useMemo(() => (data ? relatedRows(data, closed) : []), [data, closed]);
  const curIdx = Math.max(0, rows.findIndex((r) => r.id === cur));
  useLayoutEffect(() => {
    if (!data) {
      if (!openPath || (related?.centre === openPath && related.err)) consumedFocusReq = focusRelated; // nothing to focus: the request is spent
      return; // the open note's tree is not here yet: keep the request
    }
    const active = document.activeElement;
    const inTree = !!el.current?.contains(active);
    const lost = active === null || active === document.body; // the focused row unmounted
    const requested = focusRelated !== consumedFocusReq;
    if (requested) consumedFocusReq = focusRelated;
    if (focusNext.current && !inTree && !lost) focusNext.current = false; // focus went elsewhere meanwhile: never steal it back
    if (!requested && !focusNext.current && !(hadFocus.current && lost)) return;
    focusNext.current = false;
    el.current?.querySelector<HTMLElement>(`[data-i="${curIdx}"]`)?.focus();
  });
  const go = (i: number) => {
    setCur(rows[i].id);
    focusNext.current = true;
  };
  const toggle = (id: string, open: boolean) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = (path: string, how: "stay" | "edit") => {
    focusNext.current = how === "stay"; // ↩ keeps you in the panel: the tree re-renders around the new note
    void controller.show(path).then((ok) => ok === true && how === "edit" && controller.focusEditor());
  };
  const activate = (row: RelatedRow, mod: "" | "shift" | "cmd") => {
    switch (row.kind) {
      case "section":
      case "tag":
        return toggle(row.id, !row.open);
      case "note":
        return open(row.node.path, mod === "cmd" ? "edit" : "stay");
      case "missing":
        return mod === "shift" ? void controller.createMissing(row.title) : undefined; // ⇧↩ creates; a plain ↩ must not make notes by accident
      case "mention":
        if (mod !== "shift") return open(row.mention.node.path, mod === "cmd" ? "edit" : "stay");
        if (row.mention.node.locked || data?.centre.locked) return; // never offered for locked notes
        focusNext.current = true; // the row goes away once linked: stay in the tree
        return void controller.linkMention(row.mention);
      case "more":
        return controller.setTags([row.tag]);
    }
  };
  const onKey = (e: KeyboardEvent, row: RelatedRow, i: number) => {
    if (e.target !== e.currentTarget) return;
    const step = stepRelated(rows, i, e.key);
    if (step) {
      e.preventDefault();
      if ("to" in step) go(step.to);
      else toggle(step.toggle, step.open);
      return;
    }
    if (e.key === "Enter") activate(row, e.shiftKey ? "shift" : e.metaKey || e.ctrlKey ? "cmd" : "");
    else if (e.key === " " && (row.kind === "note" || row.kind === "mention")) setPeek((p) => (p === row.id ? null : row.id));
    else if (e.key === "Escape") {
      if (el.current?.closest("[data-mode=overlay]")) return; // the panel closes itself
      controller.focusEditor();
    } else return;
    e.preventDefault();
  };
  const binding = (a: "back" | "extract_note") => (keys[a] === NONE ? "" : formatBinding(keys[a], isMac));
  const prev = controller.previousPath();
  const shiftEnter = isMac ? "⇧↩" : "Shift+Enter";

  if (!openPath) {
    return <div className={empty}>Open a note to see what's related.</div>;
  }
  const row = (r: RelatedRow, i: number) => {
    const common = { role: "treeitem" as const, "data-i": i, "data-row": "", tabIndex: i === curIdx ? 0 : -1, "aria-level": r.level, onFocus: () => { setCur(r.id); hadFocus.current = true; }, onKeyDown: (e: KeyboardEvent) => onKey(e, r, i) };
    if (r.kind === "section")
      return (
        <div key={r.id} {...common} aria-expanded={r.open} className={sectionHeader()} onClick={() => toggle(r.id, !r.open)}>
          <ChevronDown aria-hidden /> {r.title} <span data-count>{r.count}</span>
        </div>
      );
    if (r.kind === "tag")
      return (
        <div key={r.id} {...common} aria-expanded={r.open} className={tagRow} onClick={() => toggle(r.id, !r.open)}>
          <Hash aria-hidden /> {r.tag} <span data-count>{r.count}</span>
        </div>
      );
    if (r.kind === "more")
      return (
        <div key={r.id} {...common} className={moreRow} onClick={() => controller.setTags([r.tag])}>
          All {r.count.toLocaleString("en-US")} in the list
        </div>
      );
    const c = relatedRow({ kind: r.kind === "missing" ? "missing" : r.kind === "mention" ? "mention" : r.level === 3 ? "nested" : "note" });
    if (r.kind === "missing")
      return (
        <div key={r.id} {...common} className={c.root} aria-selected={false} onClick={() => activate(r, "shift")}>
          <div className={c.line}><span className={c.title}>{r.title}</span></div>
          <span className={c.context}>No note yet · <Kbd>{shiftEnter}</Kbd> create</span>
        </div>
      );
    const node = r.kind === "mention" ? r.mention.node : r.node;
    const peeking = peek === r.id;
    return (
      <div key={r.id} {...common} className={c.root} aria-selected={node.path === openPath} onClick={() => activate(r, "")} onDoubleClick={() => open(node.path, "edit")}>
        <div className={c.line}>
          {node.locked && <Lock aria-label="Locked" size={12} />}
          <span className={c.title}>{node.title}</span>
          <span className={c.date}>{ago(node.modified)}</span>
        </div>
        {r.kind === "mention" ? (
          <span className={c.context}>
            mentions “{r.mention.name}” {r.mention.count}×{!node.locked && !data?.centre.locked && <> · <Kbd>{shiftEnter}</Kbd> link</>}
          </span>
        ) : r.context ? (
          <span className={c.context}>{r.parent === "in" ? <HighlightedText text={r.context} query={title} /> : r.context}</span>
        ) : null}
        {r.kind === "mention" && !node.locked && !data?.centre.locked && (
          <div className={`${c.actions} ${actions}`}>
            <Button size="2xs" variant="subtle" colorPalette="green" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void controller.linkMention(r.mention); }}>Link it</Button>
          </div>
        )}
        {peeking && (
          <>
            <div className={c.peek}>{node.locked ? "Locked" : node.preview || "Empty note"}</div>
            <span className={hint}>Created {dateText(node.created)} · Updated {dateText(node.modified)} · <Kbd>↩</Kbd> open · <Kbd>Space</Kbd> close</span>
          </>
        )}
      </div>
    );
  };
  return (
    <>
      {prev && (
        <button type="button" className={trail} onClick={() => void controller.navigate("back")} title={`Back to ${stem(prev)}${binding("back") ? ` (${binding("back")})` : ""}`}>
          <ArrowLeft aria-hidden /> <span>{stem(prev)}</span> {binding("back") && <Kbd marginLeft="auto">{binding("back")}</Kbd>}
        </button>
      )}
      {related?.err ? (
        <div className={empty} role="alert">{related.err}</div>
      ) : !data ? (
        <div className={empty}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className={empty}>
          <strong>Nothing connects to “{title}” yet</strong>
          <span>Notes that link here, notes it links to, and notes that mention its title will show up in this panel. Type <Kbd>[[</Kbd> in the note to link one.</span>
        </div>
      ) : (
        <div ref={el} role="tree" aria-label="Related notes" className={tree} onBlur={(e) => { if (!el.current?.contains(e.relatedTarget as Node | null)) hadFocus.current = false; }}>
          {rows.map(row)}
        </div>
      )}
    </>
  );
}
