# Writing helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** velo helps you write, clean up and connect notes from the editor: a read-only tag bar, `[[` and `#` autocomplete, Move to new note (extract) and Merge notes. Agents get merging through the MCP tool `merge_notes`.

**Architecture:**
- **Backend:** three new `Vault` methods, each the only implementation of its feature:
  - `link_targets()`: titles and aliases from the index.
  - `create_from_selection(title, text, write_fm)`: a new note, refusing an existing title.
  - `merge_notes(source, target, write_fm)`: snapshot, write the merged target, rewrite links, trash the source.
  - Tauri commands and the MCP tool call these methods. The tool goes through `NoteOps::merge`, so headless and app mode run the same code.
- **Shared code:** rename's link-rewrite loop moves into a private `Vault::rewrite_backlinks`, used by `rename_note` and `merge_notes`. `frontmatter::set_tags` is generalized so aliases can be added the same way.
- **Frontend:**
  - One pure fuzzy ranker, `src/fuzzy.ts`, serves `[[` links, `#` tags and the merge picker.
  - A CodeMirror extension, `src/complete.ts` (built on `@codemirror/autocomplete`), reads its candidates from the controller's caches, through callbacks in `EditorOpts`.
  - The extract and merge dialogs are store-driven, like `SettingsDialog`. The controller owns their flows, so controller tests cover them.
- **Schema:** unchanged.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19 + Park UI + Panda CSS 1.12.1, CodeMirror 6 (+ `@codemirror/autocomplete`), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-29-velo-writing-helpers-design.md`

## Global Constraints

- **Setup:** the worktree has no `node_modules`. Run `pnpm install` once before the first gate.
- **Dependencies:** exactly one new one: `pnpm add @codemirror/autocomplete@^6.20.4`. It is already in `pnpm-lock.yaml` through `@codemirror/lang-markdown`, and it peers on `@codemirror/view ^6.17` / `state ^6`, which the installed versions satisfy. Nothing new in `Cargo.toml`.
- **Schema:** unchanged (`SCHEMA_VERSION` stays). No new settings.
- **Shortcuts:**
  - `extract_note` = `Mod+Shift+KeyN`, label "Move to new note".
  - `merge_note` = `NONE` (the existing `"none"` constant in `src/shortcuts.ts`), label "Merge into…".
  - Both go in the Rust `settings::ACTIONS` list too.
- **Popup:** opens only after `[[`, or a `#` in tag position. Esc always closes it. At most 20 rows. Ranking takes < 50 ms on 10k targets.
- **Fuzzy order** (folded with `fold` from `src/search.ts`): exact, prefix, word-start, substring, in-order letters. Ties go to most recently modified (links) or the higher note count (tags). Aliases and titles get no preference.
- **Locked notes:**
  - Extract is refused in an encrypted note, locked or unlocked.
  - Merge refuses an encrypted note or a plain twin on either side: `Err("locked")`.
  - MCP `merge_notes` treats a locked note as `not found`, through `plain()` / `path_of`.
- **Safety order:**
  - Extract writes the new note before it changes the source.
  - Merge: a failure before the target is written changes nothing. After that, it reports what was not done and never rolls back.
- **Tests:** temp dirs only (`tempfile`, the existing `vault(…)` helpers, `fakeApi`). Never real velo data, and never `~/Library/Application Support/dev.velo.app`.
- **Quality gate**, at the end of every task (CONTRIBUTING #1): `pnpm exec tsc --noEmit && pnpm test && (cd src-tauri && cargo test)`. Also run `pnpm build` when frontend files changed. The last task runs the full gate, `pnpm build:app` included.
- **Git:** branch `feat/writing-helpers` in this worktree. No bare `git stash`: use a WIP commit. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012ZCdCJ2kjQqkm5WZRUsCxE
  ```
- **Accessibility:** popup, dialogs and tag bar work keyboard-only. Labels never repeat words: the tag bar group is "Note tags", because the info panel already has "Tags".
- **Changeset:** one, `.changeset/writing-helpers.md`, `"velo": minor`.
- **README:** a section per helper, both actions in the shortcut table, and `merge_notes` in the MCP list ("Tools (17)").

## Review Focus

1. **Esc with the popup open closes the popup.** It must not jump to the search field: the editor's own `Escape` binding (`onEscape` → `focusSearch`) must yield while a completion is active. The Task 3 code step and its manual check cover it.
2. **Extract after the text moved.** The user types between opening the dialog and pressing OK. velo then never replaces the wrong range: the new note exists, the source text stays, and an error says so. Test in Task 5.
3. **Merge stopped partway.** If trashing the source fails, the merged target and the rewritten links stay, the source still exists, and the UI and the MCP reply name what was not done. If the target write fails, both files keep their bytes. Test in Task 6.
4. **Merge with the source or target open.** The source open and dirty, with a flush that fails, refuses the merge with nothing changed. The source open and clean ends with the target open. The target open reloads with the merged text. Test in Task 7, plus the app-mode MCP path in Task 8.
5. **Autocomplete in the wrong place.** No popup in fenced or inline code, front matter, URLs, `# Heading`, `##`, `[[x#`, or after `|` in a link. Test in Tasks 3 and 4.

---

### Task 1: Tag bar

**Files:**
- Create: `src/ui/TagBar.tsx`
- Modify: `src/ui/App.tsx` (render it after `<PreviewStrip />`, before `<EditorHost />`), `src/tags.ts`, `src/tags.test.ts`

**Interfaces — Produces:**
- `tagBarItems(tags: string[], selected: string[]): { tag: string; selected: boolean }[]` in `src/tags.ts`. It keeps the order of `tags` and folds the `selected` comparison.
- `TagBar({ controller, store })`:
  - It reads `openPath`, `info.tags` and `selectedTags`, and renders `null` when `!openPath || info.tags.length === 0`. A locked note is never open, so it shows no row.
  - Otherwise: `<div role="group" aria-label="Note tags">` with one `<button aria-pressed>` per item, styled with the `tagChip` recipe as in `InfoPanel`.
  - `onClick` calls `controller.toggleTagFilter(tag)`.
- The row is a `flex: none` sibling above the editor's scroller, so it stays visible while the text scrolls. It also shows over the preview (planner's call: it sits under the title, and the preview replaces only the text).

- [ ] **Step 1: Write the failing test** (`src/tags.test.ts`):
  - `tagBarItems marks selected tags case- and accent-insensitively`: `tagBarItems(["Proj", "café"], ["proj", "CAFE"])` → both `selected: true`, order kept.
  - `tagBarItems with no tags is empty`: `tagBarItems([], ["x"])` → `[]`.
- [ ] **Step 2: Run** `pnpm test src/tags.test.ts`. Expected: FAIL (`tagBarItems` not exported).
- [ ] **Step 3: Implement** `tagBarItems` and `TagBar.tsx`. Use Panda tokens only: `px` matching the title bar, `py: 1`, `gap: 1.5`, `flexWrap: wrap`.
- [ ] **Step 4: Quality gate** + `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(writing): tag bar under the note title`.

### Task 2: Link targets and note creation (backend)

**Files:**
- Modify: `src-tauri/src/index.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (handlers), `src-tauri/src/names.rs`, `src/api.ts`, `src/app/fakes.ts`

**Interfaces — Produces:**
- `#[derive(Serialize)] pub struct LinkTarget { pub name: String, pub title: String, pub path: String, pub modified: i64, pub locked: bool }` in `index.rs`.
  - Rows with `name == title` are titles; the others are aliases.
  - `path` and `locked` go beyond the spec's `{ name, title, modified }` (planner's call). The merge picker needs them to skip the source and locked notes.
- `Index::link_targets(&self) -> anyhow::Result<Vec<LinkTarget>>`: one query, `SELECT title, title, path, modified, encrypted FROM notes UNION ALL SELECT a.alias_display, n.title, n.path, n.modified, n.encrypted FROM aliases a JOIN notes n ON n.path = a.path`.
  - Locked notes come with their file-name title. They have no aliases in SQLite.
  - An unlocked note's aliases live in memory only, so they are not offered (planner's call).
