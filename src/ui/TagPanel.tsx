import { useRef, useState } from "react";
import { css } from "styled-system/css";
import { tagChip } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Kbd } from "@/components/ui";
import { formatBinding, NONE } from "../shortcuts";
import { useStore } from "./useStore";

const panel = css({ display: "flex", flexDirection: "column", gap: "2.5", pt: "3", px: "3.5", pb: "3.5", bg: "velo.chrome", borderBottom: "1px solid", borderColor: "velo.divider", flex: "none", maxH: "40vh", overflowY: "auto" });
const line = css({ display: "flex", alignItems: "center", gap: "2.5", fontSize: "uiSm" });
const chips = css({ display: "flex", flexWrap: "wrap", gap: "1.5" });

export function TagPanel({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  const group = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(0); // roving tab stop: Tab enters the group once, arrows move inside
  if (!s.tagPanelOpen) return null;
  const move = (to: number) => {
    const btns = group.current!.querySelectorAll<HTMLButtonElement>("button");
    const i = (to + btns.length) % btns.length;
    setCur(i);
    btns[i]?.focus();
  };
  const close = formatBinding(s.keys.toggle_tags, s.isMac);
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
          {s.selectedTags.length > 0 && `${s.selectedTags.length} selected · `}
          {s.total} notes
        </span>
        <Button variant="plain" size="sm" marginLeft="auto" disabled={s.selectedTags.length === 0} onClick={() => controller.setTags([])}>
          Clear
        </Button>
        {s.keys.toggle_tags !== NONE && (
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
        {s.tags.map((t, i) => {
          const on = s.selectedTags.includes(t.tag);
          const c = tagChip({ selected: on });
          return (
            <button key={t.tag} type="button" className={c.root} aria-pressed={on} tabIndex={i === Math.min(cur, s.tags.length - 1) ? 0 : -1} onFocus={() => setCur(i)} onClick={() => controller.toggleTagFilter(t.tag)}>
              #{t.tag} <span className={c.count}>{t.count}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
