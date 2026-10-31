// Demo shim for @tauri-apps/api/menu (src/demo/platform.ts renders menus in the page instead).
const stub = { new: async (..._a: unknown[]) => ({ close: async () => {}, popup: async (..._p: unknown[]) => {} }) };
export const Menu = stub;
export const MenuItem = stub;
export const PredefinedMenuItem = stub;
