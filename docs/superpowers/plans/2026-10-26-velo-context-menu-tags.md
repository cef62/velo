# velo context menu + tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native right-click menu on list rows, and a tag browser whose toggled tags filter the list.

**Architecture:** Rust gains tag extraction, a `tags` index table (plain notes only), a tag filter on paged search and a `list_tags` command; an index schema version forces a one-time reindex. TS gains a pure `tags.ts` (selection logic), a tag panel + filter line, `#tag` chips in the preview, and a pure `contextmenu.ts` (menu model) popped with Tauri's native menu API.

**Tech Stack:** unchanged; uses `@tauri-apps/api/menu` and `@tauri-apps/plugin-opener` `revealItemInDir` (both already installed).

**Spec:** `docs/superpowers/specs/2026-10-26-velo-context-menu-tags-design.md`

## Global Constraints
- v1/v1.1 invariants: no user text lost (flush-then-load refusal for every switch; `busy` guard); locked-note plaintext never on disk/SQLite (locked notes contribute NO rows to `tags`); files source of truth; index rebuildable; note commands gated while indexing.
- Search page <50 ms p95 at 10k notes, both sorts, incl. a tag filter.
- Tag rule (exact): starts at line start, after whitespace or `(`; body chars `[\p{L}\p{N}_\-/]`; ≥1 letter; `# ` heading excluded; fenced code blocks ignored; compared by `fold`; display = first spelling.
- Filter = AND of selected tags, combined with query and sort; grouping (title matches first) and paging preserved.
- New remappable action `toggle_tags`, default `Mod+Shift+KeyT`, label "Show / hide tags".
- Context menu = native Tauri menu; acts on the open note after opening the clicked row via the normal path.

## Review Focus
1. Existing v1.1 index without tags → first open reindexes all notes once (progress shown), tags appear; second open is warm. Pinned in Task 1 (`schema_upgrade_reindexes`).
2. A locked note containing `#secret` → `#secret` absent from SQLite files and from `list_tags`; while unlocked, filtering by `#secret` still finds it (in memory). Pinned in Task 1.
3. Text like `C#`, `#1`, `http://x#frag`, `# Heading`, code fences → not tags. Pinned in Task 1 (`extract_tags_rules`).
4. Selected tag disappears (last note deleted/edited) → selection pruned, list unfiltered by it, no stuck empty list. Pinned in Task 2 (`pruneSelection`).
5. Right-click a row while the open note has unsaved edits that can't be saved → no switch, no menu, message shown. Pinned in Task 3 (manual) + `menuFor` returns null when not opened.

---

### Task 1: Tags backend (extraction, index, filter, list_tags)

**Files:** Modify `src-tauri/src/text.rs`, `src-tauri/src/index.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/perf.rs`, `src/api.ts` (+ callers in `src/main.ts` pass `[]` until Task 2).

