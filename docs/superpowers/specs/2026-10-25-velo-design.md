# Velo — design (nvALT-inspired notes app)

Working name **velo** (placeholder; final name must not contain "nvALT" or "Notational Velocity").
Final home of this doc after rename: `/Volumes/Dev/matteo/velo/docs/superpowers/specs/2026-10-25-velo-design.md`.

## Context / intent
Matteo used nvALT daily, dropped it when it broke on newer macOS. It works again (v3.0.5, actively maintained), but it is Obj-C/Cocoa, macOS-only, and hard for him to extend. Goal: a **clean-room, cross-platform** successor he owns and can keep customizing as he uses it, released as OSS. Agentic/AI features come later; v1 must not block them.

Matteo is strongest in TypeScript/web, willing to learn Go or Rust.

## Goals (v1 — must be good enough for daily use)
1. **Search-or-create field**: single input; filters notes incrementally as you type (title + body); Enter opens top match or creates a note titled with the query. Fully keyboard-driven (up/down in list, Esc back to field, ⌘L focus field, ⌘J/⌘K navigate).
2. **Plain-text folder storage**: user picks a folder; one note = one file, filename = title, `.md` default (also read `.txt`). External edits are picked up live (file watching). Autosave, no Save button.
3. **Markdown preview + `[[wiki links]]` + tags**: toggleable preview pane; `[[Title]]` links are clickable (create the note if missing); tags searchable.
4. **Global hotkey**: summons/hides the window from anywhere.
5. **Per-note encryption**: individual notes can be locked → stored as `Title.md.age` (age format, passphrase). Locked notes show in list by title only; body searchable only while unlocked (in-memory only, never written to index).
   - **Matteo decided:** one passphrase for all locked notes, stored in the OS keychain / credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service; e.g. `keyring` crate / `zalando/go-keyring`). Unlocks automatically on his machine; first-time setup prompts for it. Titles visible as filenames is accepted.
   - My call: re-encrypt on the normal autosave debounce (age is fast enough); "Lock all" command clears decrypted bodies from memory.

## Behavior decisions
- **Flat folder (Matteo decided)**, like nvALT: no recursive scan; subfolders ignored.
- **Filenames (my call):** title → filename by replacing `/ \ : * ? " < > |` and control chars with `-`, trimming trailing dots/spaces. Titles are unique case-insensitively; creating a duplicate opens the existing note.
- **Search (my call):** substring match, case- and diacritic-insensitive, like nvALT. Titles matched in memory; bodies via FTS5 with the `trigram` tokenizer (verify <50 ms at 10k in spikes). Ranking: title matches first, then body matches; within each, most recently modified first.
- **Enter (my call, nvALT behavior):** opens the note whose title exactly matches the query (case-insensitive); otherwise creates a note titled with the query. Arrow keys select other matches.
- **Rename (my call):** renaming a note offers to rewrite `[[Old Title]]` links in other notes (one confirm dialog); declining leaves links pointing at the old title (which would create a new note if clicked).
- **External edit while unsaved local changes (my call):** if no unsaved changes, reload silently. If there are, keep the editor content, write it as `Title (conflict YYYY-MM-DD HHmm).md` (visible as a normal note), load the external version, show a non-blocking banner linking both.
- **OSS release in v1 (my call):** public GitHub repo, MIT, unsigned builds for macOS/Windows/Linux via GitHub Actions on tag. Code signing/notarization and auto-update deferred (Apple dev account costs money; not needed for personal use).

## Non-goals (v1)
- Simplenote sync (folder works with Dropbox/iCloud/Syncthing/git instead).
- RTF/HTML/Word storage formats; nvALT `Notes & Settings` DB import.
- Web clipper, Textile, AppleScript, bookmarks, menu-bar item.
- Mobile.
- AI features (later phase — but see "Future hooks").

## Anti-goals (failure even if it works)
- Notes locked into a proprietary/binary format.
- Search that feels slower than nvALT's (target: results update per keystroke, <50 ms at 10k notes).
- Any code copied from nvALT (license contamination; see below).
- Using nvALT/NV names or icons.

## License findings (ttscoff/nv)
- Mixed: `License.txt` BSD-3 (Schneirov 2009), `COPYING.txt` GPLv3; 16 core files still have GPLv3 headers (`NotationController.m`, `NoteObject.h`, …); bundled GPLv2+ SHA1/HMAC. Treat nvALT binary as GPL.
- **Decision: clean-room rewrite, license MIT** (my call; Apache-2.0 also fine). Do not open nvALT source while writing velo code beyond the recon already done.
- Free to borrow: feature set, UX/keyboard flow, folder conventions, `[[link]]` syntax, OpenMeta tag xattr `com.apple.metadata:kMDItemOMUserTags` (read-compat on macOS, optional).
- Apex markdown (MIT) could be used, but a JS renderer is simpler (my call: markdown-it).
- Don't reuse: names, icons/artwork (unlicensed / non-commercial).

