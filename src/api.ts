import { invoke } from "@tauri-apps/api/core";

export type Hit = { path: string; title: string; snippet: string; mtime: number; encrypted: boolean };
export type NoteMeta = { created: number; created_src: "frontmatter" | "file"; modified: number; modified_src: "frontmatter" | "file"; tags: string[]; aliases: string[] };
export type NoteDoc = { path: string; title: string; text: string; hash: string; encrypted: boolean; meta: NoteMeta };
export type SaveResult = { kind: "saved"; hash: string; front_matter: string | null; meta: NoteMeta } | { kind: "conflict"; conflict_path: string; disk_hash: string };
export type RenameResult = { path: string; rewritten: number };
export type Settings = { notes_dir: string | null; layout: "vertical" | "horizontal"; font_size: number; sort: "modified" | "title"; editor_style: "rich" | "plain"; theme: "system" | "light" | "dark"; header_labels: boolean; shortcuts: Record<string, string>; write_front_matter: boolean; show_front_matter: boolean; info_panel: boolean };

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) => invoke<void>("set_settings", { settings });
export type Page = { hits: Hit[]; has_more: boolean; total: number };
export type TagCount = { tag: string; count: number };
export const search = (query: string, sort: "modified" | "title", offset: number, tags: string[]) => invoke<Page>("search", { query, sort, offset, tags });
export const listTags = () => invoke<TagCount[]>("list_tags");
export const listTitles = () => invoke<string[]>("list_titles");
export const openNote = (path: string) => invoke<NoteDoc>("open_note", { path });
export const openOrCreate = (title: string) => invoke<NoteDoc>("open_or_create", { title });
export const saveNote = (path: string, text: string, baseHash: string) => invoke<SaveResult>("save_note", { path, text, baseHash });
export const renameNote = (path: string, newTitle: string, rewriteLinks: boolean) => invoke<RenameResult>("rename_note", { path, newTitle, rewriteLinks });
export const backlinkCount = (title: string) => invoke<number>("backlink_count", { title });
export const lockNote = (path: string) => invoke<string>("lock_note", { path });
export const unlockNote = (path: string) => invoke<string>("unlock_note", { path });
export const lockAll = () => invoke<void>("lock_all");
export const deleteNote = (path: string) => invoke<void>("delete_note", { path });
export const hasIdentity = () => invoke<boolean>("has_identity");
export const setupPassphrase = (passphrase: string) => invoke<string | null>("setup_passphrase", { passphrase });
export const identityFileExists = () => invoke<boolean>("identity_file_exists");
export const indexStatus = () => invoke<[number, number] | null>("index_status");
