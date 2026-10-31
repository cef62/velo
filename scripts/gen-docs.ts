// Writes (or with --check, verifies) site/src/content/reference/shortcuts.json from src/shortcuts.ts.
// Run: node scripts/gen-docs.ts [--check]. mcp-tools.json comes from the Rust test `dump_tool_specs`.
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULTS, GLOBAL_ACTIONS, LABELS, NONE, formatBinding, type Action } from "../src/shortcuts.ts";

const GROUPS: Record<string, Action[]> = {
  Navigation: ["focus_search", "back", "forward", "command_palette", "daily_note"],
  Notes: ["rename", "delete_note", "extract_note", "merge_note", "export", "capture"],
  View: ["toggle_preview", "toggle_rich", "toggle_layout", "toggle_info", "toggle_tags", "toggle_front_matter", "toggle_connections", "toggle_sort", "context_menu"],
  "Search & filters": ["save_search"],
  "Tasks & timeline": ["toggle_tasks", "toggle_timeline"],
  Security: ["toggle_lock", "lock_all"],
  App: ["settings", "toggle_window", "quit"],
};

const actions = Object.keys(DEFAULTS) as Action[];
const group = new Map<Action, string>();
for (const [g, list] of Object.entries(GROUPS)) for (const a of list) {
  if (group.has(a)) throw new Error(`action in two groups: ${a}`);
  group.set(a, g);
}
for (const a of actions) if (!group.has(a)) throw new Error(`action without group: ${a} — add it to GROUPS in scripts/gen-docs.ts`);
for (const a of group.keys()) if (!(a in DEFAULTS)) throw new Error(`unknown action in groups: ${a}`);

const rows = Object.entries(GROUPS).flatMap(([g, list]) => list.map((action) => ({
  action,
  label: LABELS[action],
  keys: DEFAULTS[action],
  mac: DEFAULTS[action] === NONE ? null : formatBinding(DEFAULTS[action], true),
  other: DEFAULTS[action] === NONE ? null : formatBinding(DEFAULTS[action], false),
  global: (GLOBAL_ACTIONS as readonly string[]).includes(action),
  group: g,
})));

const out = new URL("../site/src/content/reference/shortcuts.json", import.meta.url);
const text = JSON.stringify(rows, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(out, "utf8"); } catch {}
  if (cur.replace(/\r\n/g, "\n") !== text) { console.error("shortcuts.json is stale: run `pnpm docs:gen`"); process.exit(1); }
} else writeFileSync(out, text);
