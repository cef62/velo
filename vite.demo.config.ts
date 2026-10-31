// Browser demo build: the real UI over an in-memory backend (src/demo). `pnpm demo:dev` / `pnpm demo:build` → dist-demo/.
// DEMO_BASE sets the public path (e.g. /velo/demo/ for the docs site).
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import process from "node:process";
import appConfig from "./vite.config.ts";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

// Every @tauri-apps module the app imports, mapped to a browser shim; an unmapped one fails the build.
const shims: Record<string, string> = {
  "@tauri-apps/api/event": src("demo/shims/event.ts"),
  "@tauri-apps/api/window": src("demo/shims/window.ts"),
  "@tauri-apps/api/menu": src("demo/shims/menu.ts"),
  "@tauri-apps/api/dpi": src("demo/shims/dpi.ts"),
  "@tauri-apps/plugin-dialog": src("demo/shims/dialog.ts"),
  "@tauri-apps/plugin-opener": src("demo/shims/opener.ts"),
};

// App modules replaced by demo ones, matched on the resolved file so relative imports ("../api") are caught too.
// The demo module itself still gets the real one (src/demo/platform.ts wraps src/ui/platform.ts).
const swaps: Record<string, string> = {
  [src("api.ts")]: src("demo/api.ts"),
  [src("ui/platform.ts")]: src("demo/platform.ts"),
};

const demo: Plugin = {
  name: "velo-demo",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (source.startsWith("@tauri-apps/")) return shims[source] ?? this.error(`no demo shim for ${source} (imported by ${importer})`);
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    const to = r && swaps[r.id];
    return to && importer !== to ? to : r;
  },
  // the app's index.html has no icon (Tauri supplies one): inline the app icon so the browser doesn't 404 on /favicon.ico
  transformIndexHtml: () => [
    { tag: "link", attrs: { rel: "icon", type: "image/png", href: `data:image/png;base64,${readFileSync(new URL("./src-tauri/icons/32x32.png", import.meta.url)).toString("base64")}` }, injectTo: "head" },
  ],
};

export default defineConfig(async (env) =>
  mergeConfig(typeof appConfig === "function" ? await appConfig(env) : (appConfig as UserConfig), {
    base: process.env.DEMO_BASE ?? "/",
    plugins: [demo],
    server: { port: 4788, strictPort: false },
    preview: { port: 4789 },
    build: { outDir: "dist-demo", emptyOutDir: true },
  }),
);
