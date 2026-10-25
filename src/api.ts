import { invoke } from "@tauri-apps/api/core";

export type Hit = { path: string; title: string; snippet: string; mtime: number; encrypted: boolean };
export type NoteDoc = { path: string; title: string; text: string; hash: string; encrypted: boolean };
export type SaveResult = { kind: "saved"; hash: string } | { kind: "conflict"; conflict_path: string; disk_hash: string };
export type RenameResult = { path: string; rewritten: number };
export type Settings = { notes_dir: string | null; hotkey: string; layout: "vertical" | "horizontal"; font_size: number };

export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) => invoke<void>("set_settings", { settings });
export const search = (query: string) => invoke<Hit[]>("search", { query });
export const openNote = (path: string) => invoke<NoteDoc>("open_note", { path });
export const openOrCreate = (title: string) => invoke<NoteDoc>("open_or_create", { title });
export const saveNote = (path: string, text: string, baseHash: string) => invoke<SaveResult>("save_note", { path, text, baseHash });
export const renameNote = (path: string, newTitle: string, rewriteLinks: boolean) => invoke<RenameResult>("rename_note", { path, newTitle, rewriteLinks });
export const backlinkCount = (title: string) => invoke<number>("backlink_count", { title });
export const lockNote = (path: string) => invoke<string>("lock_note", { path });
export const unlockNote = (path: string) => invoke<string>("unlock_note", { path });
export const lockAll = () => invoke<void>("lock_all");
export const hasIdentity = () => invoke<boolean>("has_identity");
export const setupPassphrase = (passphrase: string) => invoke<void>("setup_passphrase", { passphrase });
