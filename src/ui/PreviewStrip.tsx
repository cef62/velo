import { banner } from "styled-system/recipes";
import type { AppState, Store } from "../app/store";
import { formatBinding } from "../shortcuts";
import { useStore } from "./useStore";

export function PreviewStrip({ store }: { store: Store<AppState> }) {
  const s = useStore(store);
  if (!s.previewOn) return null;
  return (
    <div className={banner({ tone: "preview" })}>
      Preview — read only · {formatBinding(s.keys.toggle_preview, s.isMac)} to edit
    </div>
  );
}