**Interfaces:**
- `text::extract_tags(body: &str) -> Vec<(String, String)>` — `(folded, display)`, deduped by folded, first spelling kept, in order of appearance.
- Schema: `CREATE TABLE IF NOT EXISTS tags(path TEXT NOT NULL, tag_folded TEXT NOT NULL, tag_display TEXT NOT NULL)`; indexes `tags_tag ON tags(tag_folded)`, `tags_path ON tags(path)`. `upsert` (plain notes only) replaces the path's rows; `remove` deletes them. `Index::open`: if `PRAGMA user_version < 2` → delete all rows from notes, notes_fts, links, tags, then set `user_version = 2` (the vault's reconcile then reindexes everything).
- `#[derive(Serialize, Clone, Debug, PartialEq)] pub struct TagCount { pub tag: String, pub count: usize }`; `Index::tags(&self) -> anyhow::Result<Vec<TagCount>>` — one entry per folded tag, display = `MIN(tag_display)`, count = distinct notes, sorted by folded tag.
- `Index::search_page(&self, query, sort, offset, limit, tags: &[String], unlocked)` — new `tags` param (display or folded strings; fold inside): every SQL group (and the empty-query select) adds `AND EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND t.tag_folded = ?)` per tag; group-2 unlocked notes match only if `extract_tags(plaintext)` contains every tag. Empty `tags` = old behavior.
- `Vault::search(&self, query, sort, offset, tags: &[String])`, `Vault::tags(&self) -> anyhow::Result<Vec<TagCount>>` (SQL tags; unlocked notes' tags NOT merged into counts — plaintext stays out of the tag list, my call).
- Commands: `search(query: String, sort: Sort, offset: usize, tags: Vec<String>) -> Page`; `list_tags() -> Vec<TagCount>` (gated like other commands; registered in lib.rs).
- TS: `api.search(query, sort, offset, tags: string[])`, `type TagCount = { tag: string; count: number }`, `api.listTags()`.

- [ ] **Step 1: Failing tests**
```rust
// text.rs
#[test] fn extract_tags_rules() {
    let b = "#Work and #idea, (#nested/path) C# x#y #1 #2024 http://h.com/#frag\n# Heading\n```\n#incode\n```\n#Café #work";
    let t: Vec<String> = extract_tags(b).into_iter().map(|(_, d)| d).collect();
    assert_eq!(t, vec!["Work", "idea", "nested/path", "Café"]);
    assert_eq!(extract_tags("#Café")[0].0, "cafe");
}
// index.rs
#[test] fn tags_listed_with_counts_and_filter_is_and() {
    let i = idx(&[("a.md", "#work #idea", 1), ("b.md", "#work", 2), ("c.md", "nothing", 3)]);
    assert_eq!(i.tags().unwrap(), vec![TagCount { tag: "idea".into(), count: 1 }, TagCount { tag: "work".into(), count: 2 }]);
    let p = |tags: &[&str]| i.search_page("", Sort::Title, 0, 10, &tags.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &HashMap::new()).unwrap().hits.into_iter().map(|h| h.path).collect::<Vec<_>>();
    assert_eq!(p(&["work"]), vec!["a.md", "b.md"]); assert_eq!(p(&["work", "IDEA"]), vec!["a.md"]); assert_eq!(p(&[]).len(), 3);
}
#[test] fn tag_filter_combines_with_query_groups() { /* title match + body match both tagged #t, an untagged title match excluded; order title-group then body-group */ }
#[test] fn schema_upgrade_reindexes() { /* create db, set user_version=1 with a notes row; Index::open → notes empty, user_version 2; open again → rows kept */ }
// vault.rs
#[test] fn locked_note_tags_stay_out_of_sqlite() {
    /* note body "#zqxjvsecret text", lock it; Vault::tags() lacks it; db/-wal/-shm bytes lack "zqxjvsecret" trigrams-free check (reuse existing helper); after reopen with identity, search("", Sort::Title, 0, &["zqxjvsecret"]) finds the locked note */
}
```
`perf.rs`: add a tag-filter case: seed fixture already has `#work`/`#home`… tags (scripts/seed.mjs appends two `#tag`s per note) — measure `search_page("", Title, 0, 200, ["work"])` and `search_page("garden", Modified, 0, 200, ["work","ideas"])`, assert p95 < 50 ms.
- [ ] **Step 2:** `cd src-tauri && cargo test` → new tests FAIL.
- [ ] **Step 3:** Implement; update all `search_page`/`Vault::search` callers; TS api + main.ts callers pass `[]`.
- [ ] **Step 4:** `cargo test` (warning-free), release perf test, `pnpm test`, `pnpm build` → PASS.
- [ ] **Step 5:** Commit `feat: tags in the index, tag filter on search, list_tags`.

### Task 2: Tag browser UI + preview tag chips

**Files:** Create `src/tags.ts`, `src/tags.test.ts`; Modify `src/main.ts`, `src/preview.ts` (+ test), `src/shortcuts.ts` (+ test), `index.html`, `src/styles.css`, `README.md`.

**Interfaces:**
- `src/tags.ts`: `toggleTag(sel: string[], tag: string): string[]` (fold-insensitive toggle, keeps display of the chip clicked); `pruneSelection(sel: string[], available: TagCount[]): string[]` (drops tags no longer present, fold-insensitive); `filterLabel(sel: string[]): string` → `"Filtered by #a #b"` or `""`.
- `renderMarkdown(text, exists)` gains tag chips: an inline rule turning tags (same rule as Rust; port the predicate to TS in `tags.ts` as `isTagStart/readTag` or a regex) into `<a href="#" class="tag" data-tag="X">#X</a>` (escaped); not inside code spans/fences (markdown-it tokens). `mountPreview` gains `onTag(tag)`; clicks on `.tag` call it (preventDefault, never navigate).
- `shortcuts.ts`: action `toggle_tags`, default `Mod+Shift+KeyT`, label "Show / hide tags".
- `main.ts`: `selectedTags: string[]`; tag panel (`#tagpanel`) with chips `#tag count` (button elements, `aria-pressed`), "Clear"; "#" toggle button next to search; filter line (`#filterline`) shown whenever `selectedTags.length`; every `api.search` call passes `selectedTags`; toggling a tag resets the list (`runSearch(true)`) keeping the open note selected if loaded; `refreshTags()` (listTags → render chips, prune selection, re-search if pruned) on startup, `index-done`, `notes-changed`; preview `onTag` → add tag (if not selected), open panel, re-search.
- README: tags section + shortcut row.

- [ ] **Step 1: Failing tests** (`src/tags.test.ts`, `src/preview.test.ts`, `src/shortcuts.test.ts`):
```ts
test("toggle is fold-insensitive", () => { expect(toggleTag(["Work"], "work")).toEqual([]); expect(toggleTag([], "Idea")).toEqual(["Idea"]); });
test("prune drops vanished tags", () => expect(pruneSelection(["work", "gone"], [{ tag: "Work", count: 2 }])).toEqual(["work"]));
test("filter label", () => { expect(filterLabel([])).toBe(""); expect(filterLabel(["a", "b"])).toBe("Filtered by #a #b"); });
test("preview renders tag chips, not in code or headings", () => {
  const out = renderMarkdown("# Head\n\n#work and `#code` C#\n\n```\n#fence\n```", () => true);
  expect(out).toContain('class="tag" data-tag="work"'); expect(out).not.toContain('data-tag="code"'); expect(out).not.toContain('data-tag="fence"'); expect(out).not.toContain('data-tag="Head"');
});
test("tag chip escapes", () => expect(renderMarkdown('#a"b', () => true)).not.toContain('data-tag="a"b"'));
test("toggle_tags default", () => expect(DEFAULTS.toggle_tags).toBe("Mod+Shift+KeyT"));
```
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** `pnpm test`, `pnpm build` → PASS. Manual (owner): panel toggles with ⌘⇧T and "#"; chips toggle and filter (AND); filter line visible with panel hidden; clicking `#tag` in preview filters; deleting the last tagged note prunes the chip.
- [ ] **Step 5:** Commit `feat: tag browser with toggleable filter; tag chips in preview`.

