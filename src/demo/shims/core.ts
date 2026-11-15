// Demo shim for @tauri-apps/api/core: only src/log.ts calls it (`log_line`), and the demo has no velo.log.
export const invoke = async (_cmd: string, _args?: unknown): Promise<void> => {};
// src/whatsnew/api.ts takes install progress over a Channel; the demo swaps that module out, so nothing ever sends here.
export class Channel<T> {
  onmessage: (m: T) => void = () => {};
}
