# Connections view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** velo shows the notes one hop around the open note: links out, backlinks (alias-aware), notes sharing a tag, and unlinked mentions. It offers Ring and time-axis layouts, one-click **Link it**, and a **No links** filter for orphans. Agents get the same data through the MCP tool `get_connections` (and link mentions with the existing `edit_note`), and find orphans with `search_notes(no_links)`.

**Architecture:**
- **One Rust function** builds the graph: `connections::build(index, unlocked, path, text) -> Connections`, reached through `Vault::connections(path)`.
  - The Tauri command `connections` calls it.
  - The MCP tool `get_connections` calls it through `NoteOps::connections`. `VaultOps` implements that (headless direct mode, and the app's vault through `AppOps::with`), so forwarded and direct calls run the same code.
- **One mention matcher** in `text.rs` serves both the graph's mentions and Link it's rewrite.
- **Index:** no schema change. It adds queries over the existing `notes`, `links`, `tags` and `aliases` tables: alias-aware backlinks, names for mention matching, notes per tag, and a `no_links` flag on `search_page`.
- **Writes:** only Link it writes. When the centre is open in the editor, the rewrite goes through the editor (existing `Editor.applyChange` + `changedSpan`). Otherwise the command saves it through `Vault::save_note`.
- **Frontend:** a third `paneMode`, `"connections"`. Layouts are pure TS functions, rendered as SVG by React. No graph library.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19 + Park UI + Panda CSS 1.12.1, CodeMirror 6, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-27-velo-connections-design.md` (amended 2026-10-29: section 9 MCP, section 14 changes)

## Global Constraints

- **Dependencies:** none new, in `package.json` or `Cargo.toml`.
- **Schema:** unchanged. `SCHEMA_VERSION` stays 6, so no reindex.
- **Resolution:** a wikilink target matches a note's folded title (`text::fold`) or a folded alias. Unresolvable links are never drawn or counted.
  - Rename and `backlink_count` stay title-only: rename rewrites only `[[Old title]]`.
- **One hop.** Tag groups with more than 15 notes carry `count` and an empty `notes` list.
- **Mentions:**
  - only from the centre's own text, after front matter;
  - folded, on whole words;
  - names shorter than 3 characters are ignored;
  - text inside fenced, indented and inline code and inside `[[…]]` / `[…](…)` never counts. These are the same scanner rules `remove_inline_tag` uses.
- **Locked notes:**
  - **UI:** a locked note appears as a node, by filename title, when others link to it. Its own links, tags and mentions come from the unlocked map only. A locked centre that is not unlocked gives `Err("locked")`.
  - **MCP:** a locked centre is `not found` (existing `path_of`). Every node with `ops::locked(path)` is dropped from every group in `VaultOps::connections`.
- **Link it:** `link_mention(path, target_title, expected_count, editor_text: Option<String>)`.
  - A count mismatch gives `Err("mention-moved")`; a locked path gives `Err("locked")`.
  - Only the first match is wrapped, as written: `Velo roadmap` becomes `[[Velo roadmap]]`.
- **Shortcut:** `toggle_connections` = `Mod+Shift+KeyC`.
- **Setting:** `connections_sort`: `"ring"` (default) | `"created"` | `"updated"`.
- **Perf:** `Vault::connections` < 50 ms at 10k notes (local `--ignored` perf test).
- **Quality gate**, at the end of every task (CONTRIBUTING #1): `pnpm exec tsc --noEmit && pnpm test && (cd src-tauri && cargo test)`. Also run `pnpm build` when frontend files changed.
- **Workflow:** AGENTS.md / CONTRIBUTING.md: branch `feat/connections`, gate table per task, changeset (minor), PR with adversarial review.

## Review Focus

1. **Locked leak through MCP.** In app mode, `get_connections` on a plain note linked to and from an unlocked `*.md.age` returns no trace of it: no title, no tag group entry, no mention. Test in Task 5 (`AppOps`) and Task 3 (direct).
2. **One implementation.** The Tauri command and the MCP tool both reach `connections::build`; there is no second graph or mention code path. Check in review with grep: `find_mentions` has exactly two callers, `build` and `link_mention_text`.
3. **Link it versus the editor.** Link it on the centre while it is open with unsaved edits makes no conflict copy, keeps the typed text, and ⌘Z undoes only the link. Test in Task 9 (controller).
4. **Alias resolution scope.** `[[Nick]]` counts in the graph, the info panel, the orphan filter and `read_note` backlinks. Rename's link count and rewrite stay title-only. Test in Task 1.
5. **Matcher edge cases.** Code spans, existing links, front matter, CRLF, non-ASCII titles, and overlapping names (`Velo` and `Velo roadmap`: longest wins). Test in Task 2.

---

### Task 1: Index queries (alias-aware backlinks, names, tag notes, node metadata)

**Files:**
- Modify: `src-tauri/src/index.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (handler list), `src-tauri/src/agent/ops.rs` (`backlinks`)

**Interfaces — Produces:**
- `Index::linked_from(&self, path: &str) -> anyhow::Result<Vec<String>>`: distinct sources whose `dst_folded` is the note's `title_folded` or one of its `aliases.alias_folded`, ordered, the note itself excluded. One `UNION` query.
- `Index::names(&self) -> anyhow::Result<Vec<(String, String)>>`: `(folded name, path)` for every title and alias (`SELECT title_folded, path FROM notes UNION ALL SELECT alias_folded, path FROM aliases`).
- `Index::tag_notes(&self, tag_folded: &str, limit: usize) -> anyhow::Result<(usize, Vec<String>)>`: the count of notes with the tag, and up to `limit` paths.
- `Index::node(&self, path: &str) -> anyhow::Result<Option<NodeRow>>`, where `NodeRow { title, created, modified, preview, encrypted }`.
- `Vault::linked_from_count(&self, path: &str) -> anyhow::Result<usize>`, and the Tauri command `linked_from_count(path) -> usize`.
- `VaultOps::backlinks` (agent) switches to `linked_from` on the resolved path; the `NoteOps::backlinks(title)` signature becomes `backlinks(path)`. `read_note` passes `doc.path`.
- `backlink_count` and `rename_note` are unchanged.

- [ ] **Step 1: Write failing tests** (inline in `index.rs` unless noted):
  - `linked_from_resolves_aliases`: `Nick.md` has front matter `aliases: [Nicholas]`, `a.md` links `[[Nicholas]]`, `b.md` links `[[nick]]`. Then `linked_from("Nick.md") == ["a.md", "b.md"]`, and `backlinks("Nick") == ["b.md"]` (title-only, unchanged).
  - `linked_from_skips_self_and_unresolved`: `Nick.md` contains `[[Nick]]` → `[]`.
  - `names_lists_titles_and_aliases`: contains `("nick", "Nick.md")` and `("nicholas", "Nick.md")`.
  - `tag_notes_counts_and_limits`: 20 notes tagged `#big` → `tag_notes("big", 16)` gives `(20, 16 paths)`.
  - `vault.rs`: `rename_count_stays_title_only`: `backlink_count("Nick") == 1` while `linked_from_count("Nick.md") == 2`.
  - `agent/tools.rs`: `read_note_backlinks_include_alias_links`: `read_note("Nick")["backlinks"] == ["a", "b"]`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Register `linked_from_count` in `lib.rs`.
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): alias-aware backlinks and graph index queries`.

### Task 2: Mention matcher and link rewrite (`text.rs`)

**Files:**
- Modify: `src-tauri/src/text.rs`

**Interfaces — Produces:**
- `pub struct MentionHit { pub name_folded: String, pub as_written: String, pub start: usize, pub end: usize }`: byte offsets into the text passed in.
- `pub fn find_mentions(body: &str, names: &HashSet<String>, max_words: usize) -> Vec<MentionHit>`.
  - Scans prose words using the scanner rules of `remove_inline_tag`, extracting that scanner into a shared private iterator if needed; `remove_inline_tag`'s tests must stay green.
  - At each word start, it tries the longest run of up to `max_words` words whose fold is in `names`. Matches never overlap.
  - Names under 3 characters are skipped.
- `pub fn link_mention_text(full_text: &str, name: &str, expected: usize) -> Result<String, &'static str>`.
  - It runs `find_mentions` over `frontmatter::body(full_text)`, keeping the hits where `name_folded == fold(name)`.
  - If the hit count is not `expected`, it returns `Err("mention-moved")`.
  - Otherwise it wraps the first hit as `[[as_written]]`, at its offset shifted by the front-matter length. Every other byte, CRLF included, is unchanged.

