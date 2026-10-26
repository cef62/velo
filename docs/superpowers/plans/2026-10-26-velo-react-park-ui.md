# velo React + Park UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild velo's UI in React with Park UI v1 (Ark UI + Panda CSS 1.12.1), following `design/park-ui/`, keeping behaviour parity with 0.3.0 plus four approved additions.

**Architecture:**
- The pure logic modules stay.
- `main.ts` becomes a DOM-free `Controller` (`src/app/controller.ts`). It writes to an observable `Store` and talks to the UI through an injected `UiPort`, so its sequencing is node-testable.
- React components render the store and call controller actions.
- CodeMirror (`mountEditor`) and the preview renderer (`mountPreview`) are mounted by React components through refs and attached to the controller.
- The new UI lives at `app.html` / `src/ui/main.tsx` until the final task switches `index.html` over in one go.

**Tech Stack:** React 19.3.1, @ark-ui/react 5.39.3, Park UI v1 (`@park-ui/cli` 1.0.1), @pandacss/dev 1.12.1, lucide-react, @fontsource-variable/inter + jetbrains-mono 5.3.0, Vite 8, Tauri 2, CodeMirror 6, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-10-26-velo-react-park-ui-design.md`. The visual source of truth is `design/park-ui/README.md`, with exact values in `design/park-ui/reference/velo-park.css` and structure and copy in `design/park-ui/reference/*.dc.html`. Reference implementation of the toolchain: branch `spike/park-react` (worktree `/Volumes/Dev/matteo/velo-spike`).

## Global Constraints

**Dependencies and toolchain**
- Pin `@pandacss/dev`, `@pandacss/preset-base` and `@pandacss/preset-panda` to exactly `1.12.1`. Never 2.x: it breaks Park UI v1's `createStyleContext` / `RecipeConfig` imports.
- Allowed new dependencies, and only these: `react@19.3.1`, `react-dom@19.3.1`, `@ark-ui/react@5.39.3`, `lucide-react`, `@fontsource-variable/inter@5.3.0`, `@fontsource-variable/jetbrains-mono@5.3.0`; dev: `@pandacss/*@1.12.1`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`. No test DOM libraries, no state libraries, no virtual-list libraries.
- `styled-system/` is generated: it stays gitignored. `pnpm build`, `pnpm test` and `tsc` must run `panda codegen` first, via the `prepare`/`codegen` script.
- Fonts are bundled from fontsource; no network font loading.
- Tests run in node: nothing imported by a `*.test.ts` may touch `window`/`document` at module load.

**Theme**
- Park palette: accent Indigo, gray Slate. Radii `l1` = `{radii.sm}` (4 px), `l2` = `{radii.md}` (6 px), `l3` = `{radii.lg}` (8 px).
- Conditions: `dark: '[data-theme=dark] &'`, `light: ':root &, [data-theme=light] &'`. The app always writes `data-theme` on `<html>` ("system" is resolved via `matchMedia('(prefers-color-scheme: dark)')` and updated on `change`).

**Invariants**
- No user text lost: every note switch goes through flush-then-load, refused while unsaved. The `busy` guard covers the lock hand-off, delete and lock-all. The close flow asks about unsaved edits; window blur flushes.
- Locked-note plaintext is never written to disk, SQLite, localStorage or logs.
- Search under 50 ms p95 at 10k notes (perf test: `node scripts/seed.mjs 10000 fixtures/notes` then `cargo test --release --test perf -- --ignored --nocapture`).

**Copy and process**
- Copy strings fixed by the spec are used verbatim (§5, §6).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Typing fast in search while results arrive:** Enter must act on the latest rows. Pinned by a controller test (Task 6): "enter waits for the pending search".
2. **Switching notes while the current one can't save** (indexing, or a save error): the switch is refused, the text is kept, and the list selection snaps back. Pinned in Task 6: "select refused snaps back".
3. **Locking a note while a second click or keystroke switches notes:** the busy guard refuses, and no save goes to the old path. Pinned in Task 7: "lock hand-off busy refuses show".
4. **Font size 10 and 32 at the 600×400 minimum window:** the header keeps search ≥ 180 px and the overflow menu holds the folded controls. Rows keep their fixed height, so the virtual list never misaligns. Pinned in Task 2 (`fontScale` at 10 and 32) and Task 9 (breakpoints helper test).
5. **A shortcut cleared to "none" or set to a conflicting key in Settings:** "none" never fires, and a conflict blocks Save with the conflicting action named. Pinned in Task 4 ("none" resolve/matches) and Task 12 (`conflictsOf`).

---

### Task 1: Toolchain: React, Panda 1.12.1, Park UI v1, theme

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `vitest` config (create `vitest.config.ts` if needed so tests exclude `styled-system`)
- Create: `panda.config.ts`, `postcss.config.cjs`, `components.json`, `pnpm-workspace.yaml` (allowBuilds `@parcel/watcher: true`), `src/theme/**` (Park CLI output + `src/theme/tokens/velo.ts`), `src/components/ui/**` (Park CLI output), `src/vite-env.d.ts`, `app.html`, `src/ui/main.tsx`, `src/ui/index.css`, `src/app/fontscale.ts`, `src/app/fontscale.test.ts`

**Interfaces:**
- Produces:
  - `fontScale(size: number): { editor: number; listTitle: number; snippet: number; date: number; rowCompact: number; rowTwoLine: number; title: number }`
  - `rowHeight(size: number, layout: "vertical" | "horizontal"): number`
  - `applyFontScale(size: number, root?: HTMLElement): void` (sets `--velo-editor-fs`, `--velo-list-fs`, `--velo-snippet-fs`, `--velo-date-fs`, `--velo-row-h`, `--velo-row2-h`, `--velo-title-fs`)
  - Constants `FONT_MIN = 10`, `FONT_MAX = 32`, `FONT_DEFAULT = 14`
- Produces: Panda tokens `velo.*` colors (all keys of `design/park-ui/panda/velo-preset.ts`), fonts `ui`/`body`/`mono`, fontSizes `ui` 13 px / `uiSm` 12 px / `uiXs` 11 px, sizes `readingColumn` 46em / `control` 32 px / `controlSm` 28 px / `header` 48 px / `titleBar` 48 px, shadow `veloPopover`.
- Produces: the Park UI React components `Button`, `IconButton`, `Input`, `Field`, `Dialog`, `Tabs`, `Menu`, `Tooltip`, `SegmentGroup`, `Select`, `Checkbox`, `Kbd`, `Badge`, `Spinner`, exported from `@/components/ui`.

- [ ] **Step 1:** Write `src/app/fontscale.test.ts`:
  ```ts
  test("font scale matches the design table", () => {
    expect([12, 14, 20].map((s) => { const f = fontScale(s); return [f.editor, f.rowCompact, f.rowTwoLine, f.title]; }))
      .toEqual([[14, 26, 40, 15], [16, 30, 46, 17], [22, 43, 66, 24]]);
    expect(fontScale(4).listTitle).toBe(10); expect(fontScale(99).listTitle).toBe(32);
    expect(rowHeight(14, "vertical")).toBe(30); expect(rowHeight(14, "horizontal")).toBe(46);
  });
  ```
- [ ] **Step 2:** Run `pnpm vitest run src/app/fontscale.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Create `src/app/fontscale.ts` from `design/park-ui/panda/font-scale.ts`. The `ListLayout` type becomes `"vertical" | "horizontal"`. `applyFontScale` must not run at import.
- [ ] **Step 4:** Reproduce the spike toolchain on this branch (see `spike/park-react` commit `0d9aec0`):
  - Install the pinned deps.
  - Run `panda init --postcss`.
  - Run `@park-ui/cli init` (react) through a pty (it is interactive).
  - Run `@park-ui/cli add indigo slate button icon-button input field dialog tabs menu tooltip segment-group select checkbox kbd badge spinner`.
- [ ] **Step 5:** Apply the spike's fixes:
  - `tsconfig`: `baseUrl "."`, `"ignoreDeprecations": "6.0"`, paths `@/*` and `styled-system/*`, `"jsx": "react-jsx"`, lib `DOM.Iterable`, include `styled-system`.
  - `panda.config.ts`:
    - Relative `./src/theme/...` imports; `jsxFramework: 'react'`; include `./src/**/*.{ts,tsx}`.
    - The "Remove Panda Preset Colors" plugin.
    - Semantic colors `gray: slate`, `indigo`, `velo` (no duplicates); radii as in Global Constraints.
    - `globalCss` from `src/theme/global-css.ts`: `colorPalette: 'indigo'`, body `velo.canvas` / `velo.fg` / `ui` font.
  - `src/theme/conditions.ts`: the dark/light conditions from Global Constraints.
  - `src/theme/recipes/index.ts`: split `recipes` / `slotRecipes` by whether the file calls `defineSlotRecipe`.
  - `vite.config.ts`: `@vitejs/plugin-react`; aliases `@` → `./src`, `styled-system` → `./styled-system`; `build.rollupOptions.input` = `{ main: "index.html", app: "app.html" }`.
  - `src/theme/tokens/velo.ts`: port `velo.*` from `design/park-ui/panda/velo-preset.ts` with `_light`/`_dark`. Add font, fontSize and size tokens and the `veloPopover` shadow to `panda.config.ts`'s `theme.extend.tokens` / `semanticTokens.shadows`.
- [ ] **Step 6:** Fix the Park checkbox recipe so `panda codegen` prints no `nested_property` warning: move the nested `control` styles under the slot key the warning names.
- [ ] **Step 7:** Scripts in `package.json`:
  - `"codegen": "panda codegen"` and `"prepare": "panda codegen"`.
  - `"build": "panda codegen && tsc && vite build"`.
  - `"test": "panda codegen && vitest run"`.
- [ ] **Step 8:** Create `app.html`, `src/ui/index.css` and `src/ui/main.tsx`.
  - `index.css`: `@layer reset, base, tokens, recipes, utilities;` plus the fontsource imports in `main.tsx`.
  - `main.tsx` renders a placeholder `<div className={css({ bg: "velo.canvas", color: "velo.fg", fontFamily: "ui" })}>velo</div>`.
- [ ] **Step 9:** Run `pnpm test && pnpm build && (cd src-tauri && cargo test)`. Expected: all pass; codegen shows no warnings; `dist/app.html` exists.
- [ ] **Step 10:** Commit: `chore: React + Panda 1.12 + Park UI v1 toolchain and velo theme tokens`.

### Task 2: velo recipes

**Files:**
- Create: `src/theme/recipes/velo/*.ts` (one file per recipe), `src/theme/recipes/velo.test.ts`
- Modify: `src/theme/recipes/index.ts`

**Interfaces:**
- Consumes: Task 1 tokens.
- Produces Panda recipes, importable from `styled-system/recipes`, ported from `design/park-ui/panda/recipes.ts` (values cross-checked against `reference/velo-park.css`):
  - Recipes: `searchMatch`, `inlineTag`, `keyCap` (variants `state: "idle" | "recording" | "conflict"`, `changed: boolean`), `divider` (`orientation: "horizontal" | "vertical"`), `banner` (`tone: "conflict" | "filter" | "preview"`), `previewPill`.
  - Slot recipes:
    - `listRow` (slots `root, title, snippet, date, lock`; variants `layout: "compact" | "twoLine"`, `state: "idle" | "selected" | "selectedIdle"`);
    - `tagChip` (slots `root, count`; `selected: boolean`);
    - `titleBar` (slots `root, title, status, actions`).
  - The design's `segmented` maps to Park `SegmentGroup` with a velo `size`/`iconOnly` usage. Don't create a separate recipe unless `SegmentGroup` can't match `velo-park.css`.

- [ ] **Step 1:** Write `src/theme/recipes/velo.test.ts`. It imports the generated recipe functions from `../../../styled-system/recipes` and asserts each returns a non-empty class string for every variant combination listed above (e.g. `expect(listRow({ layout: "twoLine", state: "selected" }).root).toMatch(/\S/)`). Also assert `keyCap({ state: "conflict" })` differs from `keyCap()`.
- [ ] **Step 2:** Run `pnpm test`. Expected: FAIL (recipes missing).
- [ ] **Step 3:** Port the recipes. List selection: `selected` uses `velo.selection` bg + `velo.selectionFg`; `selectedIdle` uses `velo.selectionIdle` with normal text. Focus-visible on rows is a −2 px inset outline in `velo.accent`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS; no codegen warnings.
- [ ] **Step 5:** Commit: `feat(ui): velo recipes on Park UI v1`.

### Task 3: Backend note count

**Files:**
- Modify: `src-tauri/src/index.rs` (`Page`, `search_page`), `src-tauri/src/vault.rs` (unlocked-note matches), `src-tauri/tests/perf.rs`, `src/api.ts`

**Interfaces:**
- Produces: `Page { hits, has_more, total: usize }`. `total` = the number of notes the list would show for (query, tags, unlocked set) across all pages. It is computed only when `offset == 0`; for `offset > 0` it is `0`, and the UI keeps the first page's value. TS: `export type Page = { hits: Hit[]; has_more: boolean; total: number }`.

- [ ] **Step 1:** Rust tests in `index.rs` / `vault.rs` test modules:
  - `total_counts_all_pages`: 120 matching notes, page size as used today → first page `total == 120`, second page `total == 0`.
  - `total_respects_tags_and_query`.
  - `total_includes_unlocked_locked_notes`: an unlocked locked note matching in memory is counted once.
- [ ] **Step 2:** Run `cargo test`. Expected: the new tests FAIL to compile.
- [ ] **Step 3:** Implement with a `SELECT COUNT(*)` using the same WHERE / EXISTS clauses as `search_page`, plus the in-memory unlocked matches. Skip the count when `offset > 0`.
- [ ] **Step 4:** Add the first-page total to the perf test's timed path. Run the perf commands from Global Constraints. Expected: p95 < 50 ms; print the numbers.
- [ ] **Step 5:** Update the `Page` type in `src/api.ts`. Run `pnpm test && cargo test`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: search pages carry the total match count`.

### Task 4: Clearable shortcuts ("none")

**Files:**
- Modify: `src/shortcuts.ts`, `src/shortcuts.test.ts`, `src/settingsform.ts` (`recorderStep`), `src/dialogs.test.ts`, `src-tauri/src/settings.rs`, the hotkey registration site in `src-tauri/src/lib.rs` / `commands.rs`

**Interfaces:**
- Produces:
  - `export const NONE = "none"`.
  - `resolve()` keeps a saved `"none"`.
  - `matches(e, "none", isMac) === false`.
  - `formatBinding("none", isMac) === "—"`.
  - `validateBinding(m, a, "none")` → `{ ok: true }`.
  - `overrides()` stores `"none"` when it differs from the default.
  - `recorderStep`: Backspace or Delete with no modifier while recording → `{ recording: null, assign: "none", msg: "" }`.
- Rust: a `toggle_window` binding of `"none"` registers no global shortcut, and saving it unregisters the old one.

- [ ] **Step 1:** Write the tests:
  - `resolve({ back: "none" }).back === "none"`.
  - `matches(ev("KeyJ", { metaKey: true }), "none", true) === false`.
  - `formatBinding("none", true) === "—"`.
  - `overrides({ ...DEFAULTS, back: "none" })` equals `{ back: "none" }`.
  - `recorderStep("back", ev("Backspace", { metaKey: false }), true, draft)` equals `{ recording: null, assign: "none", msg: "" }`.
  - Rust `settings.rs`: a `toggle_window` of `"none"` round-trips.
  - Rust: the registration helper returns "no shortcut" for `"none"` (unit-test the parse helper).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Conflict checks ignore `"none"`.
- [ ] **Step 4:** Run `pnpm test && cargo test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: shortcuts can be cleared (none)`.

### Task 5: Search-match highlighting helper

**Files:**
- Create: `src/highlight.ts`, `src/highlight.test.ts`

**Interfaces:**
- Produces: `highlightRanges(text: string, query: string): [number, number][]`.
  - Returns sorted, merged, half-open ranges in `text` (original indices) where any whitespace-separated query term matches as a substring, compared through `fold` from `src/search.ts`.
  - Terms shorter than 1 char are ignored. Empty query → `[]`.
  - Folding maps per original character (`fold(ch)` may be empty or several chars), so ranges map back exactly.

- [ ] **Step 1:** Tests:
  - `highlightRanges("Café crème", "cafe")` → `[[0, 4]]`.
  - `highlightRanges("Café crème", "creme cafe")` → `[[0, 4], [5, 10]]`.
  - `highlightRanges("aaa", "aa")` → `[[0, 3]]` (overlaps merged).
  - `highlightRanges("x", "")` → `[]`.
  - `highlightRanges("Ｉstanbul", "istanbul")` follows whatever `fold` does. Assert no throw and ranges within bounds.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement: build the folded string with an index map from folded positions to original positions, then search each folded term.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: fold-aware search highlight ranges`.

### Task 6: Store, UiPort and Controller core (search, open, enter, history, steps)

**Files:**
- Create: `src/app/store.ts`, `src/app/ports.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/app/fakes.ts` (test fakes for Editor, Preview, Api, UiPort)
- Modify: `src/editor.ts`

**Interfaces:**
- **Store:** `createStore<T>(init: T): Store<T>` with `get(): T`, `set(patch: Partial<T> | ((s: T) => Partial<T>)): void`, `subscribe(fn: () => void): () => void`. The React hook `useStore<T, U>(store, sel: (s: T) => U): U` goes in `src/ui/useStore.ts` (Task 8) via `useSyncExternalStore`.
- **AppState** (in `store.ts`):
  ```ts
  interface AppState {
    phase: "loading" | "setup" | "ready";            // setup = no notes folder
    query: string; indexing: { done: number; total: number } | null;
    listVersion: number; count: number; hasMore: boolean; total: number;
    sel: number; listActive: boolean;                // listActive: focus in search or list (selection style)
    openPath: string | null; title: string; encrypted: boolean;
    err: string; saving: boolean; conflict: string | null; renaming: boolean;
    previewOn: boolean; editorStyle: "rich" | "plain"; layout: "vertical" | "horizontal";
    theme: "system" | "light" | "dark"; fontSize: number; sort: "modified" | "title";
    keys: Record<Action, string>; isMac: boolean;
    tags: TagCount[]; selectedTags: string[]; tagPanelOpen: boolean;
    exactTitleMatch: boolean;                        // drives the ⇧↩ Create hint
  }
  ```
- **UiPort** (in `ports.ts`): every side effect the controller needs from the UI or platform:
  ```ts
  interface UiPort {
    focusSearch(): void;                                   // focus + select text
    confirm(message: string, o: { title: string; okLabel?: string; kind?: "warning" | "info" }): Promise<boolean>;
    passphrase(req: { mode: "create" | "unlock"; context: string | null; submit: (pw: string) => Promise<void> }): Promise<boolean>;
    chooseDirectory(): Promise<string | null>;
    openUrl(url: string): Promise<void>; reveal(path: string): Promise<void>; copyText(t: string): Promise<void>;
    popupMenu(items: MenuSpec[], anchor: { x: number; y: number } | null): Promise<void>;  // native menu; MenuSpec from contextmenu.ts + "separator"
    rowAnchor(i: number): { x: number; y: number } | null; // keyboard menu anchor (bottom-left of row + 16px)
    setWindowTheme(t: "light" | "dark" | null): void;
    applyLook(s: { theme: AppState["theme"]; fontSize: number; layout: AppState["layout"] }): void; // data-theme, font scale, layout
  }
  ```
- **Api:** `type Api = typeof import("../api")`, injected.
- **Controller:** `class Controller { constructor(store: Store<AppState>, api: Api, ui: UiPort, opts: { isMac: boolean; platform: "mac" | "windows" | "linux" }) }`.
  - Attachment: `attachEditor(ed: Editor)`, `attachPreview(p: Preview)`, `row(i: number): Hit | undefined`.
  - Methods in this task, ported from `main.ts` with identical sequencing and guards:
    - `start()` (the startup IIFE), `setQuery(q: string)`, `runSearch(selectFirst: boolean, keepOpen?: boolean | "highlight")`;
    - `show(path, how?)`, `select(i, how?)`, `enter(force?)`, `openTitle(title, source)`, `navigate(dir)`, `step(d)`, `ensureRows(index)`;
    - `refreshTitles()`, `focusSearch()`, `setListActive(on: boolean)`, `onBlur()` (flush), `requestClose(): Promise<boolean>` (via `shouldClose` with `ui.confirm`).
  - `links: RichOpts` is built inside the controller.
- **`editor.ts` changes:**
  - Remove the banner DOM. Add opts `onConflict?: (conflictPath: string) => void` and `onSaving?: (on: boolean) => void`.
  - `SaveController` gets `onSaving` calls around `saveNote` (add it to `SaverDeps` as optional). Add a saver test: "onSaving true during save, false after (also on rejection)".

- [ ] **Step 1:** Write `controller.test.ts` with fakes (an in-memory Api with controllable promises; a fake Editor whose `flush()` result is settable; a fake UiPort recording calls). Tests:
  - "enter waits for the pending search": `setQuery("ab")` with the search promise unresolved, then `enter()`, then resolve with a row titled "ab" → `api.openNote` called with that path; `openOrCreate` not called.
  - "select refused snaps back": open A; editor `flush()` → false; `select(row of B)` → returns false, `store.sel` equals A's row, `openPath` A.
  - "auto-shown note not in history until edited": an arrow `step(1)` opens B (auto); `navigate("back")` returns to A (B not recorded).
  - "navigate skips a vanished note": history A→B→C, B missing (`openNote` rejects `"not-found"` for B) → back from C opens A, B dropped.
  - "show while busy refuses with Busy message": store `err` = `"Busy — try again in a moment"`.
  - "no folder → phase setup": search rejects `"no-folder"` → `phase === "setup"`.
  - "total from first page": the first page `total: 7` → `store.total === 7`; a later page with `total 0` keeps 7.
- [ ] **Step 2:** Run `pnpm vitest run src/app/controller.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement store, ports and controller core. Copy logic from `main.ts` function by function: DOM writes become `store.set`, focus/dialog/menu calls go to `ui.*`. Keep comments that explain guards. The keydown handler is NOT in this task.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS (all old tests still pass).
- [ ] **Step 5:** Commit: `feat(app): DOM-free controller core with store and UI port`.

### Task 7: Controller: lock, delete, rename, tags, settings toggles, menu, events, keys

**Files:**
- Modify: `src/app/controller.ts`, `src/app/controller.test.ts`, `src/app/fakes.ts`

**Interfaces:**
- Produces `Controller` methods ported from `main.ts`:
  - Note actions: `toggleLock()`, `lockEverything()`, `deleteNote()`, `startRename()` → sets `renaming`; `commitRename(title: string | null)` (null = cancel).
  - Tags: `showTags(on)`, `setTags(next)`, `toggleTagFilter(tag)`, `refreshTags(inPlace?)`.
  - Settings toggles: `toggleSort()`, `toggleStyle()`, `toggleLayout()`, `togglePreview()`, `setPreview(on)`; `saveSettings(next: Settings): Promise<string | null>` (null = ok, else the message to show); `chooseFolder()`.
  - `openContextMenu(i, atRow?)`, `openConflict()`, `dismissConflict()`, `retrySave()` (→ `editor.flush()`).
  - Events: `onKeyDown(e: KeyEventLike): boolean` (true = handled: the caller preventDefaults). `KeyEventLike` = `Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { inEditor: boolean; inSearchWithText: boolean; inDialog: boolean; inRename: boolean }`.
  - Backend events: `onNotesChanged(paths)`, `onIndexProgress(done, total)`, `onIndexDone()`, `onIndexError(message)`.
- **Passphrase (spec §6):**
  - `promptPassphrase(context: string | null)`:
    - If `!(await api.hasIdentity()) && !(await api.identityFileExists())` and the trigger is *opening* a locked note: set `err` to the exact copy "This note was locked with a velo key that isn't on this computer. Copy `.velo/identity.age` from the other computer into this notes folder." (render the backticks as code in the UI; the store holds plain text with the backticks), and return false without a dialog.
    - Otherwise call `ui.passphrase({ mode: identityFileExists ? "unlock" : "create", context, submit })`, with `submit` calling `api.setupPassphrase` and the keychain-unavailable notice as today.
  - Lock passes `context` = the note title; Lock all passes `"all"`.

- [ ] **Step 1:** Tests:
  - "lock hand-off busy refuses show": start `toggleLock()` with `lockNote` unresolved; `show(B)` → refused with the Busy message; resolve → editor rebound to the `.age` path, no `saveNote` to the old path.
  - "delete highlights neighbour without opening": delete open row 2 of 3 → `openPath` null, `sel` 2 → 1 if last, `openNote` not called after.
  - "delete flush failure aborts": `err` "Can't delete: unsaved changes couldn't be saved", `api.deleteNote` not called.
  - "tag prune highlights row 0 without opening": the selected tag disappears from `listTags` with no note open → `sel` 0, `openNote` not called.
  - "opening a locked note with no key anywhere shows the copy-identity error and no dialog".
  - "onKeyDown: none binding never fires; Backspace combo skipped in editor; arrows ignored in editor; menu key opens context menu for sel".
  - "saveSettings maps not-found to Folder not found".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, porting `main.ts` behaviour verbatim. The context menu uses `menuModel` and `ui.popupMenu`. The global theme: `applyLook` resolves "system" through the UiPort (the UI layer owns `matchMedia`).
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(app): controller actions, events and keyboard routing`.

### Task 8: React shell, store hook, platform port, editor and preview hosts

**Files:**
- Create:
  - `src/ui/useStore.ts`
  - `src/ui/platform.ts`: the real `UiPort` (Tauri `ask`, dialog `open`, opener, clipboard, `Menu`/`MenuItem`/`PredefinedMenuItem` popup with `LogicalPosition`, `getCurrentWindow().setTheme`, `applyLook` writing `data-theme` + `applyFontScale` + layout class, and the `matchMedia` listener)
  - `src/ui/App.tsx`, `src/ui/EditorHost.tsx`, `src/ui/PreviewHost.tsx`
- Modify: `src/ui/main.tsx`

**Interfaces:**
- Consumes: `Controller`, `Store<AppState>`, `UiPort` (Task 6), `mountEditor` with `onConflict` / `onSaving`, `mountPreview`.
- Produces:
  - `<App controller store />`: layout grid for vertical and horizontal per the design README "Layout".
  - `EditorHost` mounts `mountEditor` once (StrictMode-safe: destroy and recreate guarded) and calls `controller.attachEditor`.
  - `PreviewHost` mounts `mountPreview` on an `<aside>` whose `hidden` attribute React never sets.
  - `main.tsx`:
    - Wires `listen()` events to the controller methods (Task 7).
    - Adds the window capture-phase keydown listener → `controller.onKeyDown` (computing `inEditor` etc. from the event target).
    - Hooks `window.blur` → `onBlur`, and `onCloseRequested` → `requestClose`.

- [ ] **Step 1:** Implement. Keep focus handling in `platform.ts` through element refs registered by components (`registerSearchInput(el)`).
- [ ] **Step 2:** Run `pnpm build`. Expected: PASS.
- [ ] **Step 3:** Visual smoke (controller runs it if the implementer can't):
  - Start `npx vite --port 5199`.
  - Run the WebKit script `node /private/tmp/claude-501/-Volumes-Dev-matteo-notes/793e3ffa-c47e-4405-b075-087ed30a9502/scratchpad/pw/<script>.mjs` against `http://localhost:5199/app.html`, with the Tauri IPC stub `/private/tmp/claude-501/-Volumes-Dev-matteo-notes/793e3ffa-c47e-4405-b075-087ed30a9502/scratchpad/tauri-stub.js` as the init script.
  - Expected: no page errors; a note opens from the list; typing in the editor works.
- [ ] **Step 4:** Commit: `feat(ui): React shell with editor and preview hosts`.

### Task 9: Header

**Files:**
- Create: `src/ui/Header.tsx`, `src/ui/breakpoints.ts`, `src/ui/breakpoints.test.ts`, `src/ui/SearchField.tsx`, `src/ui/OverflowMenu.tsx`

**Interfaces:**
- Produces:
  - `headerMode(width: number): "full" | "compact" | "folded"`: ≥ 900 → full, 720–899 → compact, < 720 → folded.
  - `searchHint(s: { query: string; sel: number; exactTitleMatch: boolean; keys; isMac }): string[]`: `["⌘L"]` when the query is empty; `["↩ Open"]` with a row highlighted; `["⇧↩ Create"]` when there's no exact title match; both when there are matches without an exact match. Glyphs per platform.

- [ ] **Step 1:** Tests: `headerMode(900) === "full"`, `headerMode(899) === "compact"`, `headerMode(719) === "folded"`, `headerMode(600) === "folded"`; plus the `searchHint` cases above, with the `isMac=false` variants giving `Ctrl+L`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers.
- [ ] **Step 4:** Implement the header per the README "Layout", "Small window" and "Interaction states":
  - The search field with match hints and `match` highlighting is not here (rows do that); Enter / ⇧Enter call `controller.enter`.
  - `#` toggle (`aria-pressed`, `aria-expanded`, `aria-controls`).
  - Sort and Edit-style as Park `SegmentGroup` (`role=radiogroup`), going icon-only in compact mode.
  - Preview indicator / `previewPill` when on.
  - Lock, Lock all, Trash and Settings icon buttons with Park `Tooltip` (500 ms) showing the label + live binding (`formatBinding`).
  - In folded mode, Sort, Edit style, Lock, Lock all and Trash move into a Park `Menu` ⋯ (radio items + items with shortcuts).
  - macOS: `data-tauri-drag-region` on the header and 80 px left padding (`store.isMac`).
- [ ] **Step 5:** Run `pnpm test && pnpm build` and the WebKit smoke at widths 1000, 800 and 640 (screenshots).
- [ ] **Step 6:** Commit: `feat(ui): header with responsive modes, tooltips and overflow menu`.

### Task 10: Note list

**Files:**
- Create: `src/ui/NoteList.tsx`, `src/ui/HighlightedText.tsx`

**Interfaces:**
- Consumes: `controller.row(i)`, `store.{listVersion, count, hasMore, sel, listActive, layout, fontSize, query}`, `controller.select / ensureRows / openContextMenu`, `rowHeight` (Task 1), `visibleRange` (`list.ts`), `highlightRanges` (Task 5), recipe `listRow` / `searchMatch`, `ago` (`list.ts`).
- Produces:
  - A fixed-height virtual list: `role=listbox`, rows `role=option` with `aria-selected` and a roving tabindex.
  - Compact rows in vertical layout, two-line in horizontal.
  - Locked rows show a lock glyph + title; the two-line snippet reads "Locked".
  - A "Loading…" row with a spinner when `hasMore`, which pages in via `ensureRows` within 50 rows of the end.
  - An empty state when `count === 0 && query`: "No notes match “<query>”" / "Press ⇧↩ to create a note with that title" / "or Esc to clear the search" (glyphs per platform).
  - `data-active` from `listActive`; right-click → `openContextMenu(i)`; click → `select(i)`.
  - The list scrolls the selected row into view when `sel` changes.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `pnpm build`, then the WebKit smoke:
  - The stub returns 40 rows, with a search for "note" highlighting "Note".
  - Scroll to the end → the loader shows, then disappears when `has_more` is false.
  - Both layouts, light and dark; screenshots.
- [ ] **Step 3:** Commit: `feat(ui): virtual note list with highlighting and empty state`.

### Task 11: Note pane: title bar, banners, divider, tag panel, filter line, first run

**Files:**
- Create: `src/ui/TitleBar.tsx`, `src/ui/ConflictBanner.tsx`, `src/ui/PreviewStrip.tsx`, `src/ui/Divider.tsx`, `src/ui/TagPanel.tsx`, `src/ui/FilterLine.tsx`, `src/ui/FirstRun.tsx`
- Modify: `src/divider.ts` (keyboard step = row height, Shift ×10; keep `clampSize`), `src/divider.test.ts`

**Interfaces:**
- **Title bar:** title, or the inline rename input with the hint "↩ Rename · Esc Cancel" (calls `commitRename`).
  - Status (`role=status`): spinner + "Saving…" when `saving`; "Indexing… 3,200 / 10,004" + a 64 px progress bar when `indexing`.
  - Error (`role=alert`, `velo.danger`, alert icon) with a Retry button (outline sm → `retrySave`) when the error came from a save.
  - The title truncates before the status; double-click starts rename.
  - In vertical layout the title bar is a drag handle for the divider (as in 0.3.0).
- **Conflict banner:** "This file changed on disk. Your edits were saved to " + a link (conflict note title → `openConflict`) + dismiss × (`dismissConflict`).
- **Preview strip:** "Preview — read only · <binding> to edit" (30 px). The empty-note watermark text stays from `preview.ts`.
- **Divider:** `role=separator`, `aria-orientation`, `aria-valuenow`, `tabindex=0`; reuses `mountDivider`'s logic (drag, double-click reset, localStorage per layout). Keys: ↑/↓/←/→ move one row height; Shift moves ten.
- **Tag panel:** "Tags · N selected · <total> notes", Clear (ghost sm), "<binding> close"; chips (`tagChip`, `aria-pressed`) wrap. Keyboard: Tab enters the group; ←/→ move; Space toggles; Esc closes and returns focus to search.
- **Filter line** (panel closed, filter active): `banner({ tone: "filter" })`, "Filtered by **#a** **#b** · Clear" + "<total> notes" on the right.
- **First run** (`phase === "setup"`): app mark, "Choose a notes folder", one sentence, a primary lg "Choose folder… ↩" button focused by default (→ `chooseFolder`), and "You can change it later in Settings (<binding>)".

- [ ] **Step 1:** Divider test: `nudge(size, key, shift, rowH)` returns `size ± rowH` or `± 10·rowH` (pure helper exported from `divider.ts`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the helper, then the components.
- [ ] **Step 4:** Run `pnpm test && pnpm build`, then the WebKit smoke: rename via double-click; a conflict banner (stub `save_note` returns a conflict); the tag panel keyboard; the filter line; first run (stub `get_settings` with `notes_dir: null`).
- [ ] **Step 5:** Commit: `feat(ui): title bar, banners, divider, tag panel, filter line, first run`.

### Task 12: Dialogs: Settings and Passphrase

**Files:**
- Create: `src/ui/SettingsDialog.tsx`, `src/ui/PassphraseDialog.tsx`, `src/ui/settingsModel.ts`, `src/ui/settingsModel.test.ts`
- Modify: `src/passphrase.ts` (remove the DOM `askPassphrase`; keep `isLockedPath` and `passphraseError`, update the `passphraseDialogMode` copy to spec §6), `src/dialogs.test.ts`

**Interfaces:**
- Produces: `conflictsOf(draft: Record<Action, string>): Partial<Record<Action, Action>>`. It maps each action whose binding equals another action's (excluding `"none"`) to the *other* action. Example: back = forward = Mod+KeyK → `{ back: "forward", forward: "back" }`.
- **Settings (Park `Dialog`, 640 px; Park `Tabs` General / Keyboard shortcuts with ←/→):**
  - **General:**
    - Notes folder (read-only input + "Change…").
    - Layout `SegmentGroup` + the binding hint.
    - Theme `SegmentGroup` System / Light / Dark.
    - Font size (number 10–32, "px" helper).
    - Sort (Park `Select`).
  - **Shortcuts:**
    - A hint line + "Reset all".
    - Table rows: Action | `keyCap` button (click → recording; uses `recorderStep`; Esc cancels; ⌫ clears to "none"; refused keys show their message) | Reset (disabled at default).
    - A blue dot when changed.
    - A conflict row turns red with "Already used by <LABEL>". The tab shows a red count badge.
  - **Footer:**
    - "N conflict(s) — fix it to save" + Cancel / Save. ⌘↩ saves.
    - Save is disabled while conflicts exist and while a save is in flight.
  - Calls `controller.saveSettings(next)` and shows the returned message.
- **Passphrase (Park `Dialog`, 420 px, icon tile):** `PassphraseDialog` implements `UiPort.passphrase`.
  - **Create:**
    - Title "Create your velo passphrase".
    - Subtitle "Needed once to lock “<note>”" or "Needed once to lock all notes".
    - Warning "It can't be recovered if you forget it.".
    - Fields passphrase + confirm; error "Passphrases don't match"; buttons Cancel / "Create & lock".
  - **Unlock:**
    - Title "Enter your velo passphrase".
    - Copy "This computer doesn't have your velo key yet.".
    - Error "Wrong passphrase — try again" (`role=alert`); buttons Cancel / Unlock.
  - Inputs are cleared as soon as the value is read (as in 0.3.0).

- [ ] **Step 1:** Tests: the `conflictsOf` example above; "none" is never a conflict; no conflicts for `DEFAULTS`; `passphraseError` copy updated ("Passphrases don't match"); `passphraseDialogMode` titles per §6.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the model and the dialogs.
  - The draft may hold conflicts: `validateBinding`'s "already used" result no longer refuses, but reserved, needs-a-modifier and fixed-key refusals still do.
  - While recording, the dialog owns the keys (capture listener as in 0.3.0).
- [ ] **Step 4:** Run `pnpm test && pnpm build`, then the WebKit smoke: open Settings, record a conflicting key → red row + Save disabled; ⌫ → "—"; passphrase create mismatch.
- [ ] **Step 5:** Commit: `feat(ui): Settings and Passphrase dialogs`.

### Task 13: Editor and preview styling

**Files:**
- Modify: `src/editortheme.ts`, `src/richmd.ts` (theme only), `src/styles.css` → move the preview styles into Panda `globalCss` (`src/theme/editor-css.ts`, ported from `design/park-ui/panda/editor-styles.ts`)

**Interfaces:**
- Consumes: `velo.*` tokens as CSS variables (`var(--colors-velo-accent-text)` etc., the names generated by Panda; check `styled-system/tokens`), plus `--velo-editor-fs`.
- Produces:
  - Reading column max `46em`, line-height 1.7, editor size `var(--velo-editor-fs)`.
  - Plain marks in `velo.mark`.
  - Rich classes styled per the README mapping table (`.cm-rich-tag` → md-tag …).
  - Preview (`#preview`) with the same typography; alerts, tables, footnotes and tasks keep working.
  - The fonts: Inter for UI and writing, JetBrains Mono for code.

- [ ] **Step 1:** Implement. Remove the colour variables from `styles.css` that the new theme replaces. `styles.css` is deleted in Task 14; until then the old UI may look off, which is acceptable on this branch.
- [ ] **Step 2:** Run `pnpm test && pnpm build`, then the WebKit smoke: the GFM sample note (tasks, alert, table, footnote) in Rich, Plain and Preview, light and dark; screenshots. Check contrast against the README table.
- [ ] **Step 3:** Commit: `feat(ui): editor and preview typography from the design`.

### Task 14: Switch-over

**Files:**
- Modify: `index.html` (React root only), `vite.config.ts` (single input), `src-tauri/tauri.conf.json` (`titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition: {x: 16, y: 24}`, `minWidth: 600`, `minHeight: 400`), `src-tauri/capabilities/default.json` (`core:window:allow-start-dragging`), `README.md`, `AGENTS.md` (note the stack), `.changeset/react-park-ui.md`
- Delete: `src/main.ts`, `src/list.ts`'s `mountList` (keep `visibleRange`, `Results`, `ago`), `src/styles.css`, `app.html`, `src/divider.ts`'s DOM-only parts that are no longer used, the old `#pp` / `#settings` markup

**Interfaces:**
- Produces: velo running the React UI as its only UI.

- [ ] **Step 1:** Switch the entry and delete the dead code; fix imports.
- [ ] **Step 2:** Add the changeset (minor): "velo has a new look: …". One past-tense paragraph naming the redesign, note counts, search-match highlighting, clearable shortcuts, Retry on save errors, and the clearer passphrase dialogs.
- [ ] **Step 3:** Run `pnpm test && pnpm build && (cd src-tauri && cargo test)` plus the perf test. Expected: all green; p95 < 50 ms.
- [ ] **Step 4:** WebKit smoke over the whole §4 checklist that the stub can exercise; record anything only the owner can check in the ledger.
- [ ] **Step 5:** Commit: `feat: switch velo to the React + Park UI interface`.
