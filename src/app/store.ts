import type { Connections, NoteMeta, RevisionInfo, Settings, TagCount, TaskView } from "../api";
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

/** Note info panel data for the open note; backlinks/revisions load only while the panel is open. */
export interface InfoState {
  meta: NoteMeta | null;
  words: number;
  tags: string[]; // front-matter tags merged with body #tags
  backlinks: number | null;
  revisions: RevisionInfo[] | null;
  preview: { id: string; text: string } | null;
}
export const noInfo: InfoState = { meta: null, words: 0, tags: [], backlinks: null, revisions: null, preview: null };

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
  headerLabels: boolean;
  writeFrontMatter: boolean;
  showFrontMatter: boolean;
  infoOpen: boolean;
  info: InfoState;
  sort: "modified" | "title";
  keys: Record<Action, string>;
  isMac: boolean;
  tags: TagCount[];
  selectedTags: string[];
  tagPanelOpen: boolean;
  noLinks: boolean; // the No links chip: only notes with no wikilinks in or out
  exactTitleMatch: boolean; // drives the ⇧↩ Create hint
  settings: Settings | null; // non-null = the Settings dialog is open on these saved settings
  update: { version: string; status: "available" | "current" | "installing" | "failed"; message?: string } | null; // the update banner; message: install progress or the failure
  paneMode: "notes" | "tasks" | "connections"; // what the left pane lists
  connections: { centre: string; data: Connections | null; err: string } | null; // the Connections view; centre stays put while notes open from it
  connectionsSort: "ring" | "created" | "updated";
  taskView: TaskView | null; // filtered by query/selectedTags like the notes list
  dueCount: number; // overdue + today, unfiltered: the Tasks switch count and the Dock badge
  showDone: boolean;
  tickUndo: { path: string; line: number; lineText: string; unticked: boolean } | null; // "Ticked · Undo" (or "Unticked") after a backend tick
  extract: { title: string; err: string } | null; // the Move to new note dialog
  capture: { target: string; err: string } | null; // the search field is in quick-capture mode
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
  headerLabels: false,
  writeFrontMatter: true,
  showFrontMatter: false,
  infoOpen: false,
  info: noInfo,
  sort: "modified",
  keys: resolve(undefined, isMac),
  isMac,
  tags: [],
  selectedTags: [],
  tagPanelOpen: false,
  exactTitleMatch: false,
  settings: null,
  update: null,
  paneMode: "notes",
  connections: null,
  connectionsSort: "ring",
  noLinks: false,
  taskView: null,
  dueCount: 0,
  showDone: false,
  tickUndo: null,
  extract: null,
  capture: null,
});
