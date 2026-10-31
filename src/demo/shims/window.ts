// Demo shim for @tauri-apps/api/window: the browser tab is the window; window ops are no-ops.
export const getCurrentWindow = () => ({
  onCloseRequested: async (_handler: (e: { preventDefault(): void }) => void): Promise<() => void> => () => {},
  setTheme: async (_theme: "light" | "dark" | null): Promise<void> => {},
});
