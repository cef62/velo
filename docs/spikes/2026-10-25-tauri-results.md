# Tauri 2 spike: results

Throwaway spike. Code: `src-tauri/src/lib.rs` (whole backend) and `src/main.ts` (whole UI).
Machine: macOS (Darwin 27), Apple Silicon arm64. Measured 2026-10-25.

## How to run

```sh
cd spikes/tauri
pnpm install
pnpm tauri dev                     # dev build (slow: SQLite is compiled -O0)
VELO_BENCH=1 pnpm tauri dev        # also prints backend + end-to-end benchmarks to the terminal
VELO_NOTES=/some/folder pnpm tauri dev   # different notes folder (default: spikes/fixtures/notes)
pnpm tauri build                   # release .app + .dmg in src-tauri/target/release/bundle/
# release binary with stdout visible (this is how the numbers below were taken):
VELO_BENCH=1 src-tauri/target/release/bundle/macos/velo-spike-tauri.app/Contents/MacOS/tauri
```

The index is always rebuilt from scratch at startup. It lives in
`~/Library/Application Support/dev.velo.spike.tauri/index.sqlite`, not in the notes folder.

## Versions

| Thing | Version |
|---|---|
| create-tauri-app | 4.7.5 (`--template vanilla-ts --manager pnpm`) |
| tauri (crate) / tauri-cli / @tauri-apps/api | 2.12.5 / 2.12.4 / 2.12.4 |
| wry / tauri-runtime-wry | 0.57.1 / 2.12.3 |
| tauri-plugin-global-shortcut | 2.4.1 |
| rusqlite (bundled) / libsqlite3-sys / SQLite | 0.41.0 / 0.39.1 / 3.54.1 |
| notify | 8.2.1 (raw watcher, no debouncer) |
| vite / typescript / markdown-it | 8.3.5 / 6.0.3 / 15.0.3 |
| rustc / node / pnpm | 1.98 / 24 / 12.3.4 |

## Setup steps and friction

1. `pnpm create tauri-app@latest tauri --template vanilla-ts --manager pnpm --identifier dev.velo.spike.tauri -y`. Took 2 s and worked first time.
2. `cargo remove tauri-plugin-opener` and `cargo add rusqlite --features bundled`, `cargo add notify tauri-plugin-global-shortcut`. `pnpm add markdown-it`, `pnpm add -D @types/markdown-it`.
3. Removed `opener:default` from `src-tauri/capabilities/default.json`. The template still referenced the removed plugin in `lib.rs` until I rewrote that file.
4. FTS5 + trigram worked out of the box with `rusqlite` `bundled`. No extra feature flag was needed.
5. The global shortcut is registered from Rust, so no JS plugin and no capability entry are needed.

Friction (small):
- The crate name comes from the folder name. The binary is called `tauri` and the lib `tauri_lib`. This is confusing next to the `tauri` crate. Cosmetic.
- First debug build: about 19 s wall time on 10 cores (102 s CPU). Release build: 1 min 43 s total (`pnpm tauri build`, LTO on). `src-tauri/target/` is **3.2 GB**.
- Debug builds compile SQLite with `-O0`. Cold index is 4.8 s in debug against 2.4 s in release, and searches are about 2-3x slower. Benchmark only release builds.
- The backend compiled on the first try. A human Rust beginner would likely spend time on closures (`move`, `Arc` clones for the watcher thread) and on `?` error conversion. See the subjective notes.

## LOC

| Part | Lines (total) | Non-blank, non-comment |
|---|---|---|
| Rust `src-tauri/src/lib.rs` + `main.rs` | 255 + 6 | 216 + 4 |
| TS `src/main.ts` | 83 | 73 |
| `index.html` + `styles.css` | 16 + 15 | |

About 35 of the Rust lines are benchmark-only code: the `bench_backend` function, the `bench_queries` and `log` commands, and the query list.

## Measurements (release build)

### Cold index (10,000 notes, about 13 MB of text)
Scan, read every file, and insert into `notes` + FTS5 trigram, in one transaction:
**2.36 s, 2.53 s, 2.36 s** (3 runs). Debug build: 4.8 s.
I did not profile this. The likely cost is trigram tokenization of about 13 MB of body text. The index is written to disk inside a single transaction.

### Search latency at 10k (backend, `search_db` timed in Rust)
25 queries. Each query gets 1 warm-up, then 10 timed runs, so n = 250 samples.

