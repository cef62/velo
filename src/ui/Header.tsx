import { Hash, Settings } from "lucide-react";
import { type ReactElement, type ReactNode } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton, Tooltip } from "@/components/ui";
import { activeFilterCount } from "../saved";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { OverflowMenu } from "./OverflowMenu";
import { SearchField } from "./SearchField";
import { UpdatePill } from "./UpdatePill";
import { useStore } from "./useStore";

// v2 header (design/park-ui/v2/README.md §2): search, Filters, Settings, in one row at every width; it never folds.
// The ⋯ menu holds what nothing else shows yet (Connections, Lock all) until the command palette takes them.
const bar = css({
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  h: "header",
  pr: "2.5",
  bg: "velo.chrome",
  boxShadow: "inset 0 1px 0 {colors.velo.highlight}", // clear surface: top highlight (v2 §12)
  borderBottom: "1px solid",
  borderColor: "velo.divider",
  flex: "none",
  minW: "0",
  fontSize: "ui",
  "[data-layout=horizontal] &": { gridColumn: "1 / -1" },
});
const grow = css({ flex: "1 1 0", minW: "0" }); // the search stops growing at searchMax; the extra width goes here
const pressed = css({ position: "relative", "&[aria-pressed=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText", boxShadow: "inset 0 0 0 1px {colors.velo.hairline}, inset 0 1px 0 {colors.velo.highlight}" } });
// active filter count on the Filters button
const dot = css({ position: "absolute", top: "1", right: "1", minW: "14px", h: "14px", px: "0.5", borderRadius: "full", bg: "velo.accent", color: "velo.accentFg", fontSize: "9px", fontWeight: "600", lineHeight: "14px", textAlign: "center", pointerEvents: "none" });

export function Header({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const tagPanelOpen = useStore(store, (s) => s.tagPanelOpen);
  const filters = useStore(store, (s) => activeFilterCount(s.savedSearches, { query: s.query, tags: s.selectedTags, noLinks: s.noLinks }));
  const tip = (text: string, action: Action | null, child: ReactElement) => {
    const b = action && keys[action] !== NONE ? formatBinding(keys[action], isMac) : "";
    return (
      <Tooltip content={b ? `${text} (${b})` : text} openDelay={500}>
        {child}
      </Tooltip>
    );
  };
  const icon = (text: string, action: Action | null, glyph: ReactNode, onClick: () => void, extra: { pressed?: boolean; controls?: string; label?: string } = {}) =>
    tip(
      text,
      action,
      <IconButton variant="plain" size="sm" aria-label={extra.label ?? text} aria-pressed={extra.pressed} aria-expanded={extra.controls ? extra.pressed : undefined} aria-controls={extra.controls} className={pressed} onClick={onClick}>
        {glyph}
      </IconButton>,
    );

  return (
    <header className={bar} data-tauri-drag-region={isMac || undefined} style={{ paddingLeft: isMac ? 96 : 14 }}>
      <SearchField controller={controller} store={store} />
      <span className={grow} data-tauri-drag-region={isMac || undefined} />
      <UpdatePill controller={controller} store={store} />
      {icon("Filters", "toggle_tags", <><Hash />{filters > 0 && <span className={dot} aria-hidden="true">{filters}</span>}</>, () => controller.showTags(!tagPanelOpen), {
        pressed: tagPanelOpen,
        controls: "filters-panel",
        label: filters > 0 ? `Filters, ${filters} active` : "Filters",
      })}
      <OverflowMenu controller={controller} store={store} />
      {icon("Settings", "settings", <Settings />, () => void controller.openSettings())}
    </header>
  );
}
