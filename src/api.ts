import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

export type Hit = { path: string; title: string; snippet: string; mtime: number; encrypted: boolean };
export type NoteMeta = { created: number; created_src: "frontmatter" | "file"; modified: number; modified_src: "frontmatter" | "file"; tags: string[]; aliases: string[] };
export type NoteDoc = { path: string; title: string; text: string; hash: string; encrypted: boolean; meta: NoteMeta };
export type SaveResult = { kind: "saved"; hash: string; front_matter: string | null; meta: NoteMeta } | { kind: "conflict"; conflict_path: string; disk_hash: string };
export type TaskItem = { path: string; title: string; line: number; text: string; due: string | null; done: boolean; done_on: string | null; line_text: string };
export type TaskView = { overdue: TaskItem[]; today: TaskItem[]; upcoming: TaskItem[]; no_date: TaskItem[]; done: TaskItem[]; due_count: number };
export type RenameResult = { path: string; rewritten: number };
export type MergeResult = { path: string; rewritten: number; trash_error: string | null };
export type SavedSearch = { name: string; query: string; tags: string[]; no_links: boolean };
export type Settings = { notes_dir: string | null; layout: "vertical" | "horizontal"; font_size: number; sort: "modified" | "title"; editor_style: "rich" | "plain"; theme: "system" | "light" | "dark"; header_labels: boolean; shortcuts: Record<string, string>; write_front_matter: boolean; show_front_matter: boolean; info_panel: boolean; auto_update_check: boolean; capture_target: "inbox" | "daily"; inbox_title: string; agent_access: boolean; connections_sort: "ring" | "created" | "updated"; saved_searches: SavedSearch[]; timeline_sort: "updated" | "created" };

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) => invoke<void>("set_settings", { settings });
export type Page = { hits: Hit[]; has_more: boolean; total: number };
export type TagCount = { tag: string; count: number };
export const search = (query: string, sort: "modified" | "title", offset: number, tags: string[], noLinks: boolean) => invoke<Page>("search", { query, sort, offset, tags, noLinks });
export type TimelineRow = { path: string; title: string; date: number; snippet: string; locked: boolean };
export const timeline = (query: string, tags: string[], noLinks: boolean, by: "created" | "updated", sinceMs: number | null) => invoke<TimelineRow[]>("timeline", { query, tags, noLinks, by, sinceMs });
export type ExportRequest = { query: string; tags: string[]; no_links: boolean; by: "created" | "updated"; since_ms: number | null; tasks_only: boolean; title: string };
export type ExportCounts = { notes: number; open: number; done: number; locked: number; over_limit: number; no_tasks: number; unreadable: number };
export const exportPreview = (request: ExportRequest) => invoke<ExportCounts>("export_preview", { request });
export const exportText = (request: ExportRequest) => invoke<string>("export_text", { request });
/** Writes the export to exactly `path`. */
export const exportMarkdown = (path: string, request: ExportRequest) => invoke<ExportCounts>("export_markdown", { path, request });
export const listTags = () => invoke<TagCount[]>("list_tags");
export const listTitles = () => invoke<string[]>("list_titles");
/** `name == title` rows are titles, the others aliases. */
export type LinkTarget = { name: string; title: string; path: string; modified: number; locked: boolean };
export const listLinkTargets = () => invoke<LinkTarget[]>("list_link_targets");
/** Creates the note `title` holding `text`; rejects with "already-exists" or "invalid-title". */
export const createFromSelection = (title: string, text: string) => invoke<string>("create_from_selection", { title, text });
export const openNote = (path: string) => invoke<NoteDoc>("open_note", { path });
/** `created`: the file did not exist before this call. */
export const openOrCreate = (title: string) => invoke<NoteDoc & { created: boolean }>("open_or_create", { title });
export const saveNote = (path: string, text: string, baseHash: string) => invoke<SaveResult>("save_note", { path, text, baseHash });
export const tasks = (query: string, tags: string[], showDone: boolean) => invoke<TaskView>("tasks", { query, tags, showDone });
/** Resolves to the toggled task's line and raw text as saved (front-matter stamping may shift it): what undo sends. */
export const toggleTask = (path: string, line: number, expected: string) => invoke<{ line: number; line_text: string }>("toggle_task", { path, line, expected });
export const captureTask = (text: string) => invoke<string>("capture_task", { text });
/** The capture note's title and, if it exists, the path capture_task writes to (an alias resolves to its note). */
export const captureTargetTitle = () => invoke<{ title: string; path: string | null }>("capture_target_title");
/** Capture finished or cancelled: hides velo again if the capture shortcut showed it. */
/** Ends the capture session; `hide`: hide velo again if the capture shortcut showed it. */
export const captureDone = (hide: boolean) => invoke<void>("capture_done", { hide });
export const setBadge = (count: number) => invoke<void>("set_badge", { count });
export const renameNote = (path: string, newTitle: string, rewriteLinks: boolean) => invoke<RenameResult>("rename_note", { path, newTitle, rewriteLinks });
export type GraphNode = { path: string; title: string; created: number; modified: number; preview: string; locked: boolean };
export type TagGroup = { tag: string; count: number; notes: GraphNode[] };
export type Mention = { node: GraphNode; name: string; count: number };
export type Connections = { centre: GraphNode; links_out: GraphNode[]; links_in: GraphNode[]; tags: TagGroup[]; mentions: Mention[] };
export const connections = (path: string) => invoke<Connections>("connections", { path });
/** Wraps the first mention in [[…]]; with editorText: resolves to the rewritten text (the editor applies it); without: saves and resolves null. Rejects "mention-moved" | "locked" | "conflict". */
export const linkMention = (path: string, targetTitle: string, expectedCount: number, editorText: string | null) => invoke<string | null>("link_mention", { path, targetTitle, expectedCount, editorText });
/** Notes linking to this one by title or alias: the info panel's "Linked from". */
export const linkedFromCount = (path: string) => invoke<number>("linked_from_count", { path });
export const backlinkCount = (title: string) => invoke<number>("backlink_count", { title });
export const lockNote = (path: string) => invoke<string>("lock_note", { path });
export const unlockNote = (path: string) => invoke<string>("unlock_note", { path });
export const lockAll = () => invoke<void>("lock_all");
export const deleteNote = (path: string) => invoke<void>("delete_note", { path });
/** Rejects with "same-note" | "locked" | "conflict" | another backend error. */
export const mergeNotes = (source: string, target: string) => invoke<MergeResult>("merge_notes", { source, target });
export type RevisionInfo = { id: string; ts: number; size: number; summary?: string | null; agent: boolean };
export const listRevisions = (path: string) => invoke<RevisionInfo[]>("list_revisions", { path });
export const readRevision = (path: string, id: string) => invoke<string>("read_revision", { path, id });
/** An agent write offered to the editor (`agent-write`): `replace` carries the note's whole new text and the hash it was based on. */
export type AgentWrite = {
  id: number;
  path: string;
  kind: "replace" | "append" | "trash" | "rename" | "renamed" | "flush" | "trash-failed";
  /** `replace`: the note's whole new text; `append`: the line to add. */
  insert?: string;
  base?: string;
  summary?: string;
  /** `renamed`: the new path, null when the rename failed. */
  to?: string | null;
  /** `flush`: notes whose links a rename is about to rewrite. */
  paths?: string[];
  /** `trash-failed`: the note the editor closed for a trash that then failed, and why. */
  title?: string;
  error?: string;
};
export type AgentReply = { hash: string } | "not-open" | "refused" | "conflict" | "unsaved" | "closed" | "ready" | "flushed" | "ok";
/** Called right before applying `id`: false once the backend stopped waiting (then leave everything as it is). */
export const agentWriteClaim = (id: number) => invoke<boolean>("agent_write_claim", { id });
export const agentWriteDone = (id: number, result: AgentReply) => invoke<void>("agent_write_done", { id, result });
/** The snapshot's id (null: an empty note has nothing to keep). */
export const snapshotAgent = (path: string, summary: string) => invoke<string | null>("snapshot_agent", { path, summary });
/** Deletes agent snapshot `id` of `path`, taken for an agent write that was then not applied. */
export const dropAgentSnapshot = (path: string, id: string) => invoke<void>("drop_agent_snapshot", { path, id });
export const snapshotText = (path: string, text: string) => invoke<void>("snapshot_text", { path, text });
export const agentSetupCommand = () => invoke<string>("agent_setup_command");
export const hasIdentity = () => invoke<boolean>("has_identity");
export const setupPassphrase = (passphrase: string) => invoke<string | null>("setup_passphrase", { passphrase });
export const identityFileExists = () => invoke<boolean>("identity_file_exists");
export const indexStatus = () => invoke<[number, number] | null>("index_status");
/** null = up to date. */
export const checkUpdate = () => invoke<{ version: string } | null>("check_update");
/** Downloads, installs and relaunches; resolves only on failure paths (rejects with the reason). */
export const installUpdate = () => invoke<void>("install_update");
export const appVersion = getVersion;
