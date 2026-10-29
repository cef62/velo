# velo — Connections view design

Requested by Matteo. He wants to see how a note relates to others and move through those relations:
- what is around a note;
- how a topic evolved;
- which notes are orphans.

The whole-vault "big picture" was also asked for, and deferred (section 1). Decisions below are his unless marked **(my call)**. This is Project 2 of 4, designed in parallel with Project 1 (Tasks). A ponytail audit of this design was applied: findings 1, 2, 6 and 10.

**Amended 2026-10-29** for MCP support (section 9, owner request: "ensure it considers support for the MCP server") and a smallest-solution pass against the code that shipped since (Tasks, MCP). Changes are listed in section 14.

## 1. Why and what

- **Goal:** a graph of the notes directly around the open note, which you read and navigate. Clicking a note opens it in the editor while the graph stays put.
- **Non-goals:**
  - A whole-vault map (deferred: past about 30 nodes it becomes unreadable).
  - Two-hop graphs (audit 6). Add them only if one hop proves too little in use.
  - Editing links by dragging; saved layouts; pan and zoom.
- **Anti-goals:**
  - A hairball.
  - A slow open on a 10k-note vault.
  - Writing to notes, except the explicit **Link it** action.
  - Showing locked notes' content or links while they are locked.
  - Links velo itself can't resolve (audit 1).

## 2. Opening and layout

- Action `toggle_connections`, default `Mod+Shift+KeyC`, remappable **(my call)**. ⌘G is CodeMirror's find-next.
- The view takes the left pane's place, as a third mode, **Connections**, of the Notes | Tasks switch in the header (`Header.tsx`, `paneMode`). It is available when a note is open, and the editor stays on the right.
  - The switch's third segment is the title-bar control; no separate button **(my call, 2026-10-29)**.
  - Tasks has shipped, so the switch exists.
- It is centred on the open note when opened. Clicking a node opens that note in the editor (normal flush-then-load) and leaves the graph and its centre unchanged. **Re-centre** (a node button, or double-click) makes the clicked note the new centre **(my call)**.

## 3. What is drawn (one hop)

- **Nodes:** the centre note (highlighted), the notes one hop from it, and tag nodes (`#tag`) for the centre's tags.
- **Edges:**
  - **Wikilink:** a solid line with an arrow showing direction, in both directions (links from the centre and backlinks to it).
  - **Shared tag:** centre — tag node — note, for each tag the centre note has.
  - **Mention:** a faint dashed line from the centre to a note whose title or alias appears in the **centre note's own text** without `[[ ]]` (audit 10: outgoing mentions only).
    - Titles shorter than 3 characters are ignored.
    - Matches are case-insensitive and on whole words.
    - Text inside code spans and code blocks, existing links and front matter don't count.
- **Link resolution** (audit 2): a wikilink target matches a note's folded title **or** one of its aliases. The index gets an alias-aware backlink query (one `UNION` over the `aliases` table). It serves the info panel's "Linked from N", the graph, the orphan filter and the MCP `read_note` backlinks, so `[[Nick]]` counts everywhere for a note with alias Nick.
  - **Not rename (2026-10-29):** rename rewrites only `[[Old title]]`, and alias links keep resolving after a rename. Rename and its "update N links" count (`backlink_count`) stay title-only. Making them alias-aware would snapshot notes it doesn't change and show a wrong count.
  - Outgoing links are read from the centre's text (`extract_links`) and resolved with the existing `Index::find_titles`. The index already stores links, tags, aliases and effective dates; no new table or schema bump is needed.
- **Many neighbours:** a tag node with more than 15 notes shows "+N" and does not draw them; clicking it filters the Notes list by that tag **(my call)**. Large link counts are the next limit to watch.
- **Locked notes:** shown as nodes, by filename title, when other notes link to them. Their aliases are unknown while they are locked.
  - Their own outgoing links, tags and mentions are used only while they are unlocked (memory only), never from the index. `connections` takes the unlocked map as `search_page` does.
  - A locked note can be the centre only while it is unlocked. While locked, the view shows "Note is locked".

## 4. Layout and sort (no force simulation)

