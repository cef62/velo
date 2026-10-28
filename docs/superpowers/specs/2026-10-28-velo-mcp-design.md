# velo — agent access (MCP server) design

Requested by Matteo. He wants an AI agent to work on his notes for him. Examples:
- hand it a meeting transcript and get a meeting note and/or TODOs;
- turn a brainstorm into a TODO list;
- tag every note matching some criteria.

The agent gets this through an MCP server that exposes most of velo's capabilities. Decisions below are his unless marked **(my call)**.

## 1. Why and what

- **Goal:** Claude Code, on the same Mac, can search, read, create, edit and manage velo notes through MCP tools. This works whether velo is open or closed, and the user installs nothing beyond velo.
- **Scope of version one:** Claude Code only. Claude Desktop comes later (section 9).
- **Non-goals:**
  - Locked notes. They are invisible and untouchable; access may be explored later.
  - Settings.
  - Locking or unlocking.
  - Restoring revisions.
  - Emptying the Trash.
  - Remote or network access from other machines.
  - Claude Desktop in version one.
- **Anti-goals:**
  - An agent permanently deleting anything. Deletes go to the OS Trash.
  - Risky overwrites: a blind full-text replace, or a write based on a stale read.
  - A second writer to the note open in velo's editor, which would produce a conflict copy or lose typed text.
  - Agent changes that can't be seen or undone.
  - Plaintext of locked notes reaching an agent.
  - Anything listening for other computers on the network.
  - Agent access being on without the user turning it on.

## 2. Serving: velo's own binary, headless (Matteo picked option 1)

- **Launch:** Claude Code starts the server itself over stdio:
  `claude mcp add velo -- /Applications/velo.app/Contents/MacOS/velo --mcp`.
  - The same velo executable, started with `--mcp`, runs with no window and no tray. It speaks MCP over stdin/stdout.
  - Nothing else is installed.
  - On other platforms the path differs; the Settings button (section 6) prints the right command for the running install.
- **Forwarding when velo is open:** each request goes to the running app, which performs it.
  - Writes to the note open in the editor then go through the editor, the same one-writer rule as Tasks and capture.
  - Transport **(my call):** a loopback TCP listener on `127.0.0.1` with a random port. The running app writes the port and a random 32-byte token to `<app data>/agent.json`, readable only by the user (mode 0600).
  - The headless process sends the token as the first line of every connection, before any request. Anything without it is rejected, and the connection is closed.
  - The listener exists only while agent access is on and the app is running. It binds only to 127.0.0.1, never to other interfaces.
- **Direct when velo is closed:** the headless process opens the notes folder and the index itself.
  - It uses the same vault code as the app: the save path with front-matter stamping, revisions and conflict detection, the index, and the Trash.
  - "Open" is decided per request: if `agent.json` exists and the token connection succeeds, forward; otherwise go direct. So velo starting or quitting during an agent session is handled.
  - Two processes may then touch the same files and SQLite index. SQLite's WAL locking handles the index, and files stay the source of truth: the app's watcher sees the headless writes as outside edits, through the existing paths.
  - **(my call):** while velo is running, the headless process never writes directly. If the app is running but unreachable (for example still indexing), the tool fails with a clear "velo is busy, retry" error and does not fall back to direct writes.
  - **Detecting a running app (my call):** `agent.json` also holds the app's process id.
    - Pid alive but the connection fails (starting up, or not answering): retry for up to 2 s, then return "velo is busy, retry".
    - Pid dead, or no file: a stale file from a crash, so go direct.
    - velo has no tray mode. Hidden counts as running, and its webview still answers.
- **Off by default:** a new setting, `agent_access`, default **false**, under Settings → General.
  - While it is off, the app opens no listener, and the headless process answers every tool call with "Agent access is off — turn it on in velo Settings → General".
  - The headless process re-reads `settings.json` on every tool call **(my call)**.
  - Turning the switch off in a running app closes the listener and deletes `agent.json` immediately. The next agent call is refused.

## 3. Safety rules

- **Locked notes** (`*.md.age`):
  - never listed or searched, and their titles are never returned;
  - any tool naming one fails with "not found", so the lock is not revealed **(my call)**.
