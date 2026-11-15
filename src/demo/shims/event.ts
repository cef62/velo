// Demo shim for @tauri-apps/api/event: there is no backend to emit file-watcher, shortcut or updater events, except the
// fixture update of `?update=big|patch` (src/demo/updates.ts), announced once as the background check would, and the
// What's new tab's install request, relayed between the tabs as Rust would (`relay`).
import { demoUpdate, relay } from "../updates";

export const listen = async <T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void> => {
  if (event === "update-available" && demoUpdate) setTimeout(() => handler({ payload: demoUpdate as T }), 500);
  if (event === "whatsnew-install") {
    const ch = relay();
    ch.onmessage = (m) => m.data?.install && handler({ payload: m.data.install as T });
    return () => ch.close();
  }
  return () => {};
};
