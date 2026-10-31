// Demo shim for @tauri-apps/api/event: there is no backend to emit file-watcher, shortcut or updater events.
export const listen = async <T>(_event: string, _handler: (e: { payload: T }) => void): Promise<() => void> => () => {};