- **Dates:** the effective dates already stored in the index (`notes.created` and `notes.modified`: front matter when present, else file dates). Locked notes use their file dates.
- **Sort toggle:** Ring | Created | Updated. Persisted globally (`connections_sort`).
  - **Ring:** the centre in the middle. Neighbours sit evenly on a circle around it, grouped by edge kind (links out, links in, tags, mentions), each group ordered by modified date.
  - **Created / Updated:** a horizontal time axis. Each node's x position is its date, and nodes on the same date stack in rows. The centre sits at its own date, highlighted, and a thin date axis is drawn under the nodes.
- Both layouts are computed directly (no library) and fit the pane; there is no pan or zoom.
- **Hover:** shows a card with title, created and modified dates, and the snippet line the Notes list already shows.

## 5. Link it

- Hovering a mention edge, or right-clicking a mentioning node, offers **Link it**.
- Command `link_mention(src_path, target_title, expected_count, editor_text?)`:
  - `src_path` is always the centre note, since mentions are outgoing only.
  - `expected_count` is the number of unlinked occurrences the UI saw. A mismatch is refused with `"mention-moved"`, and the view refreshes.
  - It wraps the first occurrence the matcher accepts (the same Rust function that finds mentions for the graph), keeping the words as written: `Velo roadmap` becomes `[[Velo roadmap]]`, and an alias mention `Nick` becomes `[[Nick]]` (audit 1). Matching ignores case and alias links resolve (section 3), so the link always points at the right note. No `[[Title|text]]` form: velo doesn't support it.
  - Not offered for locked notes.
  - It saves through the normal path.
  - If the note is open in the editor, the frontend sends the editor's text and gets the rewritten text back. It applies the difference as a user edit with the existing `Editor.applyChange` and `changedSpan` (both shipped with MCP), so there is one writer and ⌘Z undoes it. Otherwise the command saves the rewrite itself through `Vault::save_note`. The centre is often not the open note, because clicking a node opens it while the centre stays put.
- After it runs, the edge becomes a solid wikilink.

## 6. Orphans

- The note list gets a filter, **No links** (next to the tag filter, as a chip). It shows notes with no outgoing and no incoming wikilinks, using the alias-aware resolution. Tags don't count **(my call)**.
- It is backed by an index query, with no graph involved: a `no_links` flag on the existing `search_page`, so paging, sort, the tag filter and the count keep working.
- Links from locked notes aren't indexed, so a plain note linked only from a locked note counts as an orphan (accepted). Locked notes themselves are left out of the filter.

## 7. Backend

- **One function** builds the data: `connections::build(index, unlocked, path, text) -> Connections`, called through `Vault::connections(path)`. The Tauri command `connections(path)` and the MCP tool `get_connections` (section 9) both call it. There is no second implementation.
- **Shape (my call, 2026-10-29):** grouped by edge kind, not `{nodes, edges}`. The Ring layout groups by kind, agents read groups more easily, and an edge list would only be regrouped.
  - `Connections { centre: Node, links_out: Vec<Node>, links_in: Vec<Node>, tags: Vec<TagGroup>, mentions: Vec<Mention> }`
  - `Node { path, title, created, modified, preview, locked }` (`preview` is the Notes list snippet, for the hover card)
  - `TagGroup { tag, count, notes: Vec<Node> }`, with `notes` empty when `count > 15`
  - `Mention { node: Node, name, count }`: `name` is the title or alias as it appears in the note's text, and `count` is its number of unlinked occurrences, the `expected_count` for Link it.
- Inputs: the centre's text (from disk, or the unlocked cache), the existing `links`, `tags`, `aliases` and `notes` tables, and the unlocked map for locked notes' own links and tags.
- Target: < 50 ms at 10k notes, measured in the existing `src-tauri/tests/perf.rs` (local, `--ignored`).

## 8. Rendering

- **No new dependency** (audit 6): SVG nodes and edges rendered by React, with positions from section 4. Styling uses velo's tokens.
  - **Why plain SVG is enough (2026-10-29):** both layouts are closed-form (points on a circle; x from a date), with one hop and at most a few dozen nodes. A graph library mainly adds a force simulation, which section 4 rules out, plus pan and zoom, which section 1 rules out.
  - Considered and rejected: `d3-force@3.0.0` (force layout only), `@xyflow/react` and Cytoscape.js (editors with pan, zoom and drag, far heavier than the need). Revisit only if the whole-vault map is built.
- **Keyboard:**
  - Tab and ⇧Tab move through the nodes, in the current sort's order.
  - ↩ opens, and ⇧↩ re-centres.
  - Esc returns to the Notes mode.
  - Each node has an accessible label: title, edge kind, date.