| Run | p50 | p95 | max |
|---|---|---|---|
| 1 | 0.84 ms | 8.64 ms | 24.4 ms |
| 2 | 0.91 ms | 9.04 ms | 25.8 ms |
| 3 | 0.82 ms | 8.00 ms | 22.7 ms |

Median per query (run 1):

| query | ms | hits | | query | ms | hits |
|---|---|---|---|---|---|---|
| `a` | 0.11 | 100 | | `kubernetes` | 0.80 | 100 |
| `e` | 0.10 | 100 | | `résumé` | 0.33 | 100 |
| `z` | 0.80 | 100 | | `resume` | 5.08 | 100 |
| `ru` | 0.48 | 100 | | `#work` | 3.21 | 100 |
| `go` | 0.16 | 100 | | `1234` | 1.84 | 3 |
| `xy` | **23.65** | 0 | | `zzzz` | 1.79 | 0 |
| `42` | 0.97 | 100 | | `rust golang` | 6.19 | 100 |
| `caf` | 0.83 | 100 | | `deploy server` | 6.60 | 100 |
| `rus`, `tau`, `sql` | 0.46-0.86 | 100 | | `book delta` | 0.84 | 100 |
| `rust`, `delta`, `meeting` | 0.32-0.45 | 100 | | `alpha bravo charlie` | 8.60 | 100 |
| | | | | `re de` | 2.12 | 100 |

How search works:
- The query is split on whitespace. A note matches if **every** term is a substring (AND).
- **Title pass:** `title LIKE '%t%' AND ...`, ordered by mtime desc, limit 100. This scans the 10k-row `notes` table, which is cheap.
- **Body pass** (only if there are fewer than 100 title hits): terms of 3 chars or more go into one FTS5 `MATCH '"t1" AND "t2"'`, which uses the trigram index. **Terms under 3 chars use `body LIKE '%t%'`**, a full scan of the FTS content (trigram cannot index them). The body pass excludes title hits and fills the list up to 100, ordered by mtime desc.
- Cost of the under-3-char fallback: worst case is a short term with few title hits. `xy` gives 0 title hits, so it scans all bodies: **about 24 ms**. That is the max in every run, but still under the 50 ms target.

Caveats (honest):
- **The fixture vocabulary is tiny (about 80 words).** Most single-word queries find 100 or more *title* hits, so the body pass never runs. Those rows mostly measure the title LIKE scan.
- The rows that do exercise FTS5 or the body path: `resume`, `#work`, `1234`, `zzzz`, `xy`, `re de`, and the multi-word queries. They take 2-9 ms. The exception is `xy` at 24 ms.
- Matches are sorted by mtime, not by FTS rank. A common term therefore makes SQLite collect and sort all matching rows before `LIMIT`. This is why `alpha bravo charlie` (8.6 ms) is the slowest MATCH query.
- Case-insensitivity: the trigram tokenizer is case-insensitive. `LIKE` is case-insensitive for ASCII only.
- Diacritics are inconsistent. The FTS table uses `remove_diacritics 1`, so `resume` finds `résumé` in bodies. Title `LIKE` does not fold diacritics, so `resume` gets 0 title hits and falls through to the slower body pass. A real build would title-match in memory with a folded string, as the spec suggests.
- `%` and `_` in queries are not escaped for LIKE (marked `shortcut:` in the code).

### End-to-end keystroke to render (in the webview)
Measured with `performance.now()`. For each query the UI sets `input.value`, calls the `search` command over IPC, rebuilds the 100-item list, calls `read_note` and renders the first note's markdown, then waits one `requestAnimationFrame`. 25 queries, the second pass is timed:
**p50 17 ms, p95 17-19 ms, max 24-27 ms** (3 runs).
This is dominated by waiting for the next frame (60 Hz is about 16.7 ms). WebKit also rounds `performance.now()` to whole milliseconds. In practice: results appear on the next frame after a keystroke. IPC + DOM + markdown take only a few ms, except the `xy` case.

### Watcher latency
With the app running, a shell wrote to the folder and the backend logged the epoch ms when it re-indexed. The delta includes the `python3` startup used to read the clock:

| op | write → reindexed |
|---|---|
| create new file | 12 ms |
| append to it | 14 ms |
| delete it | 15 ms |
| `touch` existing note | 16 ms |

