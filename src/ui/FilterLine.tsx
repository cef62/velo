import { banner } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button } from "@/components/ui";
import { useStore } from "./useStore";

/** Panel closed, tag filter still applied: the only place Clear lives then. */
export function FilterLine({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  if (s.tagPanelOpen || s.selectedTags.length === 0) return null;
  return (
    <div className={banner({ tone: "filter" })} role="status">
      Filtered by {s.selectedTags.map((t) => <b key={t}>#{t}</b>)}
      <span aria-hidden>·</span>
      <Button variant="plain" size="2xs" h="22px" fontSize="uiSm" onClick={() => controller.setTags([])}>
        Clear
      </Button>
      <span style={{ marginLeft: "auto" }}>{s.total} notes</span>
    </div>
  );
}