## Storage architecture (decided: hybrid)
- **Files are source of truth.** SQLite is a **rebuildable cache**: deleting it loses nothing.
- SQLite tables: `notes(path, title, mtime, size, hash, encrypted)`, FTS5 `notes_fts(title, body, tags)`, `links(src, dst_title)`, `tags(path, tag)`. DB lives in app data dir, keyed by folder path (not inside the notes folder — avoids sync conflicts).
- Startup: scan folder, reconcile by mtime/hash. Runtime: file watcher → debounce → reindex changed files. App writes: write file atomically (temp + rename), then update index; watcher ignores self-writes by hash.
- Tags in v1: stored in note front-matter-free form — a `tags:` first line or `#tag` tokens (my call: `#tag` tokens in body, plus read macOS OpenMeta xattr if present).
- Encrypted notes: `*.md.age`, index stores title + `encrypted=1` only.
- Future: `sqlite-vec` table for embeddings, link graph for agents.

## Runtime (decided: spike both, then choose)
Candidates: **Tauri 2** (Rust core + TS UI) — recommended; **Wails** (Go core + TS UI) — runner-up. Native Rust UI (egui/iced) and native Go UI (Fyne/Gio) rejected: discard TS skills, weak rich-text editing. Electron not considered (heavy) unless both spikes disappoint.

UI layer is identical in both: TypeScript + Vite, editor **CodeMirror 6**, preview **markdown-it**, framework **Svelte or plain TS** (builder's call; keep it light). Backend responsibilities (thin): folder scan, file watch, atomic writes, SQLite/FTS5, age encrypt/decrypt, global hotkey.

| Concern | Tauri 2 | Wails |
|---|---|---|
| Watch | `notify` crate | `fsnotify` |
| SQLite FTS5 | `rusqlite` (bundled, fts5) | `modernc.org/sqlite` (pure Go) or `mattn/go-sqlite3` |
| age | `age` crate | `filippo.io/age` (reference impl) |
| Hotkey | `tauri-plugin-global-shortcut` | `golang.design/x/hotkey` or Wails v3 API |
| Updater/packaging | built-in plugins | built-in packaging, less updater tooling |

### Spike protocol (throwaway, ~½ day each)
Same slice in both, in `/Volumes/Dev/matteo/velo/spikes/{tauri,wails}`:
search field + list over a folder of `.md` files, FTS5 search per keystroke, external edit → list updates, global hotkey toggles window, markdown preview of selected note.
Seed with a generated 10k-note folder. Record: setup friction, LOC in backend, bundle size, idle RAM, search latency at 10k, how Matteo felt reading/writing the backend code. Matteo picks; spikes are deleted (keeping code = new request).

## UI layout (v1, my call)
nvALT-like: search field on top; notes list (title, snippet, modified date); editor below or right (toggle horizontal/vertical); preview as toggle (⌘⇧P) replacing or beside editor. Light/dark follows OS. Minimal settings: notes folder, hotkey, layout, font.

## Future hooks (don't build, don't block)
- Keep all note operations behind one backend command API (list/search/read/write/create/rename/lock) so a later **MCP server / agent** can reuse it.
- Plain files mean external agents (Claude Code etc.) can already work on notes.
- Index schema leaves room for embeddings + link graph.

## Left to the builder
Exact framework (Svelte vs plain TS), CSS approach, keybinding details beyond those listed, debounce timings, test framework, CI. Repo hygiene: README, MIT LICENSE, CONTRIBUTING later.

## Execution order (after approval)
1. `mv /Volumes/Dev/matteo/notes /Volumes/Dev/matteo/velo` (dir currently empty), `git init`, add this doc under `docs/superpowers/specs/`, MIT LICENSE, commit. Note: Claude Code project memory is keyed to the old path; reopen Claude in `velo/`.
2. Run both spikes, compare, Matteo chooses runtime.
3. superpowers:writing-plans for v1 on chosen runtime.

## Verification (v1 acceptance)
- 10k-note generated folder: per-keystroke search <50 ms, cold start indexing reasonable, rebuild after deleting DB works.
- Edit a note in another editor → app reflects it within ~1 s; app edits never clobber concurrent external edits silently (detect mtime/hash change → reload or conflict copy).
- Lock a note → file becomes `.md.age`, plaintext absent from disk and SQLite (grep DB file); unlock with passphrase works.
- Global hotkey works on macOS, Windows, Linux (X11 at least).
- `[[link]]` to missing note creates it; preview renders links clickable.
