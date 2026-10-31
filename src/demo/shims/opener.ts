// Demo shim for @tauri-apps/plugin-opener.
export const openUrl = async (url: string): Promise<void> => void window.open(url, "_blank", "noopener");
export const revealItemInDir = async (_path: string): Promise<void> => {};