After the reindex, the backend emits a `notes-changed` event and the UI reruns the current search. I confirmed with a screenshot that the touched note moved to the top of the list (mtime desc). There is no debounce, because `notify` on macOS uses FSEvents. A burst of changes, such as a git checkout, would reindex file by file. A real build should debounce.

### Bundle size (release, aarch64, unsigned)
- `velo-spike-tauri.app`: **5.7 MB** (binary 5.9 MB on disk, SQLite included)
- `velo-spike-tauri_0.1.0_aarch64.dmg`: **2.8 MB**

### Idle RAM (release, about 25 s after launch, no interaction)
| process | RSS (ps) | footprint |
|---|---|---|
| tauri (app + Rust + SQLite, index already in memory) | 108 MB | 32 MB |
| com.apple.WebKit.WebContent | 36 MB | 38 MB |
| com.apple.WebKit.GPU | 24 MB | 131 MB |
| com.apple.WebKit.Networking | 11 MB | 6 MB |
| **sum** | **≈ 180 MB** | **≈ 207 MB** |

- RSS counts shared system frameworks.
- `footprint` for the GPU process includes graphics/IOSurface memory, which is most of its 131 MB.
- The two metrics disagree a lot. Compare like with like against the Wails spike. Both use WKWebView on macOS, so the WebKit helpers should be similar.
- I picked the helper PIDs by diffing the WebKit process list before and after launch. Their PIDs come right after the app's PID.

### Global hotkey
- Registration of **Cmd+Shift+Space** succeeded: the log shows `[hotkey] registered Cmd+Shift+Space`, in both dev and release.
- **Not verified by pressing it.** The agent cannot press keys.
- Owner, please check that Cmd+Shift+Space hides the window and shows/focuses it again. Also check that it works while another app is focused, and that nothing else (Raycast/Alfred/input-source switching) already owns that combo.
- No macOS Accessibility permission prompt is expected: the plugin uses Carbon `RegisterEventHotKey`.

### Also needs owner verification
- Arrow keys move the selection and the preview follows.
- Enter logs `open "..."` or `would create "..."` to the webview console (devtools: right-click, Inspect, in the dev build).
- Clicking a result selects it.

## Subjective notes (for a TS developer)

- **Difficulty:** low to moderate for this slice. Tauri itself is pleasant:
  - `#[tauri::command] fn search(...)` plus `invoke("search", { q })` is about as simple as a typed RPC gets.
  - serde turns structs into JSON with one `#[derive(Serialize)]`.
  - Events (`app.emit` and `listen`) are one line each side.
- **What a TS dev would struggle with:**
  - Sharing state between the watcher thread and the command handlers needs `Arc<Mutex<Connection>>`, `.clone()` before a `move` closure, and `.lock().unwrap()`. This is the biggest new concept: ownership across threads. The compiler errors are good, but the first encounter is confusing.
  - Strings: `String`, `&str`, `Cow` from `to_string_lossy()`, `PathBuf` and `&Path`. Several conversions appear only to satisfy types.
  - Error handling: `?` needs compatible error types. Commands return `Result<T, String>` with `.map_err(|e| e.to_string())`. `unwrap()` is easy to sprinkle and it panics, and `panic = "abort"` in release kills the app.
  - Traits must be imported for methods to exist. For example, `use tauri::Manager` is needed for `app.path()` and `Emitter` for `app.emit()`. Without the import you get "no method found" errors.
  - Rebuild times: about 4 s incremental debug, 1-2 min release. The `target/` folder is 3.2 GB.
- **Boilerplate vs logic in `lib.rs`:**
  - About 105 lines are real logic: schema, index, search SQL building, watcher, read_note.
  - About 45 lines are Tauri wiring: builder, plugin, setup, `manage`, `generate_handler!`.
  - About 30 lines are imports, structs and derives.
  - About 35 lines are benchmark code.
  - The SQL dominates the logic and would look the same in any language.
- rusqlite is straightforward if you know SQL. `query_map` + `collect()` into `Result<Vec<_>>` is the one idiom worth learning.

## Not done / shortcuts
- No note creation, editing, debounce, startup reconcile (it always does a full rebuild), or folding of title diacritics.
- No LIKE escaping, and no Windows/Linux modifier choice (SUPER = Win key there).
- `read_note` rejects paths outside the notes folder, but symlinks are not considered.
- My `touch` test changed the mtime of `fixtures/notes/book delta xray golang 46.md`; its content is unchanged. The probe file `zz watcher probe.md` was created and then deleted.
