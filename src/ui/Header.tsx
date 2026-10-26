import { ArrowDownAZ, Clock, Code, Eye, FolderLock, Hash, Lock, LockOpen, Settings, Trash2, Type } from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { css } from "styled-system/css";
import { previewPill } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton, SegmentGroup, Tooltip } from "@/components/ui";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { headerMode } from "./breakpoints";
import { OverflowMenu } from "./OverflowMenu";
import { SearchField } from "./SearchField";
import { useStore } from "./useStore";

const bar = css({
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  h: "header",
  pr: "3",
  bg: "velo.chrome",
  borderBottom: "1px solid",
  borderColor: "velo.divider",
  flex: "none",
  minW: "0",
  fontSize: "ui",
  "[data-layout=horizontal] &": { gridColumn: "1 / -1" },
});
const sep = css({ w: "1px", h: "5", bg: "velo.divider", mx: "1", flex: "none" });
const pressed = css({ "&[aria-pressed=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText" } });

function useWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function Header({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const openPath = useStore(store, (s) => s.openPath);
  const tagPanelOpen = useStore(store, (s) => s.tagPanelOpen);
  const sort = useStore(store, (s) => s.sort);
  const editorStyle = useStore(store, (s) => s.editorStyle);
  const previewOn = useStore(store, (s) => s.previewOn);
  const encrypted = useStore(store, (s) => s.encrypted);
  const mode = headerMode(useWidth());
  const tip = (text: string, action: Action | null, child: ReactElement) => {
    const b = action && keys[action] !== NONE ? formatBinding(keys[action], isMac) : "";
    return (
      <Tooltip content={b ? `${text} (${b})` : text} openDelay={500}>
        {child}
      </Tooltip>
    );
  };
  const icon = (text: string, action: Action | null, glyph: ReactNode, onClick: () => void, extra: { disabled?: boolean; pressed?: boolean; controls?: string } = {}) =>
    tip(
      text,
      action,
      <IconButton
        variant="plain"
        size="sm"
        aria-label={text}
        disabled={extra.disabled}
        aria-pressed={extra.pressed}
        aria-expanded={extra.controls ? extra.pressed : undefined}
        aria-controls={extra.controls}
        className={pressed}
        onClick={onClick}
      >
        {glyph}
      </IconButton>,
    );
  const noNote = openPath === null;
  const iconOnly = mode !== "full";
  const seg = <V extends string>(name: string, value: V, set: () => void, items: { value: V; text: string; glyph: ReactNode; action: Action }[]) => (
    <SegmentGroup.Root size="sm" value={value} onValueChange={(d) => d.value !== value && set()} aria-label={name}>
      <SegmentGroup.Indicator />
      {items.map((it) => (
        <Tooltip key={it.value} content={`${it.text}${keys[it.action] === NONE ? "" : ` (${formatBinding(keys[it.action], isMac)})`}`} openDelay={500} disabled={!iconOnly}>
          <SegmentGroup.Item value={it.value}>
            {it.glyph}
            {!iconOnly && <SegmentGroup.ItemText>{it.text}</SegmentGroup.ItemText>}
            <SegmentGroup.ItemHiddenInput aria-label={it.text} />
          </SegmentGroup.Item>
        </Tooltip>
      ))}
    </SegmentGroup.Root>
  );

  return (
    <header className={bar} data-tauri-drag-region={isMac || undefined} style={{ paddingLeft: isMac ? 80 : 14 }}>
      <SearchField controller={controller} store={store} />
      {icon("Tags", "toggle_tags", <Hash />, () => controller.showTags(!tagPanelOpen), { pressed: tagPanelOpen, controls: "tag-panel" })}
      {mode !== "folded" && (
        <>
          {seg("Sort", sort, () => void controller.toggleSort(), [
            { value: "modified", text: "Recent", glyph: <Clock size={14} />, action: "toggle_sort" },
            { value: "title", text: "A→Z", glyph: <ArrowDownAZ size={14} />, action: "toggle_sort" },
          ])}
          {seg("Edit style", editorStyle, () => void controller.toggleStyle(), [
            { value: "rich", text: "Rich", glyph: <Type size={14} />, action: "toggle_rich" },
            { value: "plain", text: "Plain", glyph: <Code size={14} />, action: "toggle_rich" },
          ])}
        </>
      )}
      {previewOn
        ? tip(
            "Preview on",
            "toggle_preview",
            <button type="button" className={previewPill()} aria-pressed="true" onClick={() => controller.togglePreview()}>
              Preview
            </button>,
          )
        : icon("Preview", "toggle_preview", <Eye />, () => controller.togglePreview(), { pressed: false })}
      {mode === "full" && <span className={sep} role="separator" />}
      {mode === "folded" ? (
        <OverflowMenu controller={controller} store={store} />
      ) : (
        <>
          {icon(encrypted ? "Unlock note" : "Lock note", "toggle_lock", encrypted ? <LockOpen /> : <Lock />, () => void controller.toggleLock(), { disabled: noNote })}
          {icon("Lock all", "lock_all", <FolderLock />, () => void controller.lockEverything())}
          {icon("Move to Trash", "delete_note", <Trash2 />, () => void controller.deleteNote(), { disabled: noNote })}
        </>
      )}
      {icon("Settings", "settings", <Settings />, () => void controller.openSettings())}
    </header>
  );
}