- [ ] **Step 1: Write failing tests:**
  - `mentions_whole_words_folded`: body `"Read velo Roadmap; velociraptor."` with names `{"velo roadmap", "velo"}` → one hit, `as_written == "velo Roadmap"`. `velociraptor` doesn't match.
  - `mentions_skip_code_links_and_short_names`: body ``"`Velo` [[Velo]] [x](Velo) ```\nVelo\n``` ab Velo"`` with names `{"velo", "ab"}` → one hit, the last `Velo`.
  - `mentions_non_ascii`: `"Résumé"` matches the name `fold("resume")`.
  - `link_mention_wraps_first_and_checks_count`: `"---\ntags: [x]\n---\nsee Nick and nick\r\n"` with `("Nick", 2)` → `"---\ntags: [x]\n---\nsee [[Nick]] and nick\r\n"`. With `("Nick", 1)` → `Err("mention-moved")`.
  - `link_mention_ignores_front_matter`: a name that appears only in front matter → `Err("mention-moved")` with `expected = 1`.
- [ ] **Step 2: Run** `cargo test text::`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): mention matcher shared by graph and Link it`.

### Task 3: `connections::build`, `Vault::connections`, Tauri command, perf

**Files:**
- Create: `src-tauri/src/connections.rs` (add `pub mod connections;` to `lib.rs`)
- Modify: `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/perf.rs`

**Interfaces:**
- Consumes: Task 1 queries, `find_mentions` (Task 2), `text::extract_links`, `index::all_tags`, `Index::find_titles`, `frontmatter::{parse, body}`.
- Produces (all `#[derive(Serialize)]`, snake_case fields like the existing `TaskView`):
  - `Node { path, title, created: i64, modified: i64, preview: String, locked: bool }`
  - `TagGroup { tag: String, count: usize, notes: Vec<Node> }`; `notes` is empty when `count > TAG_MAX`, where `TAG_MAX = 15`.
  - `Mention { node: Node, name: String, count: usize }`
  - `Connections { centre: Node, links_out: Vec<Node>, links_in: Vec<Node>, tags: Vec<TagGroup>, mentions: Vec<Mention> }`
  - `pub fn build(index: &Index, unlocked: &HashMap<String, String>, path: &str, text: &str) -> anyhow::Result<Connections>`
    - `links_out`: `extract_links(body(text))`, resolved with `find_titles`, deduplicated, centre excluded.
    - `links_in`: `index.linked_from(path)`, plus unlocked notes whose `extract_links` resolve to the centre.
    - `tags`: `all_tags(body, fm)` of the centre. Each group's members are `index.tag_notes(tag, TAG_MAX + 1)` plus unlocked notes carrying the tag, centre excluded.
    - `mentions`: `find_mentions` over the body, with names from `index.names()`. Notes already in `links_out` are excluded, and so is the centre. Hits are grouped per target note: one `Mention` per note, with `name` the first spelling seen and `count` that spelling's hits.
    - Each group is sorted by `modified` descending.
  - `Vault::connections(&self, path: &str) -> anyhow::Result<Connections>`. The text comes from the unlocked map, else from disk for plain notes. An encrypted path that is not unlocked gives `Err("locked")`.
  - Tauri command `connections(path) -> Connections`, through `with_vault`.

