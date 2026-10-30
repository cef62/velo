# Saved searches, timeline, export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named saved searches in the tag panel, a timeline pane of the notes the current filters match, and export of that set to one Markdown file or PDF.

**Architecture:** A saved search is the existing filter triple (search text, tags, No links) stored in `settings.json`; applying it sets the filters, so the list, Tasks, timeline and export follow with no extra wiring. The timeline is a fourth `paneMode` fed by one new Rust query. Export text is built once in Rust (`src-tauri/src/export.rs`): written to a file for Markdown, or returned to the frontend, rendered with the preview renderer into a print-only container and printed with Tauri's `Webview::print()` for PDF.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19, Park UI / Panda CSS, `@tauri-apps/plugin-dialog` (`save`), markdown-it (existing).

**Spec:** `docs/superpowers/specs/2026-10-30-velo-saved-searches-design.md`

## Global Constraints

- No new dependencies (npm or cargo).
- Locked notes (`*.md.age`), locked or unlocked, are never written into an export; they are counted as left out.
- Export limit: at most 1,000 notes, newest first; the rest counted as left out.
- Saved-search names: trimmed, 1–60 characters.
- New actions: `toggle_timeline` default `Mod+Shift+KeyL`; `export` and `save_search` default `NONE`.
- Settings keys: `saved_searches: [{ name, query, tags, no_links }]`, `timeline_sort: "updated" | "created"` (default `"updated"`).
- Timeline range values: `7` / `30` days / all; default all. Not saved.
- Panda recipe variants passed as variables need `staticCss` (see `src/theme/recipes/velo/tag-chip.ts`).
- Keyboard-only use works for every new control; screen-reader labels don't repeat words; one Tab stop per list with ↑/↓ inside (pattern: `src/ui/TaskList.tsx` and the tag panel's roving chips in `src/ui/TagPanel.tsx`).
- Never run the app; tests use temp dirs only. Quality gate per task: `npx tsc --noEmit -p .`, `pnpm vitest run`, `cd src-tauri && cargo test -q`; `pnpm build:app` in the last task.
- Commit trailer, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012ZCdCJ2kjQqkm5WZRUsCxE
  ```

## Review Focus

1. An unlocked locked note matching the filters: its plaintext must appear nowhere in the export text (Task 5 test `export_never_includes_locked_notes`).
2. Saving under a name that exists replaces it only after confirmation; a name of only spaces or over 60 chars is refused (Task 2 tests).
3. Day grouping at local midnight and range boundaries: a note modified at 00:05 today is under "Today", one at 23:55 yesterday under "Yesterday"; the 7-day range includes exactly the last 7×24 h (Task 4 tests on `groupByDay` / `sinceMs`).
4. Filters changed while a timeline load is in flight: the older reply must not replace the newer one (Task 4 controller test, `latest()` pattern).
5. Export with nothing to export (no matches, or all locked): the dialog says so and Export is disabled; no empty file is written (Task 6 test).

---

### Task 1: Settings and actions

**Files:**
- Modify: `src-tauri/src/settings.rs` (struct, `Default`, load sanitising, `ACTIONS`)
- Modify: `src/api.ts` (`Settings` type), `src/shortcuts.ts` (`Action`, `DEFAULTS`, `LABELS`)
- Test: `src-tauri/src/settings.rs` tests, `src/shortcuts.test.ts`

**Interfaces:**
- Produces (Rust): `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] pub struct SavedSearch { pub name: String, pub query: String, pub tags: Vec<String>, pub no_links: bool }`; `Settings.saved_searches: Vec<SavedSearch>`, `Settings.timeline_sort: String`.
- Produces (TS): `type SavedSearch = { name: string; query: string; tags: string[]; no_links: boolean }`; `Settings.saved_searches: SavedSearch[]`, `Settings.timeline_sort: "updated" | "created"`; actions `"toggle_timeline" | "export" | "save_search"` with labels "Toggle timeline", "Export…", "Save search…".

- [ ] **Step 1: Failing tests.** Rust `saved_searches_load_and_sanitise`: a settings.json with `saved_searches: [{"name":" a ","query":"x","tags":["p"],"no_links":false}, {"name":"","query":"y"}, {"name":"<61 chars>"}, 42]` and `timeline_sort: "weird"` loads as exactly one entry `{name:"a",query:"x",tags:["p"],no_links:false}` and `timeline_sort == "updated"`; round-trips through `save`. Default settings have `saved_searches == []`, `timeline_sort == "updated"`. TS: `DEFAULTS.toggle_timeline === "Mod+Shift+KeyL"`, `DEFAULTS.export === NONE`, `DEFAULTS.save_search === NONE`, and the existing "no two defaults share a binding" test still passes. Rust `ACTIONS` length becomes 25 and the existing ACTIONS↔DEFAULTS parity test passes.
- [ ] **Step 2: Run, see them fail.** `cd src-tauri && cargo test -q settings` / `pnpm vitest run src/shortcuts.test.ts`.
- [ ] **Step 3: Implement.** Sanitising lives in `settings::load` next to the existing shortcut clean-up: drop entries that don't deserialize, trim names, drop empty or >60-char names, keep the first of duplicate names (case-insensitive, `fold`).
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(saved): settings and actions for saved searches and timeline`.

