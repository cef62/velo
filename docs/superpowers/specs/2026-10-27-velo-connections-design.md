# velo — Connections view design

Requested by Matteo. He wants to see how a note relates to others and move through those relations:
- what is around a note;
- how a topic evolved;
- which notes are orphans.

The whole-vault "big picture" was also asked for, and deferred (section 1). Decisions below are his unless marked **(my call)**. This is Project 2 of 4, designed in parallel with Project 1 (Tasks).

## 1. Why and what

- **Goal:** a graph centred on the open note that you read and navigate. Clicking a note opens it in the editor while the graph stays put.
- **Non-goals:**
  - A whole-vault map (deferred: past about 30 nodes it becomes unreadable).
  - Editing links by dragging.
  - Saved layouts.
- **Anti-goals:**
  - A hairball.
  - A slow open on a 10k-note vault.
  - Writing to notes, except the explicit **Link it** action.
  - Showing locked notes' content or links while they are locked.

## 2. Opening and layout

- Action `toggle_connections`, default `Mod+Shift+KeyC`, remappable **(my call)**. ⌘G is CodeMirror's find-next. A title-bar button does the same.
- The view takes the left pane's place, the same pane that switches Notes | Tasks.
  - Build order: Project 1 (Tasks) ships first and introduces the pane-mode switch; Connections adds its third mode **(my call)**. The pane gets a third mode, **Connections**, available when a note is open. The editor stays on the right.
- It is centred on the open note when opened. Clicking a node opens that note in the editor (normal flush-then-load) and leaves the graph and its centre unchanged. **Re-centre** (a node button, or double-click) makes the clicked note the new centre **(my call)**.

## 3. What is drawn

- **Nodes:** notes (title; the centre is highlighted) and tag nodes (`#tag`).
- **Edges:**
  - **Wikilink:** a solid line with an arrow showing direction. It is resolved like the existing backlinks: title or alias, folded.
  - **Shared tag:** note — tag node — note. A tag node appears only for tags the centre note has (depth 1), or that a shown note has (depth 2).
    - A tag shared by more than 15 notes collapses to one "+N" node; clicking it expands **(my call)**.
  - **Mention:** an unlinked mention, where one note's text contains another's title or alias without `[[ ]]`. A faint dashed line, computed only between the centre and other notes (both directions), never at depth 2 **(my call: cost)**.
    - Titles shorter than 3 characters are ignored.
    - Matches are case-insensitive and on whole words.
    - Text inside code spans and code blocks, and existing links, don't count.
- **Depth:** 1 hop by default, with a toggle for 2. Depth counts wikilink and tag hops; a tag node is half a hop, so depth 1 shows notes sharing a tag.
- **Size limit:** at most 150 note nodes; tag and "+N" nodes don't count. Beyond that the farthest or oldest nodes are cut and a note says "Showing 150 of N" **(my call)**.
  - The centre's own tags are never cut.
  - Expanding "+N" calls the backend for that tag's members, up to the cap.
- **Locked notes:** shown as nodes, by filename title, when other notes link to them. Their aliases are unknown while they are locked.
  - Their own outgoing links, tags and mentions are used only while they are unlocked (memory only), never from the index. `connections` takes the unlocked map as `search_page` does.
  - A locked note can be the centre only while it is unlocked. While locked, the view shows "Note is locked".
  - A locked note that nothing links to is not shown.

## 4. Layout and sort

- **Dates:** the effective dates already stored in the index (`notes.created` and `notes.modified`: front matter when present, else file dates). Locked notes use their file dates.
- **Default:** force-directed, with the centre fixed in the middle.
- **Sort toggle:** Free | Created | Updated.
  - Created and Updated lay nodes out left to right by that date (the effective dates from note metadata).
  - Vertical position comes from the forces.
  - The centre is placed at its own date.
  - A thin date axis is drawn under the nodes.
- **Hover:** shows a card with title, created and modified dates, and the first snippet line.

## 5. Link it

- Hovering a mention edge, or right-clicking a mentioning node, offers **Link it**.
- Command `link_mention(src_path, target_title, expected_count)`.
  - `expected_count` is the number of unlinked occurrences the UI saw. A mismatch is refused with `"mention-moved"`, and the view refreshes.
  - It rewrites the first occurrence that the same matcher accepts (code, existing links and front matter are skipped) to `[[Title]]`. It keeps the original text through `[[Title|text]]` when that differs, including when the match was an alias.
  - Not offered for locked notes.
  - It saves through the normal path.
  - If the note is open in the editor, the frontend applies the same rewrite to the editor's text as a user edit, through a new `Editor.applyChange({from, to, insert})`, so there is one writer.
- After it runs, the edge becomes a solid wikilink.

## 6. Orphans

- The note list gets a filter, **No links** (next to the tag filter, as a chip). It shows notes with no outgoing and no incoming wikilinks. Tags don't count **(my call)**.
- It is backed by an index query, with no graph involved.
- Links from locked notes aren't indexed, so a plain note linked only from a locked note counts as an orphan (accepted). Locked notes themselves are left out of the filter.

## 7. Backend

- Command `connections(path, depth) -> { nodes, edges, truncated }`. It is built from the existing `links`, `tags` and `aliases` tables, plus mention matching over the centre note's text and FTS candidates for the reverse direction.
  - Reverse mentions take FTS trigram candidates for the centre's title and aliases, at most 200 notes. Each candidate's indexed body (read from `notes_fts`, not disk) is then post-filtered with the whole-word, code-excluding matcher **(my call)**.
- Persisted depth and sort are global settings (`connections_depth`, `connections_sort`).
- Target: < 50 ms for depth 1 and < 150 ms for depth 2 at 10k notes, measured in the existing `src-tauri/tests/perf.rs` (local, `--ignored`).

## 8. Rendering

- New dependency **(my call)**: `d3-force` only (small, maintained), with SVG nodes and edges rendered by React. No full graph framework: the graph is small and the look must use velo's tokens. Pan and zoom use plain pointer events.
- Keyboard:
  - ↑/↓/←/→ move the selection between nodes (nearest in that direction).
  - ↩ opens.
  - ⇧↩ re-centres.
  - Esc returns to the Notes mode.

## 9. Docs and settings

- No new settings beyond the shortcut and the remembered depth and sort (persisted, like `info_panel`).
- README: a Connections section.
- Changeset: minor.

## 10. Constraints

- Existing invariants hold: locked plaintext stays out of the index, and only Link it writes to a note.
- The search budget is unchanged.
- Workflow: AGENTS.md / CONTRIBUTING.md.

## 11. Left to the builder

- Force parameters.
- Node styling within the design system.
- Pan and zoom details.
- How to cut nodes beyond 150 fairly.

## 12. Owner checks

- Connections on a well-linked note and on an orphan.
- The Created sort on a topic.
- Link it on a mention in a note that is open in the editor.