### Task 3: Native right-click menu on list rows

**Files:** Create `src/contextmenu.ts`, `src/contextmenu.test.ts`; Modify `src/main.ts`, `src/list.ts` (contextmenu event per row → callback with row index), `src-tauri/capabilities/default.json`, `README.md`.

**Interfaces:**
- `src/contextmenu.ts`: `type MenuAction = "open" | "rename" | "toggle_lock" | "copy_link" | "reveal" | "delete_note"`; `menuModel(o: { encrypted: boolean; platform: "mac" | "windows" | "linux"; keys: Record<Action, string>; isMac: boolean }): Array<{ id: MenuAction; text: string; accelerator?: string } | "separator">` — items in spec order; lock label "Lock" / "Unlock" by `encrypted`; reveal label "Show in Finder" / "Show in Explorer" / "Show in folder"; `accelerator` = the binding converted to Tauri accelerator format (`Mod`→`CmdOrCtrl`, `KeyX`→`X`, `Backspace`→`Backspace`, `BracketLeft`→`[` …) for rename/toggle_lock/delete_note, omitted if conversion impossible. `linkFor(title: string): string` → `[[title]]`.
- `list.ts`: `mountList(…, { onContextMenu?(i: number, x: number, y: number) })`, row `contextmenu` event → preventDefault + callback.
- `main.ts`: `openContextMenu(i)`: `await select(i)` through the normal path (explicit); if `editor.currentPath() !== row.path` → stop (refusal message already shown); build `Menu.new({ items })` from `menuModel` (`MenuItem.new({ id, text, accelerator, action })`, `PredefinedMenuItem.new({ item: "Separator" })`), `await menu.popup()`. Actions: open → editor.focus() (leave preview if editor hidden, reuse `settleAfterOpen(false, "enter")`); rename → `startRename()`; toggle_lock → `toggleLock()`; copy_link → `navigator.clipboard.writeText(linkFor(title))` (error → errEl); reveal → `revealItemInDir(path)` (error → errEl); delete_note → `deleteNote()`. Keyboard: `ContextMenu` key or `Shift+F10` in search/list → `openContextMenu(sel)`.
- Capabilities: add `"core:menu:default"` and `{ "identifier": "opener:allow-reveal-item-in-dir", … }` (check plugin permission name/scope syntax; scope to the notes folder if supported, else plain permission).

- [ ] **Step 1: Failing tests** (`src/contextmenu.test.ts`):
```ts
const keys = resolve(undefined, true);
test("model order and labels (mac, plain note)", () => {
  const m = menuModel({ encrypted: false, platform: "mac", keys, isMac: true });
  expect(m.map((x) => (x === "separator" ? "-" : x.id))).toEqual(["open", "rename", "toggle_lock", "copy_link", "reveal", "-", "delete_note"]);
  expect(m.find((x) => x !== "separator" && x.id === "toggle_lock")).toMatchObject({ text: "Lock" });
  expect(m.find((x) => x !== "separator" && x.id === "reveal")).toMatchObject({ text: "Show in Finder" });
  expect(m.find((x) => x !== "separator" && x.id === "delete_note")).toMatchObject({ text: "Move to Trash…", accelerator: "CmdOrCtrl+Backspace" });
});
test("unlock label and platform reveal text", () => {
  const m = menuModel({ encrypted: true, platform: "windows", keys: resolve(undefined, false), isMac: false });
  expect(m.find((x) => x !== "separator" && x.id === "toggle_lock")).toMatchObject({ text: "Unlock" });
  expect(m.find((x) => x !== "separator" && x.id === "reveal")).toMatchObject({ text: "Show in Explorer" });
});
test("link format", () => expect(linkFor("My Note")).toBe("[[My Note]]"));
```
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement and wire; capabilities.
- [ ] **Step 4:** `pnpm test`, `pnpm build`, `cd src-tauri && cargo test`; `pnpm tauri dev` boots. Manual (owner): right-click opens the note then the menu; each item works; refused switch shows no menu; Shift+F10 works.
- [ ] **Step 5:** Commit `feat: native right-click menu on list rows`.

## Verification
- `cargo test`, `pnpm test`, `pnpm build` green; perf p95 < 50 ms incl. tag filters.
- Owner manual checks listed in Tasks 2–3, plus: first launch after upgrade reindexes once with progress, then warm.
