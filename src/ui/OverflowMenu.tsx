import { Ellipsis, FolderLock, Lock, LockOpen, Trash2 } from "lucide-react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton, Kbd, Menu } from "@/components/ui";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { useStore } from "./useStore";

const label = css({ px: "2", py: "1", fontSize: "uiSm", fontWeight: "600", color: "fg.muted" });
const row = css({ display: "flex", alignItems: "center", gap: "2", w: "100%", "& svg, & [data-part=item-indicator]": { w: "4", h: "4", flex: "none" } }); // also sizes the unchecked ItemIndicator placeholder svg

/** Folded header (< 720 px): the actions that no longer fit. Shortcuts keep working; they are only shown here. */
export function OverflowMenu({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  const kbd = (a: Action) => (s.keys[a] === NONE ? null : <Kbd marginLeft="auto">{formatBinding(s.keys[a], s.isMac)}</Kbd>);
  const noNote = s.openPath === null;
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <IconButton variant="plain" size="sm" aria-label="More actions" title="More actions" className={css({ "&[aria-expanded=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText" } })}>
          <Ellipsis />
        </IconButton>
      </Menu.Trigger>
      <Menu.Positioner>
        <Menu.Content minW="220px">
          <Menu.RadioItemGroup value={s.sort} onValueChange={(d) => d.value !== s.sort && void controller.toggleSort()}>
            <div className={label}>Sort</div>
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
          <Menu.RadioItemGroup value={s.editorStyle} onValueChange={(d) => d.value !== s.editorStyle && void controller.toggleStyle()}>
            <div className={label}>Edit style</div>
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
          <Menu.Item value="lock" disabled={noNote} onSelect={() => void controller.toggleLock()}>
            <span className={row}>
              {s.encrypted ? <LockOpen size={16} /> : <Lock size={16} />}
              {s.encrypted ? "Unlock note" : "Lock note"}
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