- [ ] **Step 1: Write failing tests** (inline in `connections.rs`, over a temp `Vault`):
  - `one_hop_groups`: C links `[[A]]`, B links `[[C]]`, C and D share `#t`, C's text mentions `Delta` (the title of D2). Expect `links_out == [A]`, `links_in == [B]`, `tags[0].tag == "t"` with notes `[D]`, `mentions == [{D2, "Delta", 1}]`.
  - `alias_link_is_a_backlink`: `[[Nick]]` from B to `Nicholas.md` (alias Nick) → B in `links_in`.
  - `big_tag_collapses`: 17 other notes share `#big` → `count == 17` (others only, centre excluded), `notes.is_empty()`.
  - `linked_note_is_not_a_mention`: C has both `[[A]]` and plain `A…` → A is in `links_out` only.
  - `locked_centre_refused_until_unlocked`: `Vault::connections` on `L.md.age` with no identity → `Err("locked")`. With the vault opened with the identity (unlocked), its links come from memory.
  - `locked_neighbour_is_a_node_without_its_links`: `L.md.age` (locked, not unlocked) linked from C → it appears in `links_out` with `locked: true`. Its own `[[C]]` (ciphertext) never shows in C's `links_in`.
- [ ] **Step 2:** Add `connections_under_50ms` (`#[ignore]`) to `tests/perf.rs`: over the existing 10k seed, the p95 of `Vault::connections` on 50 random notes is < 50 ms.
- [ ] **Step 3: Run** `cargo test connections::`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the gate, plus `cargo test --release --test perf -- --ignored connections_under_50ms`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(connections): one-hop graph builder and command`.

### Task 4: `link_mention` command

**Files:**
- Modify: `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces — Produces:**
- `Vault::link_mention(&mut self, path: &str, target: &str, expected: usize, editor_text: Option<&str>, write_fm: bool) -> anyhow::Result<Option<String>>`. The path is refused (`Err("locked")`) when encrypted or a plain twin.
  - `Some(text)` given: returns `Some(link_mention_text(text, …))` and writes nothing.
  - `None`: opens the note, rewrites the text, and saves through `save_note` with the read hash. It returns `None`. A save conflict surfaces as the existing conflict result (an error string `conflict`), never as a lost write.