- **Unlocked locked notes:** a note that is encrypted on disk counts as locked even while the user has it unlocked in velo. Every tool filters it out in both modes, including from the merged search, tasks and tags results the running app builds from its in-memory unlocked notes.
- **No key access in headless mode:** headless mode never reads the keychain or the identity, and never decrypts anything.
- **Deletes:** `move_to_trash` uses the existing `move_to_trash` (OS Trash). No permanent delete exists.
- **No risky overwrites:**
  - There is no tool that replaces a whole note blindly.
  - Edits are anchored. `edit_note(title, old_text, new_text)` requires `old_text` to occur exactly once in the current text. If it matches zero times or more than once, the tool fails and reports the count.
  - `replace_note(title, text, expected_hash)` is the only full replace. It requires the hash returned by `read_note` and fails with "note changed since you read it" on a mismatch.
  - The hash is velo's existing `store::hash` over the full on-disk bytes, front matter included **(my call)**. It's strict: any change, including velo's own stamping, makes it stale.
  - Every write tool returns the note's new hash, so the agent can chain edits.
  - Appends (`append_to_note`, `add_task`) need no anchor.
  - Every write goes through the normal save path, so a write racing an outside change makes a conflict copy rather than losing text, and the tool reports it.
- **One writer:** when velo is open and the target note is open in its editor, the write goes through the editor as a user edit (undoable with ⌘Z). Otherwise it goes through the backend save path.
  - This reuses the Tasks routing (`Editor.appendLine`) and adds `Editor.applyChange({from, to, insert})` for anchored replaces and full replaces. The same primitive is planned for Connections' Link it.
  - The backend asks the webview whether the target is open, and has it apply the change, through an event with a reply.
  - The webview answers with success, conflict or refused (editor read-only or busy). With no answer within 5 s, the tool fails with "velo is busy, retry" and never writes directly **(my call)**.
  - The editor's text after the change is saved through its normal autosave, flushed before replying.
- **Limits per call (my call):**
  - Bulk tools take at most 200 notes per call. More is rejected, not truncated.
  - Each note is its own write, with its own revision. There is no rollback across notes. The result lists each note as changed, unchanged, or failed with the reason.
  - Search returns at most 50 results per page.

## 4. Seeing and undoing agent changes (Matteo: "a summary of changes in the note's revisions")

- Every agent write first takes a revision snapshot of the note as it was before the write. It bypasses the 10-minute throttle, so each agent write gets its own revision.
- Every write tool requires a `summary` parameter: a one-line, human-readable description such as "Agent: added 3 TODOs from the 27 Oct meeting transcript".
  - velo stores it beside the snapshot in a sidecar `<ms>.json` (`{ "summary": "...", "agent": true }`) **(my call)**.
  - `list`, `prune`, `rename`, `encrypt_all` and `remove_plain` in `revisions.rs` learn about sidecars: `list` ignores them as snapshots and attaches them, and the others move or delete them with their snapshot. A sidecar is never encrypted, since it holds only the summary.
  - Two snapshots in the same millisecond bump the later timestamp by 1 ms.
  - The info panel's revision list shows the summary and an "agent" mark.
  - The sidecar is deleted, renamed and pruned together with its snapshot.
- **New notes:** a note created by an agent gets a first revision holding its created text, with the summary. This records who made it and why.
- **Undo:** the existing Restore in the info panel. For a created note, moving it to the Trash.
- **Trashed notes:** their revisions stay until they age out, as today. The summary of the move-to-Trash snapshot is kept with them.

## 5. Tools (version one)

All tools take and return note **titles**, not paths. Titles are resolved like velo's own: case-insensitive, with aliases.

| Tool | Does | Notes |
|---|---|---|
| `search_notes(query?, tags?, limit?, offset?)` | Search like the velo search field. | Returns title, snippet, modified, tags. |
| `list_tags()` | Tags with counts. | |
| `read_note(title)` | Full text, front matter included. | Also returns `hash`, `created`, `modified`, `tags`, `aliases`, `links`, `backlinks`. |
| `create_note(title, text, summary)` | Creates a new note. | Fails if a note with that title or alias exists. Front matter is stamped as for any new note. |
| `append_to_note(title, text, summary)` | Appends text at the end. | Creates the note if missing **(my call)**. |
| `edit_note(title, old_text, new_text, summary)` | Anchored replace, one exact occurrence. | |
| `replace_note(title, text, expected_hash, summary)` | Full replace guarded by hash. | |
| `add_tags(titles[], tags[], summary)` / `remove_tags(titles[], tags[], summary)` | Bulk tagging. | Writes the front-matter `tags:` list **(my call)**. Removing also strips inline `#tag` words when exactly matched (section 7). Reports changed and unchanged counts. |
| `list_tasks(query?, tags?, show_done?)` | The Tasks view's data. | Same grouping; text, note title, due, line. |
| `add_task(text, title?, due?, summary)` | Adds a `- [ ] text` line. | Without `title`, uses the capture target (Inbox or daily note, same setting). `due` adds ` 📅 YYYY-MM-DD`. |
| `set_task_done(title, line, line_text, done, summary)` | Ticks or unticks a task. | Uses the Tasks `toggle_task` checks, with ✅ dates. |
| `rename_note(title, new_title, rewrite_links, summary)` | Rename. | Existing rename, with link updates. |
| `move_to_trash(title, summary)` | Moves to the OS Trash. | The summary goes into the snapshot taken before the move. |
| `daily_note(date?)` | Title (and text) of the daily note for a date (default today). | Title `YYYY-MM-DD` (local), as the Tasks feature's daily note. Creates it if missing, with no template **(my call)**. |