## 9. Agents (MCP)

Agents get the same data through the shipped MCP server (`src-tauri/src/agent/`), on its existing conventions.

- **Tool `get_connections(title)`**, read-only.
  - It takes a title or alias, like every tool, and returns the section 7 shape with titles instead of paths: `{ title, created, modified, links_out, links_in, tags, mentions }`. Each note is `{ title, created, modified }`; tags are `{ tag, count, titles }` (`titles` empty when `count > 15`); mentions are `{ title, name, count }`.
  - The description says how to act on it: to link a mention, `read_note`, then `edit_note` wrapping the words in `[[ ]]`.
  - One hop only, so there is no `depth` parameter **(my call)**: section 1 makes two hops a non-goal. An agent wanting two hops calls the tool again on a neighbour.
- **Routing:** as for every tool. `NoteOps` gets `connections(path)`.
  - `VaultOps` (direct mode, used by headless `velo --mcp` when velo is closed) calls `Vault::connections`.
  - `AppOps` (velo open; the call is forwarded over the loopback listener) runs the same `VaultOps` method on the app's vault through `with`.
  - So both modes run `connections::build`. The tool goes into `TOOL_SPECS`, so the `agent_access` gate and the "unknown tool" check apply unchanged. It is not a write, so it takes no `summary`.
- **Locked notes**, exactly as other tools:
  - a locked centre (or a plain twin of one) is "not found", through the existing `path_of`;
  - `VaultOps::connections` drops every node whose path is `locked()` from every group, before any title leaves. This covers unlocked-in-app notes, whose links and tags the app holds in memory.
- **Tool `link_mention(title, target_title, expected_count, summary)`** (owner, 2026-10-29). It is the MCP form of Link it, and a write tool on the existing write conventions.
  - `title` is the note to edit (the centre of a `get_connections` call). `target_title` is a mention's `name`, and `expected_count` is its `count`, both from `get_connections`.
  - The rewrite is the same Rust function the Tauri `link_mention` command uses, `text::link_mention_text`. There is no second matcher or rewrite.
  - The write goes through `NoteOps::write`, like `edit_note`: an agent revision with the `summary`, then the editor routing when the note is open in the app (an undoable edit), else the normal save path, in both app-routed and direct mode.
  - A stale `expected_count` changes nothing and fails with "mention-moved: call get_connections again".
  - Locked notes: the edited note is "not found" through `path_of`, as for every tool.
  - It returns `{ title, hash }`, like the other write tools.
- **`search_notes` gets `no_links: bool`** (owner, 2026-10-29): the same `search_page` flag as the app's No links filter (section 6). Locked notes are already excluded by both the flag and the tool.
- **Changed alongside (owner):** `read_note`'s `backlinks` becomes alias-aware, through the same index query as the graph (section 3).

## 10. Docs and settings

- New settings: the shortcut and `connections_sort`.
- README: a Connections section, plus `get_connections` in the Agents (MCP) tool list.
- Changeset: minor.

## 11. Constraints

- Existing invariants hold: locked plaintext stays out of the index, and only Link it writes to a note.
- The search budget is unchanged.
- Workflow: AGENTS.md / CONTRIBUTING.md.

## 12. Left to the builder

- Ring spacing and label collision handling.
- Node styling within the design system.
- Row stacking on the time axis.

## 13. Owner checks

- Connections on a well-linked note and on an orphan.
- The Created sort on a topic.
- Link it on a mention, then ⌘Z.
- An alias link (`[[Nick]]`) shows as a backlink.
- Ask Claude Code "what is connected to <note>?" with velo open, then with velo closed.

## 14. Changes in the 2026-10-29 amendment

- Added section 9 (MCP). Owner answers, 2026-10-29: add the `link_mention` tool and `search_notes(no_links)`; `read_note` backlinks become alias-aware; keep all three layouts; rename stays title-only.
- Section 2: dropped the separate title-bar button; the switch segment is the button. The Tasks build-order note is done.
- Section 3: rename stays title-only (alias links survive a rename). Outgoing links come from the text plus the existing `find_titles`; no schema change.
- Section 5: `Editor.applyChange` and `changedSpan` already exist. Link it saves directly only when the centre isn't open in the editor.
- Section 6: the orphan filter is a flag on `search_page`.
- Section 7: one named function and a grouped result shape.
- Section 8: the reasoning for plain SVG and the rejected libraries.
