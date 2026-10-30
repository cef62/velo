import { Ellipsis, FolderLock } from "lucide-react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton, Kbd, Menu } from "@/components/ui";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { useStore } from "./useStore";

const label = css({ px: "2", py: "1", fontSize: "uiSm", fontWeight: "600", color: "fg.muted" });
const row = css({ display: "flex", alignItems: "center", gap: "2", w: "100%", "& svg, & [data-part=item-indicator]": { w: "4", h: "4", flex: "none" } }); // also sizes the unchecked ItemIndicator placeholder svg

/** The ⋯ menu: what the v2 header no longer shows and nothing else holds yet (Connections, Lock all), until the command palette takes them. */
export function OverflowMenu({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const openPath = useStore(store, (s) => s.openPath);
  const paneMode = useStore(store, (s) => s.paneMode);
  const dueCount = useStore(store, (s) => s.dueCount);
  const kbd = (a: Action) => (keys[a] === NONE ? null : <Kbd marginLeft="auto">{formatBinding(keys[a], isMac)}</Kbd>);
  const noNote = openPath === null;
  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <IconButton variant="plain" size="sm" aria-label="More actions" title="More actions" className={css({ "&[aria-expanded=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText" } })}>
          <Ellipsis />
        </IconButton>
      </Menu.Trigger>
      <Menu.Positioner>
        <Menu.Content minW="220px">
          <Menu.RadioItemGroup value={paneMode} onValueChange={(d) => d.value !== paneMode && controller.setPaneMode(d.value as typeof paneMode)}>
            <div className={label}>Left pane</div>
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
          <Menu.Separator />
          <Menu.Item value="lock-all" onSelect={() => void controller.lockEverything()}>
            <span className={row}>
              <FolderLock size={16} />
              Lock all
              {kbd("lock_all")}
            </span>
          </Menu.Item>
        </Menu.Content>
      </Menu.Positioner>
    </Menu.Root>
  );
}
