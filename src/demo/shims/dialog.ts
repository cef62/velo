// Demo shim for @tauri-apps/plugin-dialog (src/demo/platform.ts overrides every caller; kept so src/ui/platform.ts loads).
export const ask = async (..._a: unknown[]): Promise<boolean> => true;
export const open = async (..._a: unknown[]): Promise<string | null> => null;
export const save = async (..._a: unknown[]): Promise<string | null> => null;
