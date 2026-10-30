import { Ellipsis, Eye, FolderLock, Lock, LockOpen, Trash2 } from "lucide-react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton, Kbd, Menu } from "@/components/ui";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { useStore } from "./useStore";

const label = css({ px: "2", py: "1", fontSize: "uiSm", fontWeight: "600", color: "fg.muted" });
const row = css({ display: "flex", alignItems: "center", gap: "2", w: "100%", "& svg, & [data-part=item-indicator]": { w: "4", h: "4", flex: "none" } }); // also sizes the unchecked ItemIndicator placeholder svg

/** The ⋯ menu: controls the v2 header no longer shows, until the pane bar, the title bar and the command palette take them. Shortcuts keep working. */
export function OverflowMenu({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const openPath = useStore(store, (s) => s.openPath);
  const sort = useStore(store, (s) => s.sort);
  const editorStyle = useStore(store, (s) => s.editorStyle);
  const encrypted = useStore(store, (s) => s.encrypted);
  const paneMode = useStore(store, (s) => s.paneMode);
  const previewOn = useStore(store, (s) => s.previewOn);
  const dueCount = useStore(store, (s) => s.dueCount);
  const kbd = (a: Action) => (keys[a] === NONE ? null : <Kbd marginLeft="auto">{formatBinding(keys[a], isMac)}</Kbd>);
  const noNote = openPath === null;
  return (
    <Menu.Root size="sm" positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <IconButton variant="plain" size="sm" aria-label="More actions" title="More actions" className={css({ "&[aria-expanded=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText" } })}>
          <Ellipsis />
        </IconButton>
      </Menu.Trigger>
      <Menu.Positioner>
        <Menu.Content minW="220px" maxH="var(--available-height)"> {/* 12 items: never clipped by the recipe's 384px cap */}
          <Menu.RadioItemGroup value={paneMode} onValueChange={(d) => d.value !== paneMode && controller.setPaneMode(d.value as typeof paneMode)}>
            <Menu.ItemGroupLabel className={label}>Left pane</Menu.ItemGroupLabel>
            <Menu.RadioItem value="notes">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Notes</Menu.ItemText></span>
            </Menu.RadioItem>
            <Menu.RadioItem value="tasks">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Tasks{dueCount > 0 ? ` (${dueCount} due)` : ""}</Menu.ItemText>
                {kbd("toggle_tasks")}</span>
            </Menu.RadioItem>
            <Menu.RadioItem value="connections" disabled={noNote && paneMode !== "connections"}>
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Connections</Menu.ItemText>
                {kbd("toggle_connections")}</span>
            </Menu.RadioItem>
            <Menu.RadioItem value="timeline">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Timeline</Menu.ItemText>
                {kbd("toggle_timeline")}</span>
            </Menu.RadioItem>
          </Menu.RadioItemGroup>
          <Menu.RadioItemGroup value={sort} onValueChange={(d) => d.value !== sort && void controller.toggleSort()}>
            <Menu.ItemGroupLabel className={label}>Sort</Menu.ItemGroupLabel>
            <Menu.RadioItem value="modified">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Recent</Menu.ItemText></span>
            </Menu.RadioItem>
            <Menu.RadioItem value="title">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Title A→Z</Menu.ItemText>
                {kbd("toggle_sort")}</span>
            </Menu.RadioItem>
          </Menu.RadioItemGroup>
          <Menu.RadioItemGroup value={editorStyle} onValueChange={(d) => d.value !== editorStyle && void controller.toggleStyle()}>
            <Menu.ItemGroupLabel className={label}>Edit style</Menu.ItemGroupLabel>
            <Menu.RadioItem value="rich">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Rich</Menu.ItemText>
                {kbd("toggle_rich")}</span>
            </Menu.RadioItem>
            <Menu.RadioItem value="plain">
              <span className={row}><Menu.ItemIndicator />
                <Menu.ItemText>Plain</Menu.ItemText></span>
            </Menu.RadioItem>
          </Menu.RadioItemGroup>
          <Menu.Separator />
          <Menu.CheckboxItem value="preview" checked={previewOn} onCheckedChange={() => controller.togglePreview()}>
            <span className={row}>
              <Menu.ItemIndicator />
              <Eye size={16} />
              <Menu.ItemText>Preview</Menu.ItemText>
              {kbd("toggle_preview")}
            </span>
          </Menu.CheckboxItem>
          <Menu.Item value="lock" disabled={noNote} onSelect={() => void controller.toggleLock()}>
            <span className={row}>
              {encrypted ? <LockOpen size={16} /> : <Lock size={16} />}
              {encrypted ? "Unlock note" : "Lock note"}
              {kbd("toggle_lock")}
            </span>
          </Menu.Item>
          <Menu.Item value="lock-all" onSelect={() => void controller.lockEverything()}>
            <span className={row}>
              <FolderLock size={16} />
              Lock all
              {kbd("lock_all")}
            </span>
          </Menu.Item>
          <Menu.Item value="trash" disabled={noNote} onSelect={() => void controller.deleteNote()}>
            <span className={row}>
              <Trash2 size={16} />
              Move to Trash
              {kbd("delete_note")}
            </span>
          </Menu.Item>
        </Menu.Content>
      </Menu.Positioner>
    </Menu.Root>
  );
}