- Tauri command `link_mention(path, target_title, expected_count, editor_text: Option<String>) -> Option<String>`.

- [ ] **Step 1: Write failing tests** (`vault.rs`):
  - `link_mention_saves_when_not_open`: the file goes from `see Nick` to `see [[Nick]]`, and the index now has the link (`linked_from` of Nick lists it).
  - `link_mention_with_editor_text_writes_nothing`: returns the rewritten text, and the file bytes are unchanged.
  - `link_mention_count_mismatch`: `Err` with the text `mention-moved`, file unchanged.
  - `link_mention_refuses_locked`: `Err("locked")` for `L.md.age`, even while unlocked.
- [ ] **Step 2: Run** `cargo test link_mention`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): link_mention command`.

### Task 5: MCP tool `get_connections`

**Files:**
- Modify: `src-tauri/src/agent/ops.rs` (trait + `VaultOps`), `src-tauri/src/agent/app_ops.rs`, `src-tauri/src/agent/tools.rs`, `src-tauri/src/agent/mod.rs` (test only)

**Interfaces — Produces:**
- `NoteOps::connections(&self, path: &str) -> anyhow::Result<Connections>`.
  - `VaultOps`: `plain(path)?`, then `self.vault.connections(path)`. It then drops every `Node` with `locked(&node.path)` from `links_out`, `links_in`, each `TagGroup.notes` and `mentions`.
  - A filtered tag group keeps `count` as the index gives it. Shortcut: a plain twin of a locked note may count in a collapsed (>15) tag group; acceptable because only a number leaves, no title.
  - `AppOps`: `self.with(|o| o.connections(path))`.
- `ToolSpec { name: "get_connections", … }` with input schema `{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}`.
  - Description: "Notes one hop around a note: outgoing [[links]], backlinks (alias links included), notes sharing each tag (tags on more than 15 notes give only the count), and unlinked mentions (titles or aliases in this note's text without [[ ]]). To link a mention, read_note then edit_note wrapping the words in [[ ]]."
- The `"get_connections"` arm in `tools::call` uses `path_of`, then `ops.connections`. Its result is `{title, created, modified, links_out: [{title, created, modified}], links_in: [...], tags: [{tag, count, titles}], mentions: [{title, name, count}]}`, with dates through `iso()` and no paths.
- It is not added to `is_write`.

- [ ] **Step 1: Write failing tests:**
  - `tools.rs`, `get_connections_returns_titles_not_paths`: the Task 3 `one_hop_groups` vault via `vault(…)`. Expect the fields above, `links_out[0]["title"] == "A"`, and no `"path"` key anywhere in the JSON (walk the whole value).
  - `tools.rs`, `get_connections_unknown_or_locked_is_not_found`: a missing title and the title of `L.md.age` both → `Err("not found")`.
  - `tools.rs`, `get_connections_needs_no_summary`: the call succeeds without `summary`.
  - `app_ops.rs`, `get_connections_hides_unlocked_locked_notes`: with `state()` (P links `[[L]]`, unlocked L links `[[P]]`), `tools::call(&mut AppOps::new(&st, &never), "get_connections", {"title": "P"})` → `links_out` and `links_in` are empty, and `serde_json::to_string(&r)` contains neither `"L"` nor `"secret"`.
  - `app_ops.rs`, `get_connections_runs_the_same_builder_in_app_mode`: the same vault through `AppOps` and through `DirectOps` gives equal JSON for a plain-only vault.
  - `mod.rs`, `gate_routes_get_connections`: `get_connections` on a direct vault returns `links_out` (proves it is in `TOOL_SPECS` and passes the gate). With `fake_app` running, it returns `{"fake": "get_connections"}`.
- [ ] **Step 2: Run** `cargo test agent::`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): get_connections tool`.

