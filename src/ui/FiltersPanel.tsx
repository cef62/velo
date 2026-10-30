import { useEffect, useRef, useState } from "react";
import { css } from "styled-system/css";
import { tagChip } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Kbd } from "@/components/ui";
import { sameFilters } from "../saved";
import { fold } from "../search";
import { formatBinding, NONE } from "../shortcuts";
import { useStore } from "./useStore";

const panel = css({ display: "flex", flexDirection: "column", gap: "2.5", pt: "3", px: "3.5", pb: "3.5", bg: "velo.chrome", boxShadow: "inset 0 1px 0 {colors.velo.highlight}", borderBottom: "1px solid", borderColor: "velo.divider", flex: "none", maxH: "40vh", overflowY: "auto" });
const line = css({ display: "flex", alignItems: "center", gap: "2.5", fontSize: "uiSm" });
const chips = css({ display: "flex", flexWrap: "wrap", gap: "1.5" });
// two labelled rows (v2 §3 #10): Saved · Tags
const rowLabel = css({ w: "12", flex: "none", fontSize: "uiXs", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.05em", color: "velo.fgMuted", pt: "1.5" });
const labelled = css({ display: "flex", alignItems: "flex-start", gap: "2.5" });

export function FiltersPanel({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const tagPanelOpen = useStore(store, (s) => s.tagPanelOpen);
  const selectedTags = useStore(store, (s) => s.selectedTags);
  const total = useStore(store, (s) => s.total);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const noLinks = useStore(store, (s) => s.noLinks);
  const tags = useStore(store, (s) => s.tags);
  const query = useStore(store, (s) => s.query);
  const saved = useStore(store, (s) => s.savedSearches);
  const group = useRef<HTMLDivElement>(null);
  const capture = useStore(store, (s) => s.capture !== null);
  const [cur, setCur] = useState(0); // roving tab stop: Tab enters the group once, arrows move inside
  const k = saved.length; // one roving sequence: saved chips, No links, tag chips
  const menuAt = useRef<number | null>(null); // the saved chip whose menu opened last
  // Deleting the focused last chip drops focus to <body>: move it to the chip now at that place, the one before, or No links.
  useEffect(() => {
    const i = menuAt.current;
    menuAt.current = null;
    if (i === null || document.activeElement !== document.body || !group.current) return;
    const to = k === 0 ? 0 : Math.min(i, k - 1);
    setCur(to);
    group.current.querySelectorAll<HTMLButtonElement>("button")[to]?.focus();
  }, [k]);
  if (!tagPanelOpen) return null;
  const move = (to: number) => {
    const btns = group.current!.querySelectorAll<HTMLButtonElement>("button");
    const i = (to + btns.length) % btns.length;
    setCur(i);
    btns[i]?.focus();
  };
  const close = formatBinding(keys.toggle_tags, isMac);
  const stop = (i: number) => (i === Math.min(cur, k + tags.length) ? 0 : -1);
  const filtered = !capture && (query.trim() !== "" || selectedTags.length > 0 || noLinks); // capture text is not a search
  const active = selectedTags.length + (noLinks ? 1 : 0);
  return (
    <section
      id="filters-panel"
      className={panel}
      aria-label="Filters"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          controller.showTags(false);
          controller.focusSearch();
        }
      }}
    >
      <div className={line}>
        <span className={css({ fontWeight: "600", color: "velo.fg" })}>Filters</span>
        <span className={css({ color: "velo.fgMuted" })}>
          {active > 0 && `${active} active · `}
          {total} notes
        </span>
        <Button variant="plain" size="sm" marginLeft="auto" disabled={!filtered} onClick={() => controller.startSaveSearch()}>
          Save search…
        </Button>
        <Button variant="plain" size="sm" disabled={selectedTags.length === 0 && !noLinks} onClick={() => controller.clearFilters()}>
          Clear
        </Button>
        {keys.toggle_tags !== NONE && (
          <span className={css({ display: "inline-flex", alignItems: "center", gap: "1.5", color: "velo.fgMuted", whiteSpace: "nowrap" })}>
            <Kbd>{close}</Kbd> close
          </span>
        )}
      </div>
      <div
        ref={group}
        className={css({ display: "flex", flexDirection: "column", gap: "2.5" })}
        onKeyDown={(e) => {
          const i = [...group.current!.querySelectorAll("button")].indexOf(e.target as HTMLButtonElement);
          if (e.key === "ArrowRight") move(i + 1);
          else if (e.key === "ArrowLeft") move(i - 1);
          else return;
          e.preventDefault();
        }}
      >
        {k > 0 && (
          <div className={labelled}>
          <span className={rowLabel} aria-hidden>Saved</span>
          <div className={chips} role="group" aria-label="Saved searches">
            {saved.map((x, i) => {
              const on = sameFilters(x, { query, tags: selectedTags, noLinks });
              return (
                <button
                  key={i} // index keys: a rename or delete keeps the focused node, so focus stays on that place
                  type="button"
                  data-saved
                  className={tagChip({ selected: on, kind: "saved" }).root}
                  aria-pressed={on}
                  tabIndex={stop(i)}
                  onFocus={() => setCur(i)}
                  onClick={() => controller.applySaved(x.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    menuAt.current = i;
                    void controller.savedMenu(x.name, false);
                  }}
                  onKeyDown={(e) => {
                    if (!controller.isMenuKey(e.nativeEvent)) return;
                    e.preventDefault();
                    menuAt.current = i;
                    void controller.savedMenu(x.name, true);
                  }}
                >
                  {x.name}
                </button>
              );
            })}
          </div>
          </div>
        )}
        <div className={labelled}>
        <span className={rowLabel} aria-hidden>Tags</span>
        <div className={chips} role="group" aria-label="Filter by tag" data-tags>
          <button type="button" className={tagChip({ selected: noLinks }).root} aria-pressed={noLinks} tabIndex={stop(k)} onFocus={() => setCur(k)} onClick={() => controller.setNoLinks(!noLinks)}>
            No links
          </button>
          {tags.map((t, i) => {
            const on = selectedTags.some((x) => fold(x) === fold(t.tag));
            const c = tagChip({ selected: on });
            return (
              <button key={t.tag} type="button" className={c.root} aria-pressed={on} tabIndex={stop(k + i + 1)} onFocus={() => setCur(k + i + 1)} onClick={() => controller.toggleTagFilter(t.tag)}>
                #{t.tag} <span className={c.count}>{t.count}</span>
              </button>
            );
          })}
        </div>
        </div>
      </div>
    </section>
  );
}
