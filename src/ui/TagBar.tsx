import { css } from "styled-system/css";
import { tagChip } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { tagBarItems } from "../tags";
import { useStore } from "./useStore";

// a band of its own: subtle background and a rule under it, so it reads apart from the text
const row = css({ flex: "none", display: "flex", flexWrap: "wrap", gap: "1.5", px: "5", py: "1.5", bg: "velo.subtle", borderBottomWidth: "1px", borderColor: "velo.border" });

export function TagBar({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const openPath = useStore(store, (s) => s.openPath);
  const tags = useStore(store, (s) => s.info.tags);
  const selected = useStore(store, (s) => s.selectedTags);
  if (!openPath || tags.length === 0) return null;
  return (
    <div className={row} role="group" aria-label="Note tags">
      {tagBarItems(tags, selected).map(({ tag, selected: on }) => (
        <button key={tag} type="button" className={tagChip({ selected: on }).root} aria-pressed={on} onClick={() => controller.toggleTagFilter(tag)}>#{tag}</button>
      ))}
    </div>
  );
}