### Task 6: Orphan filter (backend and `search_notes(no_links)`)

**Files:**
- Modify: `src-tauri/src/index.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/agent/ops.rs`, `src-tauri/src/agent/app_ops.rs`, `src-tauri/src/agent/tools.rs`

**Interfaces — Produces:**
- `Index::search_page_where(&self, query, sort, offset, limit, tags, unlocked, no_links: bool) -> anyhow::Result<Page>`. The existing `search_page` becomes a one-line call with `no_links = false`, which keeps its ~30 test call sites unchanged.
  - With `no_links`, each SQL branch adds `n.encrypted = 0`, and the unlocked map is not merged.
  - It also adds `NOT EXISTS` (an outgoing link resolving to a title or alias) and `NOT EXISTS` (an incoming link to `title_folded` or an alias of the note).
- `Vault::search_where(…, no_links)`, with `Vault::search` delegating to it in the same way.
- The Tauri `search` command gains `no_links: bool`.
- MCP: `NoteOps::search(&self, query, tags, offset, no_links: bool)`.
  - `VaultOps::search` calls `vault.search_where(…, no_links)`, keeping its locked filtering; `AppOps` passes it through.
  - The `search_notes` schema gains `"no_links":{"type":"boolean"}`.
  - The description gains: "`no_links` true keeps only notes with no [[links]] in or out (orphans; alias links count)."

- [ ] **Step 1: Write failing tests** (`index.rs`):
  - `no_links_lists_orphans_only`: in `a.md` → `[[B]]`, `B.md`, `c.md`, `Nick.md` (alias Nicholas), `d.md` → `[[Nicholas]]`, `e.md` → `[[Missing]]`. `no_links` gives `["c.md", "e.md"]`: a link to a missing note doesn't count.
  - `no_links_excludes_locked_and_respects_tags_and_total`: encrypted rows never appear. `total` matches the listed rows. A tag filter still applies.
  - `agent/tools.rs`, `search_notes_no_links_lists_orphans`: in a vault with `a.md` → `[[B]]`, `B.md`, `c.md`, and a locked `s.md.age`, `search_notes({no_links: true})` titles are `["c"]`. Without the flag, the titles are all three plain notes.