- `Vault::link_targets(&self) -> anyhow::Result<Vec<LinkTarget>>`, plus the Tauri command `list_link_targets() -> Vec<LinkTarget>`.
- `names::title_ok(title: &str) -> bool`: true when `!title.trim().is_empty() && title_to_stem(title) == title.trim()`.
  - Planner's call: New note silently replaces characters, so there is no error to copy (the spec asks to reuse New note's error). A title whose file name would differ is refused, because the `[[link]]` would then not resolve.
- `Vault::create_from_selection(&mut self, title: &str, text: &str, write_fm: bool) -> anyhow::Result<String>`, returning the new path.
  - `!title_ok` → `Err("invalid-title")`.
  - `find_note(title)` is `Some`, or `note_path(dir, title, false|true)` exists → `Err("already-exists")`. These are the same checks as `VaultOps::create`.
  - Content: `frontmatter::stamp(text, now, now)` when `write_fm`, else `text`. It is written with `store.write_atomic`, then `reindex(&p, Some(&content))`.
  - The new note's title is `title.trim()`.
- Tauri command `create_from_selection(title, text) -> String`. `write_fm` comes from settings, as in `open_or_create`.
- TS:
  - `type LinkTarget = { name: string; title: string; path: string; modified: number; locked: boolean }`;
  - `listLinkTargets()`;
  - `createFromSelection(title, text): Promise<string>`, which rejects with `"already-exists" | "invalid-title"`.
  - `fakeApi` gets `listLinkTargets` (one title row per note, `modified: 0`) and `createFromSelection` (adds to `notes`, and throws `"already-exists"` on a present title).

- [ ] **Step 1: Write failing tests:**
  - `index.rs`, `link_targets_lists_titles_and_aliases`: `Nick.md` has `aliases: [Nicholas]`, and `L.md.age` exists. Expect rows `("Nick", "Nick")`, `("Nicholas", "Nick")` and `("L", "L", locked: true)`, each with the note's `modified`.
  - `names.rs`, `title_ok_rules`: `"Plan"` and `" Plan "` → true. `"a/b"`, `".x"`, `"   "` and `"a:b"` → false.
  - `vault.rs`:
    - `create_from_selection_writes_text_and_indexes`: with `write_fm = false`, the file holds exactly the text, and `find_note("New")` finds it.
    - `create_from_selection_stamps_front_matter`: with `write_fm = true`, `frontmatter::parse` sees `created`, and the body equals the text.
    - `create_from_selection_refuses_existing_title_alias_and_locked`: `Nick` (title), `nicholas` (alias) and `L` (only `L.md.age` exists) each give `already-exists`, and no file changes.
    - `create_from_selection_refuses_invalid_title`: `"a/b"` → `invalid-title`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test link_targets create_from_selection title_ok`. Expected: FAIL.
- [ ] **Step 3: Implement.** Register both commands in `lib.rs`.
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(writing): list_link_targets and create_from_selection`.