### Task 2: Saved searches (frontend)

**Files:**
- Create: `src/saved.ts`, `src/saved.test.ts`, `src/ui/SaveSearchDialog.tsx`
- Modify: `src/app/store.ts`, `src/app/controller.ts`, `src/ui/TagPanel.tsx`, `src/ui/FilterLine.tsx`, `src/ui/App.tsx`, `src/app/fakes.ts`, `src/app/controller.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces (`src/saved.ts`): `type Filters = { query: string; tags: string[]; noLinks: boolean }`; `sameFilters(s: SavedSearch, f: Filters): boolean` (query trimmed-equal, tags equal as folded sets, no_links equal); `cleanName(raw: string): string | null` (trimmed, null if empty or >60); `defaultName(f: Filters): string` (trimmed query, else `#firstTag`, else "No links"); `upsert(list, s): SavedSearch[]` (replace same folded name in place, else append); `renameIn(list, from, to): SavedSearch[]`; `removeFrom(list, name): SavedSearch[]`.
- Produces (store): `savedSearches: SavedSearch[]`; `saveSearch: { name: string; err: string; confirmReplace: boolean } | null`.
- Produces (controller): `startSaveSearch()`, `commitSaveSearch(name: string | null)`, `applySaved(name: string)`, `savedMenu(name: string, atChip: boolean)`, `renameSaved(from: string, to: string)`, `deleteSaved(name: string)`; action `save_search` → `startSaveSearch`.

- [ ] **Step 1: Failing tests.** `saved.test.ts`: `sameFilters` true for `{query:" velo ",tags:["Proj"],no_links:false}` vs `{query:"velo",tags:["proj"],noLinks:false}`, false when a tag differs; `cleanName("   ")===null`, `cleanName("x".repeat(61))===null`, `cleanName(" a ")==="a"`; `defaultName({query:"",tags:["proj"],noLinks:false})==="#proj"`; `upsert` replaces "Velo" when saving "velo" and keeps position. `controller.test.ts`: (a) `startSaveSearch` with no filters does nothing; (b) save "w" then `applySaved("w")` after `clearFilters()` restores query, tags, noLinks and persists via `setSettings` with `saved_searches`; (c) saving an existing name first sets `confirmReplace: true` and does not write; a second `commitSaveSearch` with the same name writes; (d) `commitSaveSearch("   ")` sets `err` and writes nothing; (e) `applySaved` on the currently-equal search clears the filters.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Persist through the existing `updateSettings` queue (as `toggleInfo` does). `applySaved` sets query, `selectedTags`, `noLinks` then calls the same refresh `filterChanged(false)` path the filters use. Chips: a "Saved" row above the tag chips in `TagPanel.tsx`, part of the panel's roving tab stop, `aria-pressed` when `sameFilters`; `tagChip({ selected })` (staticCss already present). Context menu: `MenuSpec` items "Rename…" / "Delete" through `ui.popupMenu`, opened by right-click and Shift+F10/Menu key (`isMenuKey`). Rename reuses `SaveSearchDialog` with a `renaming` field in `saveSearch` state; Delete asks `ui.confirm`-style (use the existing `ask` port the app uses for deletes). "Save search…" buttons: FilterLine (when filters set) and TagPanel header, disabled with no filter/text.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(saved): save, apply, rename and delete saved searches`.

