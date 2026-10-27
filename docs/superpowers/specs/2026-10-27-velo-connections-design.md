# velo — Connections view design

Requested by Matteo. He wants to see how a note relates to others and move through those relations:
- what is around a note;
- how a topic evolved;
- which notes are orphans.

The whole-vault "big picture" was also asked for, and deferred (section 1). Decisions below are his unless marked **(my call)**. This is Project 2 of 4, designed in parallel with Project 1 (Tasks). A ponytail audit of this design was applied: findings 1, 2, 6 and 10.

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

- Action `toggle_connections`, default `Mod+Shift+KeyC`, remappable **(my call)**. ⌘G is CodeMirror's find-next. A title-bar button does the same.
- The view takes the left pane's place, as a third mode, **Connections**, of the Notes | Tasks switch. It is available when a note is open, and the editor stays on the right.
  - Build order: Project 1 (Tasks) ships first and introduces the switch **(my call)**.
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
- **Link resolution** (audit 2): a wikilink target matches a note's folded title **or** one of its aliases. The index's backlink query gets the alias join (one `UNION` over the `aliases` table). The same resolution then serves the info panel's "Linked from N", the graph, rename and the orphan filter, so `[[Nick]]` counts everywhere for a note with alias Nick.
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
- Command `link_mention(src_path, target_title, expected_count)`:
  - `src_path` is always the centre note, since mentions are outgoing only.
  - `expected_count` is the number of unlinked occurrences the UI saw. A mismatch is refused with `"mention-moved"`, and the view refreshes.
  - It wraps the first occurrence the same matcher accepts, keeping the words as written: `Velo roadmap` becomes `[[Velo roadmap]]`, and an alias mention `Nick` becomes `[[Nick]]` (audit 1). Matching ignores case and alias links resolve (section 3), so the link always points at the right note. No `[[Title|text]]` form: velo doesn't support it.
  - Not offered for locked notes.
  - It saves through the normal path.
  - If the note is open in the editor (always the case for the centre, unless the user moved on), the frontend applies the same rewrite to the editor's text as a user edit, through a new `Editor.applyChange({from, to, insert})`, so there is one writer and ⌘Z undoes it.
- After it runs, the edge becomes a solid wikilink.

## 6. Orphans

- The note list gets a filter, **No links** (next to the tag filter, as a chip). It shows notes with no outgoing and no incoming wikilinks, using the alias-aware resolution. Tags don't count **(my call)**.
- It is backed by an index query, with no graph involved.
- Links from locked notes aren't indexed, so a plain note linked only from a locked note counts as an orphan (accepted). Locked notes themselves are left out of the filter.

## 7. Backend

- Command `connections(path) -> { nodes, edges }`. It is built from the existing `links`, `tags` and `aliases` tables, plus mention matching over the centre note's text (from disk, or the unlocked cache).
- Target: < 50 ms at 10k notes, measured in the existing `src-tauri/tests/perf.rs` (local, `--ignored`).

## 8. Rendering

- **No new dependency** (audit 6): SVG nodes and edges rendered by React, with positions from section 4. Styling uses velo's tokens.
- **Keyboard:**
  - Tab and ⇧Tab move through the nodes, in the current sort's order.
  - ↩ opens, and ⇧↩ re-centres.
  - Esc returns to the Notes mode.
  - Each node has an accessible label: title, edge kind, date.

## 9. Docs and settings

- New settings: the shortcut and `connections_sort`.
- README: a Connections section.
- Changeset: minor.

## 10. Constraints

- Existing invariants hold: locked plaintext stays out of the index, and only Link it writes to a note.
- The search budget is unchanged.
- Workflow: AGENTS.md / CONTRIBUTING.md.

## 11. Left to the builder

- Ring spacing and label collision handling.
- Node styling within the design system.
- Row stacking on the time axis.

## 12. Owner checks

- Connections on a well-linked note and on an orphan.
- The Created sort on a topic.
- Link it on a mention, then ⌘Z.
- An alias link (`[[Nick]]`) shows as a backlink.