- **Tool descriptions** (my call) tell the agent velo's conventions:
  - `- [ ]` tasks;
  - `📅` due dates;
  - `[[wikilinks]]`;
  - `#tags` / front-matter tags;
  - one note per title;
  - always read before editing.

  That's what lets a meeting transcript become a note with `[[links]]`, tasks and tags without velo knowing about meetings.
- **Prompts or resources:** none in version one **(my call)**. Tools are enough for Claude Code.

## 6. Settings and setup

- Settings → General → **Agent access (MCP)**:
  - a switch (`agent_access`, default off);
  - when on, a **Copy setup command** button that copies the exact `claude mcp add velo -- <path to this velo binary> --mcp` line;
  - a one-line explanation of what agents can and can't do.
- README: an "Agents (MCP)" section with setup, the tools, the safety rules, and how to see and undo agent changes.
- Changeset: minor.

## 7. Tag writing

- **Matching:** tags are matched with velo's `fold` (case and accent insensitive). A nested tag like `a/b` is one literal tag.
- `add_tags` skips a note that already has the tag anywhere: front matter or inline `#tag`.
- `add_tags` adds the tags to the front-matter `tags:` list, creating the list (and the front-matter block, when `write_front_matter` is on) if missing. Other front-matter content stays byte for byte.
- If `write_front_matter` is off, `add_tags` appends a `#tag` line at the end instead **(my call)**.
- `remove_tags` removes a tag from `tags:`, and removes exact inline `#tag` words.
  - "Exact" is the same rule the tag extractor uses to find inline tags: `#tagging` is a different tag.
  - Code and link text are never touched.
  - It reports the notes where it couldn't remove a tag.

## 8. Constraints

- The existing invariants hold:
  - no user text lost;
  - locked plaintext never reaches disk, the index or an agent;
  - files are the source of truth;
  - one writer per open note;
  - search stays under 50 ms p95.
- **Platforms (my call):** macOS and Linux in version one. Windows release builds have no console (`windows_subsystem = "windows"`), so stdio needs extra work. It comes later, with Claude Desktop.
- **Headless startup:** `main.rs` branches on `--mcp` before `velo_lib::run()` builds the Tauri app.
  - The vault code (`Vault::open_with_progress(dir, db, …)`, settings load) already takes plain paths.
  - The app data and config directories are computed from the bundle identifier `dev.velo.app` the same way Tauri does, so both processes share the index and `settings.json`.
  - Headless direct mode runs the usual warm reconcile (`open_with_progress`) before the first tool call, so a stale index catches up.
- **Dependency:** the official Rust MCP SDK (`rmcp`, stdio transport) is allowed if it's maintained and small enough. Otherwise use a minimal hand-written JSON-RPC over stdio for the subset needed. The builder decides, and records why.
- **Startup:** headless mode must not open a window, register global shortcuts, run the update checker, or touch the Dock or tray.
- **Single instance:** headless mode must not trigger velo's single-window behaviour or steal focus.
- **Workflow:** AGENTS.md / CONTRIBUTING.md.

## 9. Later

- Claude Desktop: a desktop extension or a config snippet launching the same `velo --mcp`.
- Locked-note access with explicit per-session consent.
- Prompts such as "process a meeting transcript".
- Revision diffs in the panel.

## 10. Left to the builder

- Module split: a headless entry point, the request router, and the tool handlers shared between forwarded and direct mode.
- The IPC message format.
- MCP library choice (section 8).
- Exact tool result shapes beyond the fields listed.

## 11. Owner checks

- `claude mcp add` from the Settings button, then:
  - "make a meeting note from this transcript";
  - "turn this brainstorm into TODOs";
  - "tag all notes about X".
- Each change shows a summary in the revisions and can be restored.
- Repeat with velo closed.
- An edit to the note open in the editor arrives as an undoable edit, with no conflict copy.
- With agent access off, the tools refuse.
