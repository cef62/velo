import { useSyncExternalStore } from "react";
import type { AppState, Store } from "../app/store";

/** Subscribe to the store. `pick` must return a primitive or an existing reference (a fresh object re-renders forever). */
export function useStore<T = AppState>(store: Store<AppState>, pick: (s: AppState) => T = (s) => s as T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}