### Task 3: Fuzzy ranker and `[[` autocomplete

**Files:**
- Create: `src/fuzzy.ts`, `src/fuzzy.test.ts`, `src/complete.ts`, `src/complete.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `src/editor.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/app/fakes.ts`, `src/editortheme.ts` (popup theme)

**Interfaces:**
- Consumes: `LinkTarget`, `listLinkTargets` and `createFromSelection` (Task 2).
- Produces:
  - `src/fuzzy.ts`:
    - `tier(q: string, f: string): number`. Both arguments are already folded. Returns 5 exact, 4 prefix, 3 word-start (`f.startsWith(q, i)` where `f[i-1]` is not a letter or digit), 2 substring, 1 in-order letters, 0 no match. An empty `q` gives 4.
    - `type Ranked<T> = { item: T; f: string }`.
    - `prepare<T>(items: T[], key: (t: T) => string): Ranked<T>[]`: folds once, when the cache loads (planner's call, for the 50 ms budget).
    - `rank<T>(q: string, items: Ranked<T>[], tie: (a: T, b: T) => number, limit = 20): T[]`: drops tier 0, sorts by tier descending, then by `tie`.
  - `src/complete.ts`:
    - `linkContext(state: EditorState, pos: number): { from: number; query: string } | null`.
      - `from` is just after the last `[[` on the line before `pos`. There must be no `]]` and no `|` between it and `pos`.
      - It returns null inside front matter (`docFrontMatter`) and when `syntaxTree(state).resolveInner(pos, -1)` or an ancestor is `FencedCode`, `CodeBlock` or `InlineCode`.
    - `interface CompleteSource { links(): Ranked<LinkTarget>[]; tags(): Ranked<TagCount>[]; onCreate(title: string): void }`.
    - `writingCompletions(src: CompleteSource): Extension`: `autocompletion({ override: [linkSource(src), tagSource(src)], icons: false, maxRenderedOptions: 20 })`. Task 4 adds `tagSource`; until then the override holds `linkSource` only.
    - `linkSource` gives `{ from, options, filter: false }`, with options from `rank(fold(query), src.links(), byModifiedDesc)`.
      - A title row: `label: name`.
      - An alias row: `label: name`, `detail: "→ " + title`.
      - When no row's `f === fold(query.trim())` and `query.trim()` is non-empty, a last row `label: 'Create "' + query.trim() + '"'`.
      - With an empty query, the 20 most recently modified targets show (planner's call).
    - `apply` replaces `[from, pos)` with `name + "]]"`. If `]]` already follows the caret, it is consumed (planner's call). The caret goes after `]]`. The Create row writes the trimmed query, then calls `src.onCreate(title)`.
  - `EditorOpts.complete?: CompleteSource`. `mountEditor` adds `writingCompletions(opts.complete)` when given.
  - The `Escape` binding in `mountEditor` returns `false` when `completionStatus(view.state) !== null`, so the popup's own Escape closes it (Review Focus 1).
  - `EditorOpts.onFocus?: () => void`, through `EditorView.domEventHandlers({ focus })`.
  - Controller:
    - `protected linkIndex: Ranked<LinkTarget>[] = []`.
    - `async loadLinkTargets()`: `prepare(await api.listLinkTargets(), (t) => t.name)`; errors are logged like `refreshTitles`.
    - It is called from `refreshTitles()`, which keeps its `listTitles` call: the spec keeps `list_titles` (planner's call). It is also called from `onFocus`.
    - `commitRename` gains `void this.refreshTitles()` after a rename succeeds. Today a rename leaves the existence set stale.
    - `async createLinked(title: string)`: `await api.createFromSelection(title, "")`, then `refreshTitles()` and `runSearch(false)`. Errors go to `setErr`: `"already-exists"` → "A note with this title exists"; `"invalid-title"` → `INVALID_TITLE`.
    - `INVALID_TITLE = 'A title can\'t contain / \\ : * ? " < > | or start with a dot'` (planner's call), exported from `controller.ts`.
    - The editor never changes note.
    - `editorOpts().complete = { links: () => this.linkIndex, tags: () => this.tagIndex, onCreate: (t) => void this.createLinked(t) }`. Task 4 fills `tagIndex`; until then it is `[]`.
  - Popup styling: `.cm-tooltip-autocomplete` themed with `velo.*` CSS variables, in `editortheme.ts`'s `writingTheme`, light and dark.

- [ ] **Step 1:** `pnpm add @codemirror/autocomplete@^6.20.4`.
- [ ] **Step 2: Write failing tests:**
  - `fuzzy.test.ts`:
    - `tiers in spec order`: for `q = "mee"`, `"mee"` → 5, `"meeting notes"` → 4, `"team meeting"` → 3, `"ameeba"` → 2, `"my extra e"` → 1, `"xyz"` → 0.
    - `rank folds accents and breaks ties by the tie function`: `"Résumé"` matches `"resu"`. Two prefix hits come out in `modified` descending order.
    - `rank caps at limit`.
    - `rank 10k items under 50 ms`: 10 000 prepared random titles. `performance.now()` around `rank("ab", …)` is < 50.
  - `complete.test.ts`, over `EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] })` with `ensureSyntaxTree`:
    - `linkContext after [[`: `"see [[Mee"`, with pos at the end → `{ from: 6, query: "Mee" }`.
    - `linkContext null in code, front matter, after ]] and after |`: ``"`[[x`"``; `"---\ntitle: [[x\n---\n"` with pos inside the block; `"[[a]] b"` at the end; `"[[a|lab"`. Fenced: `` "```\n[[x\n```" ``.
    - `link apply writes name and closing brackets`: run the option's `apply` on a state, via `EditorState.update` with the change it builds; export the change builder `linkInsert(state, from, pos, name): TransactionSpec` for the test. `"[[mee"` + `"Meeting notes"` → `"[[Meeting notes]]"`, caret at 17. `"[[mee]]"` with the caret before `]]` → the same text, no doubled brackets.
    - `create row only without an exact folded match`: the options for `"meeting NOTES"` have no Create row when `"Meeting notes"` exists, and have one for `"Brand new idea"`.
  - `controller.test.ts`:
    - `link targets load on refreshTitles and editor focus`: `listLinkTargets` is called on `start()`, and again when `editorOpts().onFocus()` runs.
    - `createLinked creates an empty note and keeps the open note`: `createFromSelection` is called with `("Brand new idea", "")`; `editor.currentPath()` is unchanged; `listLinkTargets` is called again.
    - `createLinked shows invalid-title`: the fake rejects `"invalid-title"` → `store.err === INVALID_TITLE`.
    - `rename refreshes titles`.
- [ ] **Step 3: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Quality gate** + `pnpm build`. Then run `pnpm tauri dev` against a scratch notes folder made with `mktemp -d`, never the user's vault. Check that typing `[[mee` opens the popup, arrows and Enter pick, and Esc closes the popup while focus stays in the editor (Review Focus 1). Check light and dark.
- [ ] **Step 6: Commit** `feat(writing): [[ link autocomplete with Create row`.

### Task 4: `#` tag autocomplete

**Files:**
- Modify: `src/complete.ts`, `src/complete.test.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`

**Interfaces:**
- Consumes: `rank`, `prepare`, `CompleteSource` (Task 3), and `readTag`'s prefix rule (`src/tags.ts`).
- Produces:
  - `tagContext(state: EditorState, pos: number): { from: number; query: string } | null`.
    - It scans back from `pos` over `[\p{Alphabetic}\p{N}_\-/]` to a `#`. The character before the `#` must be absent (line start), whitespace or `(`. That is `readTag`'s rule; export a `tagStartOk(src, i)` helper from `tags.ts` if that keeps one copy.
    - `query` is at least one character (planner's call: a lone `#` never opens, so starting a heading never pops anything).
    - It returns null in front matter, and when an ancestor node is `FencedCode`, `CodeBlock`, `InlineCode`, `URL` or `Autolink`.
  - `tagSource`: options from `rank(fold(query), src.tags(), byCountDesc)`, with `label: tag` and `detail: String(count)`. There is no Create row.
    - `apply` replaces `[from, pos)` plus the rest of the tag word after the caret with `tag + " "`. When whitespace already follows, no space is added (planner's call).
  - Controller: `protected tagIndex: Ranked<TagCount>[] = []`, set by `refreshTags` from the tags it already loads (`prepare(tags, (t) => t.tag)`).

- [ ] **Step 1: Write failing tests** (`complete.test.ts`):
  - `tagContext mid-sentence`: `"see #pro"` → `{ from: 5, query: "pro" }`. `"(#pro"` → a context.
  - `tagContext null for headings and non-tag hashes`: `"# Title"` with pos after the space; `"## x"`; `"#"` alone; `"[[a#b"`; `"x#pro"`; `"https://x.io/#pro"`; ``"`#pro`"``; `"---\ntags: #pro\n---\n"`.
  - `tag apply writes the display spelling and a space`: `"see #pro"` + `"Project"` → `"see #Project "`. `"see #pro next"`, with the caret after `pro` → `"see #Project next"`.
  - `controller.test.ts`, `refreshTags feeds the tag completion source`: `listTags` resolves `[{ tag: "Project", count: 3 }]`, then `editorOpts().complete.tags()` has one item.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate** + `pnpm build`. Then a manual check in `pnpm tauri dev` on a scratch folder: `#pro` mid-sentence offers tags with counts, and `# Heading` offers nothing.
- [ ] **Step 5: Commit** `feat(writing): #tag autocomplete`.

### Task 5: Move to new note (extract)

**Files:**
- Create: `src/writing.ts`, `src/writing.test.ts`, `src/ui/ExtractDialog.tsx`
- Modify: `src/editor.ts`, `src/app/store.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/app/fakes.ts` (fake editor), `src/shortcuts.ts`, `src/shortcuts.test.ts`, `src/ui/App.tsx`, `src-tauri/src/settings.rs` (`ACTIONS`)

**Interfaces:**
- Consumes: `createFromSelection`, `INVALID_TITLE` (Tasks 2–3), and `Editor.applyChange(change, true)`.
- Produces:
  - `extractTitle(selection: string): string` in `src/writing.ts`. It takes the first non-blank line, strips leading `#`, `-`, `*`, `[ ]`, `[x]` and spaces, and cuts to 60 characters (on a code-point boundary) with `trimEnd`.
  - `Editor.getSelection(): { from: number; to: number; text: string } | null`: the main selection, or null when empty. The fake editor in `fakes.ts` implements it.
  - Actions:
    - `extract_note`: `DEFAULTS` `"Mod+Shift+KeyN"`, `LABELS` `"Move to new note"`, controller action `() => void this.startExtract()`.
    - Rust `ACTIONS` grows to 21 entries.
  - Store: `extract: { title: string; err: string } | null`.
  - `controller.startExtract()` refuses with `setErr` unless all of these hold:
    - a note is open;
    - `!store.encrypted` → "Can't move text out of a locked note";
    - `!busy && !indexing`;
    - the selection is non-empty;
    - `selection.from >= frontMatterRange(text)?.to ?? 0` → "Select text below the front matter".
  - It then saves `{ path, from, to, text }` in a protected field and sets `extract: { title: extractTitle(text), err: "" }`.
  - `controller.commitExtract(title: string | null)`:
    1. `null` closes the dialog.
    2. An empty trimmed title → `err: "Title required"`.
    3. Else `await api.createFromSelection(title, text)`.
       - `"already-exists"` → dialog `err: "A note with this title exists"`.
       - `"invalid-title"` → `INVALID_TITLE`; the dialog stays open.
    4. On success:
       - if the editor is still on `path` and `editor.getText().slice(from, to) === text`, apply `applyChange({ from, to, insert: "[[" + title.trim() + "]]" }, true)`;
       - else `setErr('Created “T”; the selection changed, so the text was left in place')`;
       - in both cases: close the dialog, `refreshTitles()`, `runSearch(false)`, `editor.focus()`.
    - The source changes only after the create resolved. The editor stays on the source.
  - `ExtractDialog`: Park UI `Dialog`, store-driven like `SettingsDialog`. It has one `Field` "Title", pre-filled and selected; the error shows under it. Enter → `commitExtract(value)`; Esc or Cancel → `commitExtract(null)`. The OK button reads "Move".

- [ ] **Step 1: Write failing tests:**
  - `writing.test.ts`, `extractTitle strips markers and cuts at 60`: `"## Plan\nmore"` → `"Plan"`. `"- [ ] buy milk"` → `"buy milk"`. `"\n\n  * item"` → `"item"`. 80 × `"é"` → 60 code points.
  - `shortcuts.test.ts`, `extract_note defaults to Mod+Shift+KeyN and does not clash`: the existing clash check passes over all defaults.
  - `controller.test.ts`:
    - `extract creates the note then links the selection`: the selection `"Big idea\nbody"` in `/n/A.md`. Expect `createFromSelection("Big idea", "Big idea\nbody")` to be called before `applyChange`, with `{ from, to, insert: "[[Big idea]]" }` and `isolate === true`; the editor stays on `/n/A.md`.
    - `extract refuses encrypted, empty selection, front matter, busy`: each → `createFromSelection` not called, `extract` stays null, `err` set.
    - `extract existing title keeps the dialog open`: the fake rejects `"already-exists"` → `extract.err === "A note with this title exists"`, and `applyChange` is not called.
    - `extract failure leaves the source untouched`: the fake rejects `"boom"` → `applyChange` not called (Anti-goal: losing text).
    - `extract after the text moved never replaces the wrong range`: the editor text changes between `startExtract` and `commitExtract` → `applyChange` not called, `err` contains "left in place", and the new note exists in `notes` (Review Focus 2).
  - `settings.rs`: update the existing `ACTIONS` test or length if one asserts it.
- [ ] **Step 2: Run** `pnpm test && (cd src-tauri && cargo test settings::)`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate** + `pnpm build`. Then a manual check on a scratch folder: select a paragraph, press ⌘⇧N, press Enter, then ⌘Z brings the paragraph back and the new note still exists.
- [ ] **Step 5: Commit** `feat(writing): Move to new note`.

### Task 6: Merge backend (`merge_notes`)

**Files:**
- Modify: `src-tauri/src/frontmatter.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/api.ts`, `src/app/fakes.ts`

**Interfaces — Produces:**
- `frontmatter::add_aliases(text: &str, add: &[String]) -> Result<Option<String>, String>`.
  - Generalize `set_tags`' body into a private `set_list(text, key: &str, add, remove, create_block)`. `set_tags` becomes a one-line wrapper with key `"tags"`; the `#` stripping in `tag_key` and in the add trim applies to `tags` only. Every existing `set_tags` test stays green.
  - New items are written through `flow_item`, so `Q3: plan, draft` gets quoted. An alias match is folded and case-insensitive.
  - `add_aliases` always creates a block when none exists. The error text is `unsupported aliases: layout`.
- `pub fn merged_text(target: &str, target_title: &str, source: &str, source_title: &str) -> Result<String, String>` in `vault.rs`, next to `toggled_text`:
  1. `t = set_tags(target, &src_fm.tags, &[], true)?`. Only the source's front-matter tags are added: its inline `#tags` travel with its body (planner's call).
  2. `t = add_aliases(&t, &(src_fm.aliases + [source_title]))?`, skipping any alias whose fold equals `fold(target_title)` (planner's call).
     - The block is created even when `write_front_matter` is off (planner's call): the alias is what keeps `[[Source]]` from locked notes and from memory resolving.
  3. Append the source body (`frontmatter::body(source)`, leading blank lines trimmed). The result is `t.trim_end()` + (a blank line unless the body of `t` is empty) + `## {source_title}` + blank line + `src_body.trim_end()` + one EOL.
     - The EOL is `\r\n` when `target` contains `\r\n`.
     - An empty source body gives the heading only.
  - The target's `created` is untouched; `save_note` keeps it.
- `#[derive(Serialize)] pub struct MergeResult { pub path: String, pub rewritten: usize, pub trash_error: Option<String> }`.
  - `trash_error` goes beyond the spec's `{ path, rewritten }` (planner's call): it is how "reports what was not done" reaches the UI and MCP.
- `fn rewrite_backlinks(&mut self, old_title: &str, new_title: &str, skip: &str) -> usize`: the loop moved out of `rename_note` unchanged (`backlinks`, `rewritable`, `rewrite_links`, `write_atomic`, batched `begin`/`commit` with the redo). It skips the path `skip`. `rename_note` calls it with `skip = ""`.
- `Vault::merge_notes(&mut self, source: &str, target: &str, write_fm: bool) -> anyhow::Result<MergeResult>`. `merge_notes_with(…, remove: impl FnOnce(&Path) -> io::Result<()>)` takes the remover for tests, like `delete_note_with`. The steps:
  0. `source == target` → `Err("same-note")`. Either `note(p)?.encrypted` or `locked_twin` → `Err("locked")`.
  1. Read both through `open_note(path, None)`, then compute `merged_text(…)?`. An unsupported layout fails here, with nothing written.
  2. `snapshot_text(target, &t.text, None)?`.
  3. `save_note(target, &merged, &t.hash, None, write_fm)?`. `Conflict` → `Err("conflict")`. Planner's call: the conflict copy that `Store::save` writes stays, but the target and source keep their bytes.
  4. `rewritten = self.rewrite_backlinks(&s.title, &t.title, source)`. Unreadable or locked sources are skipped, as in rename.
  5. `trash_error = self.delete_note_with(source, remove).err().map(|e| e.to_string())`.
- Tauri command `merge_notes(source, target) -> MergeResult`. `write_fm` comes from settings.
- TS: `type MergeResult = { path: string; rewritten: number; trash_error: string | null }` and `mergeNotes(source, target)`, which rejects with `"same-note" | "locked" | "conflict" | …`. `fakeApi.mergeNotes` throws `"unset"` by default.

- [ ] **Step 1: Write failing tests:**
  - `frontmatter.rs`:
    - `add_aliases_flow_block_and_new`: `aliases: [a]` + `["B", "a"]` → `aliases: [a, B]`. A block list gains `  - B`. No block → `---\naliases: [B]\n---\n…`.
    - `add_aliases_quotes_special`: `"Q3: plan, draft"` is written quoted, and `parse` reads it back equal.
    - `set_tags_unchanged`: the existing `set_tags` tests pass untouched.
  - `vault.rs`, `merged_text`:
    - `merged_text_appends_under_heading_and_unions_front_matter`: target `"---\ntags: [a]\naliases: [T2]\n---\nbody T\n"`; source `"---\ntags: [A, b]\naliases: [S2]\n---\nbody S\n"`. Expect `tags: [a, b]`, aliases containing `T2`, `S2` and `Source`, and a body ending `"body T\n\n## Source\n\nbody S\n"`.
    - `merged_text_creates_block_and_keeps_crlf`: a target with no front matter and CRLF → a block with `aliases: [Source]`, and every line ends `\r\n`.
    - `merged_text_empty_target_body`: target `""` → the body starts with `## Source`.
    - `merged_text_skips_alias_equal_to_target_title`: a source alias `target` (any case) is not added.
  - `vault.rs`, `merge_notes`, over a temp vault with `remove = |p| std::fs::remove_file(p)`:
    - `merge_rewrites_links_and_trashes_source`: `C.md` has `[[Source]] and [[source|label]]`, `L.md.age` links `[[Source]]`. After the merge, `C.md` reads `[[Target]] and [[Target|label]]`, `rewritten == 2`, `Source.md` is gone, and `find_note("Source")` resolves to `Target.md` through the alias. `L.md.age`'s bytes are unchanged.
    - `merge_snapshots_target_first`: `list_revisions(target)`'s newest entry reads the pre-merge text.
    - `merge_refuses_same_encrypted_and_twin`: `same-note`; `locked` for a `.md.age` on either side; `locked` for a plain twin. File bytes are unchanged in each case.
    - `merge_unsupported_layout_changes_nothing`: target tags in an unsupported layout → `Err`, and both files keep their bytes with no new revision (Review Focus 3).
    - `merge_trash_failure_is_reported_not_rolled_back`: `remove` returns `Err` → `Ok(MergeResult { trash_error: Some(_) })`, the target is merged, links are rewritten, and `Source.md` still exists (Review Focus 3).
    - `rename_still_rewrites_links`: the existing rename tests stay green after the extraction.
- [ ] **Step 2: Run** `cd src-tauri && cargo test frontmatter:: merge rename`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(writing): merge_notes backend`.

### Task 7: Merge UI

**Files:**
- Create: `src/ui/MergeDialog.tsx`
- Modify: `src/contextmenu.ts`, `src/contextmenu.test.ts`, `src/shortcuts.ts`, `src/shortcuts.test.ts`, `src/app/store.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/ui/App.tsx`, `src-tauri/src/settings.rs` (`ACTIONS`, 22 entries)

**Interfaces:**
- Consumes: `mergeNotes`, `MergeResult` (Task 6), `rank`, `linkIndex` (Task 3), `backlinkCount`.
- Produces:
  - `MenuAction` gains `"merge_note"`. `menuModel` adds `{ id: "merge_note", text: "Merge into…", ...acc("merge_note") }` after `rename`, for plain notes only. Encrypted rows get no entry (planner's call).
  - `merge_note`: `DEFAULTS` `NONE`, `LABELS` `"Merge into…"`, controller action `() => void this.startMerge()`. The `openContextMenu` run map gets `merge_note: () => this.startMerge()`; the row is already open there.
  - Store: `merge: { source: string; sourceTitle: string; query: string; target: { path: string; title: string; count: number } | null; err: string } | null`.
  - `controller.startMerge()`:
    - It refuses (`setErr`) with no open note, when encrypted ("Can't merge a locked note"), when busy, or while indexing.
    - It flushes the editor; a failed flush → "Can't merge: unsaved changes couldn't be saved".
    - It then sets `merge` with an empty query.
  - `controller.mergeCandidates(query: string): LinkTarget[]`: `rank(fold(query), linkIndex filtered to name === title && !locked && path !== source, byModifiedDesc)`.
  - `controller.setMergeQuery(q)`.
  - `controller.chooseMergeTarget(t: LinkTarget)`: `count = await api.backlinkCount(sourceTitle)`, stored in `merge.target`.
  - `controller.backMerge()`: clears `target`.
  - `controller.cancelMerge()`.
  - `controller.commitMerge()` follows `deleteNote`'s detach pattern:
    1. `busy = true`.
    2. If the editor is on the source or the target: flush (a failure → `merge.err`, return), then `editor.discard(); closedDoc()`.
    3. `r = await api.mergeNotes(source, target)`.
    4. On success: `history.remove(source)`, `await show(r.path)` (the target opens and reloads), `runSearch(false)`, `refreshTitles()`, `refreshTags()`. With `r.trash_error`: `setErr('Merged, but “S” couldn't be moved to the Trash: …')`. Close the dialog.
    5. On failure: `merge.err = errText(e)` (`"locked"` → "Can't merge a locked note"; `"same-note"` → "Pick another note"). If it detached, `show(previous path)` puts the note back.
    6. `finally busy = false`.
  - `MergeDialog`, store-driven Park UI `Dialog`:
    - **Pick step:** an input labelled "Merge into" with a `role="listbox"` of candidates, driven by `aria-activedescendant`. ↑/↓ move, Enter picks, Esc cancels.
    - **Confirm step:** "Merge **Source** into **Target**? *N* links will be updated. Source goes to the Trash." When N = 1 it reads "1 link will be updated" (planner's call). Buttons: Merge (primary, focused), Back, Cancel.
    - `merge.err` shows in the dialog.

- [ ] **Step 1: Write failing tests:**
  - `contextmenu.test.ts`: update the order test to `["open", "rename", "merge_note", "toggle_lock", …]` for a plain note. `merge entry hidden for encrypted notes`.
  - `shortcuts.test.ts`, `merge_note has no default`: `DEFAULTS.merge_note === NONE`, and `formatBinding` gives `"—"`.
  - `controller.test.ts`:
    - `merge candidates skip source, aliases and locked`.
    - `merge of the open source ends on the target`: the editor is open on `/n/S.md`. Choosing `T` calls `backlinkCount("S")`; `commitMerge` → `mergeNotes("/n/S.md", "/n/T.md")`, after a flush and `discard`. The editor ends on `/n/T.md`, and `S` leaves history.
    - `merge with the target open reloads it`: the editor is on `T` → `openNote("/n/T.md")` is called again after `mergeNotes`.
    - `merge refused when the flush fails`: `flush` resolves false → `mergeNotes` not called, `merge.err` set, the editor is still on `S` (Review Focus 4).
    - `merge failure puts the note back`: `mergeNotes` rejects `"conflict"` → the editor is back on `S`, and `merge.err === "conflict"`.
    - `merge trash failure shows what was not done`: it resolves `trash_error: "denied"` → `err` contains "couldn't be moved to the Trash", and the editor is on `T`.
    - `merge refuses encrypted`: `store.encrypted` true → `merge` stays null.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate** + `pnpm build`. Then a manual check on a scratch folder: right-click a note with backlinks, Merge into…, pick a target with the keyboard only, Merge. Its text sits under its title in the target, and the source is in the Trash.
- [ ] **Step 5: Commit** `feat(writing): Merge into… dialog`.

### Task 8: MCP tool `merge_notes`

**Files:**
- Modify: `src-tauri/src/agent/ops.rs` (trait + `VaultOps`), `src-tauri/src/agent/app_ops.rs`, `src-tauri/src/agent/tools.rs`, `src-tauri/src/agent/mod.rs` (test only), `src/app/controller.ts` only if the flush reply needs it (it should not)

**Interfaces — Produces:**
- `NoteOps::merge(&mut self, source: &str, target: &str, summary: &str) -> anyhow::Result<MergeResult>`.
- `VaultOps::merge`:
  1. `plain()` both paths.
  2. Take agent snapshots, all with `summary`: the target, the source, and every `rewritable` backlink source of the source's title. This is the same pattern as `rename`.
  3. `landed(self.vault.merge_notes_with(source, target, wfm, self.remove), target, before)`.
  4. `unsnapshot` on failure.
  - The vault's own unthrottled target snapshot dedupes against the identical agent one (`snapshot_bytes` skips equal bytes).
- `AppOps::merge`, modelled on `rename` + `trash`:
  1. Send one `{"kind": "flush", "paths": [target, ...link sources]}` (a `"refused"` reply → `Err("note is open in velo with unsaved changes")`), then release those paths.
  2. `ask_editor({"path": source, "kind": "trash", "summary"}, ["closed", "not-open"])`.
  3. `self.with(|o| o.merge(source, target, summary))`.
  4. `touched` gets the source, the target and the link sources. Then `release(source)`.
  5. If the editor closed the source and the merge failed, route `trash-failed` with the error, as `trash` does.
  - The open target was flushed clean, so `notes-changed` reloads it.
  - Planner's call: with an agent merge of the open source, the editor closes it like `move_to_trash`, rather than moving to the target.
- `ToolSpec { name: "merge_notes", … }`:
  - Schema: `{"type":"object","properties":{"source":{"type":"string"},"target":{"type":"string"},"summary":{"type":"string"}},"required":["source","target","summary"]}`.
  - Description, with `conventions!()`: "Merge note `source` into note `target`: the source's text is appended to the target under a `## Source title` heading, its tags and aliases (and its title, as an alias) join the target's front matter, [[links]] to the source in other notes are rewritten to the target, and the source goes to the OS Trash. Returns the target's title and hash, the number of links rewritten and whether the source was trashed."
- `is_write` gains `"merge_notes"`.
- The handler finds `source` and `target` (each through `ops.find`, missing or locked → `"not found"`), calls `ops.merge`, then `ops.read(target)`. It returns `{"title", "hash", "rewritten", "trashed": trash_error.is_none(), "trash_error"}`.
  - The error strings `same-note` and `conflict` pass through.
  - `locked` cannot occur, because `find` hides locked notes.
- README tool count: 17 (Task 9).

- [ ] **Step 1: Write failing tests:**
  - `tools.rs`:
    - `merge_notes_merges_and_rewrites`: through `vault(…)` with `Source.md`, `Target.md`, and `C.md` → `[[Source]]`. The reply has `rewritten == 1` and `trashed == true`; `read_note("Target")["aliases"]` contains `"Source"`; `read_note("Source")["title"] == "Target"`, because the alias now resolves it. `Source.md` is gone, so the Trash removal ran.
    - `merge_notes_needs_summary`.
    - `merge_notes_locked_is_not_found`: a `.md.age` as source or as target → `Err("not found")`, with every file's bytes unchanged.
    - `merge_notes_failure_drops_agent_snapshots`: `same-note` → no agent revision is left on the target.
  - `app_ops.rs`:
    - `merge_of_open_source_closes_it_then_merges`: the route answers `flushed` / `closed`. The request kinds are `flush` then `trash`, the merge lands, and `touched` contains the target.
    - `merge_refused_when_flush_refused`: the route answers `refused` to `flush` → `Err` containing "unsaved changes", and the files are unchanged (Review Focus 4).
    - `merge_hides_unlocked_locked_notes`: with `state()` (unlocked `L`), `merge_notes` with source `L` → `not found`, and `L.md.age`'s bytes are unchanged.
  - `mod.rs`, `gate_routes_merge_notes`: on a direct vault, `merge_notes` is in `TOOL_SPECS` and passes the gate. With `fake_app` running, it returns `{"fake": "merge_notes"}`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test agent::`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): merge_notes tool`.

### Task 9: Docs, changeset, full gate

**Files:**
- Modify: `README.md`
- Create: `.changeset/writing-helpers.md`

- [ ] **Step 1:** README:
  - a "Writing helpers" section with one short paragraph each: tag bar; `[[` autocomplete (aliases, Create row); `#` autocomplete; Move to new note (⌘⇧N, front matter, locked notes refused, ⌘Z); Merge into… (result, links, alias, Trash, revisions);
  - shortcut table rows: `| ⌘⇧N | Ctrl+Shift+N | Move the selection to a new note |` and `| — | — | Merge the open note into another (set in Settings) |`;
  - Agents (MCP): "Tools (17)" and `- \`merge_notes\`: merge one note into another, rewriting links; the source goes to the Trash.`
- [ ] **Step 2:** Changeset:
  ```md
  ---
  "velo": minor
  ---

  Added writing helpers: a tag bar under the note title, autocomplete for [[links]] and #tags, Move to new note (⌘⇧N) and Merge into…, plus a merge_notes tool for agents.
  ```
- [ ] **Step 3: Full quality gate** (CONTRIBUTING, all five checks), reported as a table:
  - `pnpm exec tsc --noEmit`, `pnpm test`, `cd src-tauri && cargo test`, `pnpm build:app` (or `cargo build --release` if the signing key is absent);
  - docs;
  - staleness: `@codemirror/autocomplete` is used and nothing is orphaned;
  - capabilities: no new plugin permissions expected, so `src-tauri/capabilities/default.json` is unchanged.
- [ ] **Step 4:** Walk the spec's owner checks 1–7 (section 11) on a scratch notes folder made with `mktemp -d`. Check 7 uses `velo --mcp` against that folder, never the real vault. Note any that can't run headless in the commit body.
- [ ] **Step 5: Commit** `docs(writing): README and changeset`.