### Task 3: Timeline query (Rust)

**Files:**
- Modify: `src-tauri/src/index.rs` (dates map), `src-tauri/src/vault.rs` (`timeline`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (register), `src/api.ts`

**Interfaces:**
- Produces (Rust): `#[derive(Serialize)] pub struct TimelineRow { pub path: String, pub title: String, pub date: i64, pub snippet: String, pub locked: bool }`; `#[derive(Deserialize, Clone, Copy)] #[serde(rename_all="lowercase")] pub enum TimelineBy { Created, Updated }`; `Vault::timeline(&self, query: &str, tags: &[String], no_links: bool, by: TimelineBy, since_ms: Option<i64>) -> anyhow::Result<Vec<TimelineRow>>`; `Index::dates(&self) -> anyhow::Result<HashMap<String, (i64, i64)>>` (path → created, modified); command `timeline(query, tags, no_links, by, since_ms)`.
- Produces (TS): `type TimelineRow = {...same}`; `api.timeline(query: string, tags: string[], noLinks: boolean, by: "created"|"updated", sinceMs: number | null): Promise<TimelineRow[]>`.

- [ ] **Step 1: Failing tests** in `vault.rs`: `timeline_orders_and_filters` — three notes with created/modified set via front matter (`created:`/`modified:`), query matching two of them: `by Updated` returns them newest-modified first with `date == modified`; `by Created` orders by created; `since_ms` drops the older one; a locked note matching by title appears with `locked: true` and `snippet == ""`; tag filter and `no_links` narrow as `search_where` does.
- [ ] **Step 2: Run, see it fail.**
- [ ] **Step 3: Implement.** Matches = `index.search_page_where(query, Sort::Modified, 0, usize::MAX >> 1, tags, &self.unlocked, no_links)` (all rows); dates from one `SELECT path, created, modified FROM notes` into the map; filter by `since_ms`, sort by date desc then path. Snippet = `Hit.snippet` (already empty or safe for locked notes — assert, don't assume).
- [ ] **Step 4: Run, see it pass.**
- [ ] **Step 5: Commit** `feat(timeline): timeline query`.

### Task 4: Timeline pane

**Files:**
- Create: `src/timeline.ts`, `src/timeline.test.ts`, `src/ui/TimelineView.tsx`
- Modify: `src/app/store.ts`, `src/app/controller.ts`, `src/ui/App.tsx`, `src/ui/Header.tsx`, `src/app/fakes.ts`, `src/app/controller.test.ts`

**Interfaces:**
- Consumes: Task 3 `api.timeline`, Task 1 `timeline_sort`.
- Produces (`src/timeline.ts`): `type DayGroup = { key: string; label: string; rows: TimelineRow[] }`; `groupByDay(rows: TimelineRow[], now: Date, locale?: string): DayGroup[]` (local days; labels "Today", "Yesterday", within the last 7 days `weekday day month` e.g. "Monday 26 Oct", older `day month year` e.g. "12 Oct 2026", via `Intl.DateTimeFormat`); `sinceMs(range: "7" | "30" | "all", now: Date): number | null` (`now - days*86_400_000`, null for all).
- Produces (store): `paneMode` gains `"timeline"`; `timeline: { rows: TimelineRow[] | null; by: "created" | "updated"; range: "7" | "30" | "all"; err: string }`.
- Produces (controller): `loadTimeline()`, `setTimelineBy(by)`, `setTimelineRange(range)`; `setPaneMode("timeline")`; action `toggle_timeline`.

- [ ] **Step 1: Failing tests.** `timeline.test.ts` with `now = new Date(2026, 9, 30, 12, 0)` (local): rows at 2026-10-30 00:05 → "Today", 2026-10-29 23:55 → "Yesterday", 2026-10-26 10:00 → label starting with the weekday ("Monday" in `en-GB`), 2026-10-12 → "12 Oct 2026"; groups keep row order; `sinceMs("7", now) === now.getTime() - 7*86_400_000`, `sinceMs("all", now) === null`. `controller.test.ts`: (a) `setPaneMode("timeline")` calls `api.timeline` with the current query/tags/noLinks, `by` from settings, `sinceMs` null; (b) changing a filter in timeline mode reloads it (as Tasks does in `filterChanged`); (c) two loads where the first resolves last: the store keeps the second's rows; (d) `setTimelineBy("created")` persists `timeline_sort` and reloads; (e) a note saved/renamed/deleted while in timeline mode reloads it (hook into the same places that refresh Tasks).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Header: add `{ value: "timeline", text: "Timeline", glyph: <CalendarDays/>, action: "toggle_timeline" }` to the pane segment. `TimelineView`: header with two segment groups (Created/Updated, 7 days/30 days/All) and an "Export…" button (wired in Task 6; render it disabled until then), then day headers and rows (title, local time `HH:mm`, snippet line), windowed like `NoteList` (only visible rows mounted; the active row always mounted), one Tab stop, ↑/↓, Enter/click opens via `openFromGraph`-style open that keeps the pane. Empty: "No notes match" plus the active filters. Use `latest()` for stale replies.
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(timeline): timeline pane`.

### Task 5: Export builder (Rust)

**Files:**
- Create: `src-tauri/src/export.rs`
- Modify: `src-tauri/src/lib.rs` (mod + commands), `src-tauri/src/commands.rs`, `src/api.ts`

**Interfaces:**
- Consumes: Task 3 `Vault::timeline`, `tasks::parse_tasks`, `frontmatter::body`.
- Produces (Rust): `#[derive(Deserialize)] pub struct ExportRequest { pub query: String, pub tags: Vec<String>, pub no_links: bool, pub by: TimelineBy, pub since_ms: Option<i64>, pub tasks_only: bool, pub title: String }`; `#[derive(Serialize, Default, Debug, PartialEq)] pub struct ExportCounts { pub notes: usize, pub open: usize, pub done: usize, pub locked: usize, pub over_limit: usize, pub no_tasks: usize, pub unreadable: usize }`; `pub fn build(v: &Vault, r: &ExportRequest, today: &str) -> anyhow::Result<(String, ExportCounts)>`; `pub const LIMIT: usize = 1000`; commands `export_preview(request) -> ExportCounts`, `export_text(request) -> String`, `export_markdown(path: String, request) -> ExportCounts` (writes with `Store`-style atomic write to exactly `path`).
- Produces (TS): `type ExportRequest`, `type ExportCounts`; `api.exportPreview(r)`, `api.exportText(r)`, `api.exportMarkdown(path, r)`.

Output shape (exact headings):
```
# <title>
<range line: "Last 7 days" | "Last 30 days" | "All dates"> · exported <YYYY-MM-DD>

## Status
<open> open · <done> done

### Open
- [ ] <task text> — <note title>
### Done
- [x] <task text> — <note title> @done(<date>)        (only tasks whose done date falls in the range; all when range is all)

## <note title>
Created <YYYY-MM-DD> · Updated <YYYY-MM-DD>

<body without front matter>      (tasks_only: only that note's task lines)

…one section per note, in timeline order…

---
<n> locked notes left out · <m> over the 1,000 limit · <k> without tasks · <u> unreadable      (only the non-zero parts; line omitted when all zero)
```

- [ ] **Step 1: Failing tests** in `export.rs`: `export_full_has_summary_and_sections` (two notes, one with `- [ ] a` and `- [x] b @done(2026-10-29)`: exact Status counts, Open/Done lines with note titles, sections in timeline order, front matter gone); `export_tasks_only_keeps_headings_and_tasks` (a note without tasks is left out and counted in `no_tasks`); `export_never_includes_locked_notes` (a locked note whose title and unlocked body contain "SECRET-XYZ" matches the query: the text contains no "SECRET-XYZ", `counts.locked == 1`); `export_limit_counts_the_rest` (call an internal `build_from(rows, …)` with 1,001 rows so the test stays fast: 1,000 sections, `over_limit == 1`); `export_markdown_writes_only_the_given_path` (temp dir; file exists with the text; no other files created).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Read bodies from disk for plain notes only (never `unlocked`). A note that fails to read is skipped and counted in `unreadable` (never silently dropped). Dates formatted in local time (`chrono::Local`).
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(export): Markdown export builder`.

### Task 6: Export dialog and Markdown save

**Files:**
- Create: `src/ui/ExportDialog.tsx`
- Modify: `src/ui/platform.ts` (`saveFile` via `@tauri-apps/plugin-dialog` `save`), `src/app/ports.ts` (`saveFile(defaultName: string): Promise<string | null>`), `src/app/fakes.ts`, `src/app/store.ts`, `src/app/controller.ts`, `src/ui/TimelineView.tsx` (enable Export…), `src/ui/App.tsx`, `src-tauri/capabilities/*.json` (`dialog:allow-save` if `dialog:default` lacks it), `src/app/controller.test.ts`

**Interfaces:**
- Consumes: Task 5 API; Task 2 `sameFilters` (title = matching saved search name, else query + `#tags`, else "All notes").
- Produces (store): `exporting: { counts: ExportCounts | null; format: "md" | "pdf"; tasksOnly: boolean; err: string; pending: boolean } | null`.
- Produces (controller): `startExport()` (switches to timeline first if needed, loads `exportPreview`), `setExportOptions(p)`, `commitExport(go: boolean)`; action `export`.

- [ ] **Step 1: Failing tests** (`controller.test.ts`): (a) `startExport` from notes mode switches `paneMode` to timeline and fetches the preview with the timeline's by/range; (b) Markdown: `commitExport(true)` asks `ui.saveFile("<title> <YYYY-MM-DD>.md")`, then calls `api.exportMarkdown(path, req)`; cancelling the save dialog writes nothing and keeps the dialog open; (c) counts with `notes === 0` → `commitExport(true)` does nothing (Export disabled in UI); (d) title is the saved search's name when filters equal one; (e) toggling Tasks only re-fetches the preview.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** the dialog (Park UI `Dialog`, like `ExtractDialog`): segmented Markdown/PDF, segmented Full notes/Tasks only, the counts line from the spec ("23 notes · 41 open tasks · 12 done · 2 locked notes left out", only non-zero left-out parts), Export / Cancel. PDF is wired in Task 7 (until then the PDF option is disabled).
- [ ] **Step 4: Run, see them pass.**
- [ ] **Step 5: Commit** `feat(export): export dialog and Markdown save`.

### Task 7: PDF export

**Files:**
- Create: `src/ui/PrintHost.tsx`
- Modify: `src-tauri/src/commands.rs` (`print_page`), `src-tauri/src/lib.rs`, `src/api.ts`, `src/app/controller.ts`, `src/app/store.ts`, `src/ui/App.tsx`, `src/theme` global CSS (`@media print`), `src/app/controller.test.ts`

**Interfaces:**
- Consumes: Task 5 `api.exportText`, `renderMarkdown` from `src/preview.ts`.
- Produces: command `print_page(webview: tauri::Webview) -> Result<(), String>` calling `webview.print()`; `api.printPage()`; store `printHtml: string | null`.

- [ ] **Step 1: Failing test** (`controller.test.ts`): PDF `commitExport(true)` fetches `exportText`, sets `printHtml` to `renderMarkdown(text, …)` output, then calls `api.printPage()` once, then clears `printHtml` and closes the dialog; a `printPage` rejection shows the error in the dialog and clears `printHtml`.
- [ ] **Step 2: Run, see it fail.**
- [ ] **Step 3: Implement.** `PrintHost` renders `printHtml` into `<div data-print>` (hidden on screen). Print CSS: `@media print { body > * { display: none } [data-print] { display: block } }` scoped so only the export prints; force light colours inside `[data-print]` regardless of theme; `break-inside: avoid` on list items. Wait one animation frame after setting `printHtml` before `printPage()` so the DOM is painted.
- [ ] **Step 4: Run, see it pass.** Also `pnpm build:app` passes (CSS).
- [ ] **Step 5: Commit** `feat(export): PDF via the native print dialog`.

### Task 8: Docs

**Files:**
- Modify: `README.md`
- Create: `.changeset/saved-searches.md`

- [ ] **Step 1:** README: sections "Saved searches", "Timeline", "Export" (what each does, keyboard paths, locked notes never exported, 1,000-note limit), shortcut-table rows for Toggle timeline (⌘⇧L), Export…, Save search… (no default).
- [ ] **Step 2:** Changeset `"velo": minor` — one paragraph naming the three features.
- [ ] **Step 3:** Full gate incl. `pnpm build:app`.
- [ ] **Step 4: Commit** `docs: saved searches, timeline and export`.
