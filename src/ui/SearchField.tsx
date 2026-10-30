import { useLayoutEffect, useRef, useState } from "react";
import { Bookmark, Search, SquareCheck, X } from "lucide-react";
import { css } from "styled-system/css";
import { searchChip } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Input, Kbd } from "@/components/ui";
import { chipLayout, chipsFor, type Chip } from "../searchChips";
import { searchHint } from "./breakpoints";
import { showSearchHint } from "./layout";
import { registerSearchInput } from "./platform";
import { useStore } from "./useStore";
import { useWindowWidth } from "./useWindowWidth";

const wrap = css({ position: "relative", flex: "1 1 220px", minW: "searchMin", maxW: "searchMax" }); // v2: the search is the header's hero, capped at searchMax
const icon = css({ position: "absolute", left: "2.5", top: "50%", transform: "translateY(-50%)", w: "4", h: "4", color: "fg.muted", pointerEvents: "none" });
const capErr = css({ position: "absolute", left: "0", top: "100%", mt: "1", zIndex: "1", fontSize: "uiSm", color: "red.11", bg: "velo.canvas", px: "1", borderRadius: "4px" });
const hints = css({ position: "absolute", right: "1.5", top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center", gap: "1.5", pointerEvents: "none", "& button": { pointerEvents: "auto" } });
// active filters as chips inside the field (v2 §3 #9); a hidden copy measures every chip so the layout can fold or collapse them
const chipRow = css({ position: "absolute", left: "8", top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center", gap: "1", whiteSpace: "nowrap" });
const measureRow = css({ position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none", display: "inline-flex", gap: "1", whiteSpace: "nowrap" });
const clear = css({ display: "inline-flex", alignItems: "center", justifyContent: "center", w: "5", h: "5", borderRadius: "full", color: "velo.fgMuted", cursor: "pointer", _hover: { bg: "velo.muted", color: "velo.fg" }, _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "0" }, "& svg": { w: "3.5", h: "3.5" } });

const sameChips = (a: Chip[], b: Chip[]) => a.length === b.length && a.every((c, i) => c.kind === b[i].kind && c.label === b[i].label);

export function SearchField({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const query = useStore(store, (s) => s.query);
  const indexing = useStore(store, (s) => s.indexing !== null);
  const sel = useStore(store, (s) => s.sel);
  const exactTitleMatch = useStore(store, (s) => s.exactTitleMatch);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const capture = useStore(store, (s) => s.capture);
  const tasksMode = useStore(store, (s) => s.paneMode === "tasks");
  const chipsRef = useRef<Chip[]>([]); // useStore needs a stable reference: keep the last array while its chips are the same
  const chips = useStore(store, (s) => {
    const next = chipsFor(s.savedSearches, s.appliedSaved, { query: s.query, tags: s.selectedTags, noLinks: s.noLinks });
    return sameChips(chipsRef.current, next) ? chipsRef.current : (chipsRef.current = next);
  });
  // Timeline mode: ↑/↓ here move the timeline selection, announced through aria-activedescendant
  const timelineOpt = useStore(store, (s) => (s.paneMode === "timeline" ? (s.timeline.rows?.findIndex((r) => r.path === s.timeline.sel) ?? -1) + 1 : 0));
  const wrapEl = useRef<HTMLDivElement>(null);
  const hintsEl = useRef<HTMLSpanElement>(null);
  const measureEl = useRef<HTMLSpanElement>(null);
  const chipsEl = useRef<HTMLSpanElement>(null);
  const [hintW, setHintW] = useState(0); // typed text must never run under the hints
  const [chipsW, setChipsW] = useState(0); // nor under the chips
  const [fieldW, setFieldW] = useState(600);
  const [widths, setWidths] = useState<number[]>([]);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      setHintW(hintsEl.current?.offsetWidth ?? 0);
      setChipsW(chipsEl.current?.offsetWidth ?? 0);
      setFieldW(wrapEl.current?.offsetWidth ?? 0);
      const w = [...(measureEl.current?.children ?? [])].map((e) => (e as HTMLElement).offsetWidth);
      setWidths((old) => (old.length === w.length && old.every((x, i) => x === w[i]) ? old : w));
    });
    for (const e of [wrapEl.current, hintsEl.current, measureEl.current, chipsEl.current]) if (e) ro.observe(e);
    return () => ro.disconnect();
  }, [chips.length, capture]); // the measuring row (re)mounts with the chips
  // the room for chips and text: the field minus the icon inset and the right-hand ×; widths lag one render behind a chip change
  const layout = widths.length === chips.length ? chipLayout(fieldW - 36 - 28, widths, query !== "") : { shown: chips.length, folded: 0, collapse: false };
  const hintRoom = showSearchHint(useWindowWidth()); // the ⌘L hint goes first on narrow windows
  // Tasks mode: Enter opens a task, so the Create hints don't apply; with chips the ⌘L hint gives way to the ×
  const hint = capture || tasksMode || (query === "" && (!hintRoom || chips.length > 0)) ? [] : searchHint({ query, sel, exactTitleMatch, keys, isMac });
  const Icon = capture ? SquareCheck : Search;
  const focusInput = () => wrapEl.current?.querySelector("input")?.focus(); // a removed chip took the focus with it
  const openFilters = () => {
    controller.showTags(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>("#filters-panel [data-tags] button")?.focus());
  };
  const chip = (c: Chip, i: number) => (
    <span key={`${c.kind}:${c.label}`} className={searchChip({ kind: c.kind === "saved" ? "saved" : "tag" })} data-chip={i}>
      {c.kind === "saved" && <Bookmark aria-hidden style={{ marginRight: 3 }} />}
      {c.label}
      <button type="button" aria-label={`Remove ${c.kind === "saved" ? "saved search " : ""}${c.label}`} onClick={() => (controller.removeFilterChip(c), focusInput())}>
        <X aria-hidden />
      </button>
    </span>
  );
  const all = chips.map((c) => c.label).join(", ");
  const shown = layout.collapse ? [] : chips.slice(0, layout.shown);
  const more = layout.collapse ? `${chips.length} filter${chips.length === 1 ? "" : "s"}` : layout.folded ? `+${layout.folded}` : "";
  const hasChips = !capture && chips.length > 0;
  return (
    <div ref={wrapEl} className={wrap}>
      <Icon className={icon} aria-hidden="true" />
      {hasChips && (
        <>
          <span ref={measureEl} className={measureRow} aria-hidden="true">{chips.map(chip)}</span>
          <span ref={chipsEl} className={chipRow}>
            {shown.map(chip)}
            {more && (
              <button type="button" className={searchChip({ kind: "more" })} aria-label={`${layout.collapse ? chips.length : layout.folded} ${layout.collapse ? "filters" : "more filters"}: ${layout.collapse ? all : chips.slice(layout.shown).map((c) => c.label).join(", ")}. Open Filters`} onClick={openFilters}>
                {more}
              </button>
            )}
          </span>
        </>
      )}
      <Input
        ref={registerSearchInput}
        size="sm"
        aria-label={capture ? `Add a task to ${capture.target}` : hasChips ? `Search or create, ${chips.length} filter${chips.length === 1 ? "" : "s"}: ${all}` : "Search or create"}
        placeholder={capture ? `→ ${capture.target}` : hasChips ? "" : "Search or create…"}
        value={query}
        {...(timelineOpt && !capture ? { role: "combobox", "aria-expanded": true, "aria-controls": "timeline-list", "aria-activedescendant": `timeline-opt-${timelineOpt}` } : {})}
        style={{ paddingLeft: hasChips ? chipsW + 36 : undefined, paddingRight: hint.length || hasChips ? hintW + 14 : undefined }}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        disabled={indexing && !capture} // capture keeps the field: an "indexing" refusal shows under it, text kept
        className={css({ pl: "8", pr: "2", fontSize: "ui" })}
        onChange={(e) => controller.setQuery(e.target.value)}
        onFocus={() => controller.setListActive(true)}
        onBlur={() => {
          controller.setListActive(false);
          controller.blurCapture();
        }}
        onKeyDown={(e) => {
          if (capture && (e.key === "Escape" || e.key === "Enter")) {
            e.preventDefault();
            if (e.key === "Escape") controller.cancelCapture();
            else void controller.submitCapture(query);
          } else if (e.key === "Escape" && query !== "") {
            e.preventDefault();
            controller.setQuery("");
          } else if (e.key === "Enter") {
            e.preventDefault();
            void controller.enter(e.shiftKey || e.altKey, e.altKey);
          } else if (e.key === "Backspace" && hasChips && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
            e.preventDefault(); // caret at the start: the last chip goes
            controller.removeFilterChip();
          }
        }}
      />
      <span ref={hintsEl} className={hints}>
        {hint.map((h) => (
          <Kbd key={h} fontFamily="inherit" gap="1.5" aria-hidden="true">
            {h.split(" ").map((part) => (
              <span key={part}>{part}</span>
            ))}
          </Kbd>
        ))}
        {hasChips && !hint.length && (
          <button type="button" className={clear} aria-label="Clear filters" onClick={() => (controller.clearFilterChips(), focusInput())}>
            <X aria-hidden />
          </button>
        )}
      </span>
      {capture?.err && <div role="alert" className={capErr}>{capture.err}</div>}
    </div>
  );
}
