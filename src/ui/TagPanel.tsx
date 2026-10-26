import { useRef, useState } from "react";
import { css } from "styled-system/css";
import { tagChip } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Kbd } from "@/components/ui";
import { fold } from "../search";
import { formatBinding, NONE } from "../shortcuts";
import { useStore } from "./useStore";

const panel = css({ display: "flex", flexDirection: "column", gap: "2.5", pt: "3", px: "3.5", pb: "3.5", bg: "velo.chrome", borderBottom: "1px solid", borderColor: "velo.divider", flex: "none", maxH: "40vh", overflowY: "auto" });
const line = css({ display: "flex", alignItems: "center", gap: "2.5", fontSize: "uiSm" });
const chips = css({ display: "flex", flexWrap: "wrap", gap: "1.5" });

export function TagPanel({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const tagPanelOpen = useStore(store, (s) => s.tagPanelOpen);
  const selectedTags = useStore(store, (s) => s.selectedTags);
  const total = useStore(store, (s) => s.total);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const tags = useStore(store, (s) => s.tags);
  const group = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(0); // roving tab stop: Tab enters the group once, arrows move inside
  if (!tagPanelOpen) return null;
  const move = (to: number) => {
    const btns = group.current!.querySelectorAll<HTMLButtonElement>("button");
    const i = (to + btns.length) % btns.length;
    setCur(i);
    btns[i]?.focus();
  };
  const close = formatBinding(keys.toggle_tags, isMac);
  return (
    <section
      id="tag-panel"
      className={panel}
      aria-label="Tags"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          controller.showTags(false);
          controller.focusSearch();
        }
      }}
    >
      <div className={line}>
        <span className={css({ fontWeight: "600", color: "velo.fg" })}>Tags</span>
        <span className={css({ color: "velo.fgMuted" })}>
          {selectedTags.length > 0 && `${selectedTags.length} selected · `}
          {total} notes
        </span>
        <Button variant="plain" size="sm" marginLeft="auto" disabled={selectedTags.length === 0} onClick={() => controller.setTags([])}>
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
        className={chips}
        role="group"
        aria-label="Filter by tag"
        onKeyDown={(e) => {
          const i = [...group.current!.querySelectorAll("button")].indexOf(e.target as HTMLButtonElement);
          if (e.key === "ArrowRight") move(i + 1);
          else if (e.key === "ArrowLeft") move(i - 1);
          else return;
          e.preventDefault();
        }}
      >
        {tags.map((t, i) => {
          const on = selectedTags.some((x) => fold(x) === fold(t.tag));
          const c = tagChip({ selected: on });
          return (
            <button key={t.tag} type="button" className={c.root} aria-pressed={on} tabIndex={i === Math.min(cur, tags.length - 1) ? 0 : -1} onFocus={() => setCur(i)} onClick={() => controller.toggleTagFilter(t.tag)}>
              #{t.tag} <span className={c.count}>{t.count}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
