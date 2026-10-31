import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { css } from "styled-system/css";
import { countBadge, sidePanel } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton, Tooltip } from "@/components/ui";
import { relatedCount } from "../related";
import { InfoTab } from "./InfoPanel";
import { sidePanelMode } from "./layout";
import { RelatedPanel } from "./RelatedPanel";
import { useStore } from "./useStore";

// The side panel (design v2 §2, §5): Related · Info beside the note. Docked when the note keeps ≥ 480 px,
// else over the note (Esc closes). ⌘I toggles it, ⌘⇧C opens it on Related.
const TABS = ["related", "info"] as const;

export function SidePanel({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const open = useStore(store, (s) => s.infoOpen);
  const tab = useStore(store, (s) => s.sideTab);
  const layout = useStore(store, (s) => s.layout);
  const count = useStore(store, (s) => relatedCount(s.related?.centre === s.openPath ? (s.related?.data ?? null) : null));
  const el = useRef<HTMLElement>(null);
  const [paneW, setPaneW] = useState(1000);
  useLayoutEffect(() => {
    const parent = el.current?.parentElement; // the note + panel box: its width without the panel decides docked vs overlay
    if (!parent) return;
    const ro = new ResizeObserver(() => setPaneW(parent.clientWidth));
    ro.observe(parent);
    setPaneW(parent.clientWidth);
    return () => ro.disconnect();
  }, [open]);
  if (!open) return null;
  const mode = layout === "vertical" ? "docked" : sidePanelMode(paneW);
  const c = sidePanel({ mode });
  return (
    <aside
      ref={el}
      className={c.root}
      aria-label="Side panel"
      data-side-panel=""
      data-mode={mode}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        if (mode === "overlay") void controller.toggleInfo();
        controller.focusEditor();
      }}
    >
      <div
        className={c.tabs}
        role="tablist"
        aria-label="Side panel"
        onKeyDown={(e) => {
          const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const to = TABS[(TABS.indexOf(tab) + d + TABS.length) % TABS.length];
          controller.setSideTab(to);
          el.current?.querySelector<HTMLElement>(`[role=tab][data-tab="${to}"]`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" data-tab={t} id={`side-tab-${t}`} aria-selected={t === tab} aria-controls="side-panel-body" tabIndex={t === tab ? 0 : -1} className={c.tab} onClick={() => controller.setSideTab(t)}>
            {t === "related" ? "Related" : "Info"}
            {t === "related" && count > 0 && <span className={countBadge({ tone: "neutral" })}>{count}</span>}
          </button>
        ))}
        {mode === "overlay" && (
          <Tooltip content="Close panel (Esc)" openDelay={500}>
            <IconButton variant="plain" size="xs" aria-label="Close panel" className={css({ ml: "auto" })} onClick={() => { void controller.toggleInfo(); controller.focusEditor(); }}>
              <X />
            </IconButton>
          </Tooltip>
        )}
      </div>
      <div id="side-panel-body" role="tabpanel" aria-labelledby={`side-tab-${tab}`} className={c.body}>
        {tab === "related" ? <RelatedPanel controller={controller} store={store} /> : <InfoTab controller={controller} store={store} />}
      </div>
    </aside>
  );
}