- [ ] **Step 2: Run** `cargo test no_links`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): No links filter query and search_notes(no_links)`.

### Task 7: Frontend wiring (mode, shortcut, setting, API, info panel)

**Files:**
- Modify: `src/api.ts`, `src/app/ports.ts`, `src/app/fakes.ts`, `src/app/store.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/shortcuts.ts`, `src/shortcuts.test.ts`, `src/ui/Header.tsx`, `src/ui/SettingsDialog.tsx`, `src-tauri/src/settings.rs`

**Interfaces — Produces:**
- `api.connections(path)`, `api.linkMention(path, target, count, editorText | null)`, `api.linkedFromCount(path)`. `api.search` gains `noLinks`. The TS types `Connections`, `GraphNode`, `TagGroup`, `Mention` mirror the Rust ones.
- Settings: `connections_sort: String` (serde default `"ring"`; unknown values read as `"ring"`).
- Store: `paneMode: "notes" | "tasks" | "connections"`, plus `connections: { centre: string; data: Connections | null; err: string } | null`.
- Controller:
  - `showConnections()`: requires an open note. It flushes the editor, sets the centre to `openPath`, and loads.
  - `openFromGraph(path)`: the normal open; the centre is unchanged.
  - `recentre(path)`.
  - `setConnectionsSort(sort)`: persists the setting.
  - Refresh (my call): on show, on re-centre, and after Link it. Not on every keystroke.
  - Esc in the view returns to `"notes"`.
- Action `toggle_connections` (default `Mod+Shift+KeyC`, label "Connections"). A third segment in the Header's "Left pane" switch (a `lucide-react` icon, e.g. `Network`), disabled with no open note.
- The info panel's "Linked from" uses `linkedFromCount(openPath)`. The rename dialog keeps `backlinkCount`.

- [ ] **Step 1: Write failing tests:**
  - Controller:
    - `toggle_connections opens the view centred on the open note`: `api.connections` is called with `openPath`, after the flush.
    - `toggle_connections without an open note does nothing`.
    - `openFromGraph keeps the centre`: the open note changes, `connections.centre` doesn't, and `api.connections` is not called again.
    - `recentre reloads on the new centre`.
    - `locked centre shows Note is locked`: `api.connections` rejects `"locked"` → `connections.err === "Note is locked"`.
    - `info panel counts alias backlinks`: `linkedFromCount` is called with the path, and `backlinkCount` is not called.
  - Shortcuts: `toggle_connections defaults to Mod+Shift+KeyC and does not clash`: the existing clash check passes over all defaults.
  - Rust `settings.rs`: `connections_sort_defaults_to_ring`, including for a bad value.
- [ ] **Step 2: Run** `pnpm test && (cd src-tauri && cargo test settings::)`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate** + `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): Connections pane mode, shortcut and setting`.

### Task 8: Layouts and the SVG view

**Files:**
- Create: `src/connections.ts`, `src/connections.test.ts`, `src/ui/ConnectionsView.tsx`
- Modify: `src/ui/App.tsx` (render the view when `paneMode === "connections"`)

**Interfaces — Produces:**
- `type Placed = { key: string; node: GraphNode; kind: "centre" | "out" | "in" | "tag" | "mention"; x: number; y: number }`.
  - Tag groups place a tag node (`key: "#tag"`) plus its notes. A collapsed group places only the tag node, labelled `+N`.
- `ringLayout(c: Connections, w: number, h: number): Placed[]`. The centre is at `(w/2, h/2)`; the others are evenly spaced on one circle, in group order out, in, tags, mentions, each group by modified descending.
- `timeLayout(c: Connections, key: "created" | "modified", w: number, h: number): Placed[]`. `x` is linear in the date between the min and max dates, with padding. Nodes on the same day stack into rows, and the centre is included.
- `tabOrder(placed: Placed[]): string[]` (keys in the current sort's order).
- `ConnectionsView`:
  - SVG edges: solid with an arrowhead for links (direction out/in), centre–tag–note for tags, faint dashed for mentions.
  - Nodes are focusable `<g role="button" tabIndex={0} aria-label="{title}, {kind}, {date}">`.
  - Click opens (`openFromGraph`); double-click or ⇧↩ re-centres; ↩ opens; Esc returns to Notes. Clicking a collapsed tag node calls `controller.setTags([tag])` and switches to Notes.
  - The hover card shows title, created, modified and `preview`.
  - A Ring | Created | Updated `SegmentGroup` sits in the view's top row.
  - Styling uses velo's Panda tokens only.

- [ ] **Step 1: Write failing tests** (`connections.test.ts`):
  - `ring puts centre in the middle and others on one circle`: every non-centre point is the same distance (±0.5) from `(w/2, h/2)`, and none lies outside `[0, w] × [0, h]`.
  - `ring groups by kind in order`: the kinds sequence is `out…, in…, tag…, mention…`.
  - `collapsed tag places only its node`: a group with `count 17` and empty notes gives one `#tag` placed node labelled `+17`.
  - `time layout orders by date and stacks same-day nodes`: a later date has a larger `x`; two nodes on the same day share `x` and differ in `y`.
  - `time layout with one date fits the pane`: all dates equal → every `x` is within bounds (no divide by zero).
  - `tabOrder follows the sort`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate** + `pnpm build`. Then run `pnpm tauri dev` against a scratch notes folder (never the user's vault) and check both layouts by eye.
- [ ] **Step 5: Commit** `feat(connections): ring and time layouts, SVG view`.

### Task 9: Link it (UI) and the No links chip

**Files:**
- Modify: `src/app/controller.ts`, `src/app/controller.test.ts`, `src/ui/ConnectionsView.tsx`, `src/ui/FilterLine.tsx` or `src/ui/TagPanel.tsx` (chip), `src/app/store.ts`

**Interfaces — Produces:**
- `controller.linkMention(m: Mention)`:
  - **Centre open in the editor and writable:** `next = await api.linkMention(centre, m.name, m.count, editor.getText())`, then `editor.applyChange(changedSpan(editor.getText(), next))`. Autosave persists it.
  - **Centre not open:** `await api.linkMention(centre, m.name, m.count, null)`.
  - Either way it refreshes the graph.
  - On `mention-moved` it refreshes and shows nothing else. Other errors go to `connections.err`.
- It is offered on hover of a mention edge and in a node's context menu (existing `contextmenu.ts`), never for a locked centre.
- Store `noLinks: boolean`, plus a **No links** chip beside the tag filter. Toggling it reloads the Notes list with `api.search(…, noLinks)`, and the filter line shows it the way it shows tags.

- [ ] **Step 1: Write failing controller tests:**
  - `link it on the open centre goes through the editor`: the editor is dirty with typed text. `api.linkMention` is called with the editor's text, `editor.applyChange` gets the span that wraps the name, no `saveNote` happens beyond autosave, and the typed text is kept. Covers Review Focus 3.
  - `link it on a closed centre calls the backend`: `editorText === null`, and the graph reloads.
  - `mention-moved refreshes silently`.
  - `no links chip filters the list`: `api.search` is called with `noLinks: true`, and Clear resets it.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Quality gate** + `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): Link it and No links filter`.

### Task 10: Docs, changeset, full gate

**Files:**
- Modify: `README.md`
- Create: `.changeset/connections-view.md`

- [ ] **Step 1:** README:
  - a "Connections" section: opening it, layouts, Link it, re-centre, keyboard, the No links filter, and alias links;
  - the shortcut in the table;
  - `get_connections` in the Agents (MCP) tool list, and `no_links` on `search_notes`.
- [ ] **Step 2:** Changeset:
  ```md
  ---
  "velo": minor
  ---

  Added a Connections view that showed the links, backlinks, shared tags and unlinked mentions around a note, with one-click Link it, a No links filter for orphans, and MCP support for agents to read connections and find orphans.
  ```
- [ ] **Step 3: Full quality gate** (CONTRIBUTING, all five checks): `pnpm exec tsc --noEmit`, `pnpm test`, `cd src-tauri && cargo test`, `pnpm build:app` (or `cargo build --release`), the perf test from Task 3, docs, staleness (no unused deps), and capabilities (no new plugin permissions are expected). Report it as a table.
- [ ] **Step 4: Commit** `docs(connections): README and changeset`.

### Task 11: PR and adversarial review

- [ ] **Step 1:** Push `feat/connections` and open the PR: title `feat: Connections view and MCP connection tools`, body with `## Summary` and `## Test plan`. The unticked items are the spec's owner checks (section 13).
- [ ] **Step 2:** Run the adversarial review per CONTRIBUTING. The attack list must cover:
  - every path that could leak a locked note's title, tags or text through `get_connections`, in app mode (unlocked map) and direct mode (plain twin);
  - every writer to a note during Link it (editor, autosave, the backend save, the watcher reload, an MCP `edit_note` arriving at the same time);
  - matcher inputs: code, links, front matter, CRLF, non-ASCII, overlapping names;
  - alias resolution versus rename.
- [ ] **Step 3:** Fix findings with regression tests and follow the strike rule. Reply to bot comments. Merging needs the maintainer's go-ahead (`--admin`).
