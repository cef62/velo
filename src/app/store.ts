import type { Settings, TagCount } from "../api";
import { resolve, type Action } from "../shortcuts";

/** Minimal observable state: React reads it through useSyncExternalStore, the controller writes it. */
export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(init: T): Store<T> {
  let state = init;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

export interface AppState {
  phase: "loading" | "setup" | "ready"; // setup = no notes folder
  query: string;
  indexing: { done: number; total: number } | null;
  listVersion: number; // bumped whenever the rows change
  listReset: number; // bumped when the result set restarts (new query/sort): the list scrolls to top
  count: number;
  hasMore: boolean;
  total: number;
  sel: number;
  listActive: boolean; // focus in search or list (selection style)
  openPath: string | null;
  title: string;
  encrypted: boolean;
  err: string;
  errFromSave: boolean; // err came from a failed save (the UI offers Retry)
  saving: boolean;
  conflict: string | null;
  renaming: boolean;
  previewOn: boolean;
  editorStyle: "rich" | "plain";
  layout: "vertical" | "horizontal";
  theme: "system" | "light" | "dark";
  fontSize: number;
  sort: "modified" | "title";
  keys: Record<Action, string>;
  isMac: boolean;
  tags: TagCount[];
  selectedTags: string[];
  tagPanelOpen: boolean;
  exactTitleMatch: boolean; // drives the ⇧↩ Create hint
  settings: Settings | null; // non-null = the Settings dialog is open on these saved settings
}

export const initialState = (isMac: boolean): AppState => ({
  phase: "loading",
  query: "",
  indexing: null,
  listVersion: 0,
  listReset: 0,
  count: 0,
  hasMore: false,
  total: 0,
  sel: -1,
  listActive: false,
  openPath: null,
  title: "",
  encrypted: false,
  err: "",
  errFromSave: false,
  saving: false,
  conflict: null,
  renaming: false,
  previewOn: false,
  editorStyle: "rich",
  layout: "vertical",
  theme: "system",
  fontSize: 14,
  sort: "modified",
  keys: resolve(undefined, isMac),
  isMac,
  tags: [],
  selectedTags: [],
  tagPanelOpen: false,
  exactTitleMatch: false,
  settings: null,
});
