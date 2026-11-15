// Demo shim for @tauri-apps/api/event: there is no backend to emit file-watcher, shortcut or updater events, except the
// fixture update of `?update=big|patch` (src/demo/updates.ts), announced once as the background check would.
import { demoUpdate } from "../updates";

export const listen = async <T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> => {
  if (event === "update-available" && demoUpdate) setTimeout(() => handler({ payload: demoUpdate as T }), 500);
  return () => {};
};
export const emitTo = async (_target: string, _event: string, _payload?: unknown): Promise<void> => {};
