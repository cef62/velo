// Demo shim for @tauri-apps/api/core: only src/log.ts calls it (`log_line`), and the demo has no velo.log.
export const invoke = async (_cmd: string, _args?: unknown): Promise<void> => {};
