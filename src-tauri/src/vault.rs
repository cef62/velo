use crate::connections::{self, Connections};
use crate::crypto;
use crate::frontmatter;
use crate::index::{Index, LinkTarget, Meta, Page, Sort, TagCount, TaskRow, all_tags, effective_dates};
use crate::tasks::{TaskView, group_tasks, local_today, parse_tasks, toggle_line};

const PAGE: usize = 200;
// "All rows" for search_page_where: it binds limit into SQL text, so stay far from i64 overflow.
const ALL: usize = 1_000_000;
use crate::revisions::{RevisionInfo, Revisions, fnv64};
use crate::names::{NoteFile, note_path, title_ok, parse_note_file};
use crate::store::{SaveResult, Store, hash, meta_of};
use crate::text::{fold, link_mention_text, rewrite_links};
use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
pub struct TimelineRow { pub path: String, pub title: String, pub date: i64, pub snippet: String, pub locked: bool, pub archived: bool }

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum TimelineBy { Created, Updated }

/// `text` with the task on `line` (0-based) flipped, if that line still reads `expected`; and the flipped line.
pub fn toggled_text(text: &str, line: usize, expected: &str) -> anyhow::Result<(String, String)> {
    let moved = || anyhow!("task-moved");
    let mut lines: Vec<&str> = text.split('\n').collect();
    let cur = *lines.get(line).ok_or_else(moved)?;
    // parse_tasks skips fenced code, which toggle_line alone would not
    if cur.strip_suffix('\r').unwrap_or(cur) != expected || !parse_tasks(text).iter().any(|t| t.line == line) {
        return Err(moved());
    }
    let new = toggle_line(cur, &local_today()).ok_or_else(moved)?;
    lines[line] = &new;
    Ok((lines.join("\n"), new.strip_suffix('\r').unwrap_or(&new).to_string()))
}

/// `target` with `source` merged in: the source's front-matter tags, its aliases and its title as aliases (except one
/// naming the target), and its body appended under `## {source_title}`. Keeps the target's line endings.
pub fn merged_text(target: &str, target_title: &str, source: &str, source_title: &str) -> Result<String, String> {
    let src_fm = frontmatter::parse(source);
    let (tags, mut aliases) = src_fm.map_or((vec![], vec![]), |f| (f.tags, f.aliases));
    let t = frontmatter::set_tags(target, &tags, &[], true)?.unwrap_or_else(|| target.to_string());
    aliases.push(source_title.to_string());
    aliases.retain(|a| fold(a) != fold(target_title));
    // the alias block is written even without write_front_matter: it keeps [[Source]] resolving
    let t = frontmatter::add_aliases(&t, &aliases)?.unwrap_or(t);
    let eol = if target.contains("\r\n") { "\r\n" } else { "\n" };
    let src = frontmatter::body(source);
    let start = src.len() - src.trim_start().len();
    let src = &src[src[..start].rfind('\n').map_or(0, |i| i + 1)..]; // leading blank lines dropped, indentation kept
    let src = src.trim_end().replace("\r\n", "\n").replace('\n', eol);
    let head = t.trim_end();
    let mut out = head.to_string();
    if !head.is_empty() {
        out.push_str(eol);
        if !frontmatter::body(&t).trim().is_empty() { out.push_str(eol); }
    }
    out.push_str(&format!("## {source_title}{eol}"));
    if !src.is_empty() { out.push_str(&format!("{eol}{src}{eol}")); }
    Ok(out)
}

/// Lines in `text`'s front-matter block (0 without one).
pub fn fm_lines(t: &str) -> usize {
    frontmatter::parse(t).map_or(0, |f| t[..f.end].matches('\n').count())
}

/// Where a toggled task is in the text as saved (after front-matter stamping): what undo sends back.
#[derive(Serialize, Debug, PartialEq)]
pub struct Toggled {
    pub line: usize,
    pub line_text: String,
    /// The note's hash as this save left it: what an agent is told, never a later read that may cover newer typing.
    #[serde(skip)]
    pub hash: String,
}

#[derive(Serialize)]
pub struct NoteDoc {
    pub path: String,
    pub title: String,
    pub text: String,
    /// hash of the on-disk bytes (ciphertext for encrypted notes)
    pub hash: String,
    pub encrypted: bool,
    pub archived: bool,
    pub meta: NoteMeta,
}

/// Dates are epoch ms; `*_src` is "frontmatter" or "file".
#[derive(Serialize, Default)]
pub struct NoteMeta {
    pub created: i64,
    pub created_src: String,
    pub modified: i64,
    pub modified_src: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
}

#[derive(Serialize)]
pub struct RenameResult {
    pub path: String,
    pub rewritten: usize,
}

/// `trash_error`: the source could not be moved to the Trash (the merge itself is done).
#[derive(Serialize, Debug)]
pub struct MergeResult {
    pub path: String,
    pub rewritten: usize,
    pub trash_error: Option<String>,
}

pub struct Vault {
    pub store: Store,
    pub index: Index,
    /// plaintext of unlocked encrypted notes, memory only
    unlocked: HashMap<String, String>,
    revisions: Revisions,
    /// the entries last loaded into the index's archived table (empty = the empty table)
    archive_loaded: std::cell::RefCell<Vec<String>>,
    /// latest list-write failure; `take()` reads and clears it. Whoever runs a note operation takes it before
    /// releasing the vault's lock (`run_reporting`, `AppOps::with`, the direct-mode `gate`), so it never reaches
    /// another caller.
    pub archive_error: std::cell::Cell<Option<String>>,
    archive_read_logged: std::cell::Cell<bool>,
    /// deleted notes whose index removal failed (a plain twin's text stays searchable until then): the next
    /// `apply_fs_changes` (any watcher event, rescan or agent call) tries them again
    retry: Vec<PathBuf>,
    /// inside `deferring_resync`: a locked note that came or went, so its end re-syncs twins once for the whole call
    resync_deferred: Option<Option<PathBuf>>,
    /// twin re-sync scans run (`resync_twins`), for tests
    #[cfg(test)]
    resync_scans: usize,
}

/// The plain notes in the folder by folded title, read at most once per chunk (`None` inside: the folder or an entry
/// could not be read, a doubt).
type FoldListing = Option<Option<HashMap<String, Vec<PathBuf>>>>;

fn s(p: &Path) -> String {
    crate::names::nfc_name(p).to_string_lossy().into_owned() // one index key per note, however the volume spells it
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn stat(p: &Path) -> anyhow::Result<Meta> {
    Ok(meta_of(&std::fs::metadata(p)?))
}

/// From the plaintext in memory, so unlocked notes show their real front-matter dates.
fn note_meta(text: &str, m: &Meta) -> NoteMeta {
    let fm = frontmatter::parse(text);
    let (created, cs, modified, ms) = effective_dates(fm.as_ref(), m);
    let tags = all_tags(frontmatter::body(text), fm.as_ref()).into_iter().map(|(_, d)| d).collect();
    NoteMeta { created, created_src: cs.into(), modified, modified_src: ms.into(), tags, aliases: fm.map(|f| f.aliases).unwrap_or_default() }
}

/// A plain note (`X.md` or `X.txt`) with the locked note `X.md.age` beside it: a lock synced in before the delete,
/// or a lock that failed to remove the plaintext. It counts as locked: never saved, snapshotted as plaintext,
/// rewritten or shown to the agent.
/// The disk resolves the name (a case-insensitive one pairs `Meeting.md` with `meeting.md.age`, with its own case
/// folding) and follows links. Only a regular file or a dangling link at that name is a locked copy; any other stat
/// error (permission, I/O) counts as one too, so a doubt never makes the plain text searchable.
pub fn plain_twin_of_locked(path: &Path) -> bool {
    twin_state(path) != Some(false)
}

/// `plain_twin_of_locked`, with `None` where the disk can't tell (a stat error): a note decided on its own fails
/// closed, a scan over every row leaves the row as it is.
fn twin_state(path: &Path) -> Option<bool> {
    match parse_note_file(path).filter(|n| !n.encrypted).and_then(|n| Some(note_path(path.parent()?, &n.title, true))) {
        Some(locked) => note_file_at(&locked),
        None => Some(false),
    }
}

/// Whether `p` is a note file on disk, as the twin rule sees one: a regular file after following links, or a
/// dangling link (fail closed). Not one: nothing, a folder, a socket or device, a name too long to exist. `None`: a
/// stat error says nothing either way.
fn note_file_at(p: &Path) -> Option<bool> {
    #[cfg(test)]
    let injected = tests::STAT_FAIL.with(|f| f.get()).filter(|_| s(p).ends_with(".md.age"));
    #[cfg(not(test))]
    let injected: Option<std::io::ErrorKind> = None;
    match injected.map_or_else(|| std::fs::metadata(p), |k| Err(k.into())) {
        Ok(m) => Some(m.is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(p.symlink_metadata().is_ok()),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidFilename => Some(false),
        Err(_) => None,
    }
}

/// `note_file_at`, failing closed: for a note decided on its own (reversible: what its row may hold, whether it is
/// indexed). Never for an irreversible step, which needs `metadata().is_file()`.
fn file_on_disk(p: &Path) -> bool {
    note_file_at(p) != Some(false)
}

/// The text `path`'s row may hold: none for a plain twin of a locked note, whose row is marked with `TWIN_SIZE` so
/// `diff` re-checks it once the twin ends (a locked note's text never reaches `Index::upsert` either). Every write of
/// note text into the index goes through here.
fn row_text<'a>(path: &Path, meta: &mut Meta, body: Option<&'a str>) -> Option<&'a str> {
    if plain_twin_of_locked(path) {
        meta.size = TWIN_SIZE;
        return None;
    }
    body
}

/// Lock/unlock's last step once `to` is written: remove `from`. Already gone (a sync or Finder deleted it) is success:
/// `to` is now the only copy. Any other failure removes `to`, so the error is true and no twin is left (a plain twin
/// would leak and keep syncing; a locked one would refuse every save of the plain note).
fn finish_move(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(from) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound && from.exists() => {
            std::fs::remove_file(to).ok();
            Err(e)
        }
        _ => Ok(()),
    }
}

fn parse(p: &Path) -> anyhow::Result<NoteFile> {
    parse_note_file(p).ok_or_else(|| anyhow!("not a note file: {}", p.display()))
}

/// macOS uses NSFileManager instead of the crate's Finder default, which drives Finder over AppleScript
/// (Automation permission prompt; denying it would break every later delete).
pub(crate) fn move_to_trash(p: &Path) -> std::io::Result<()> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(p).map_err(|e| std::io::Error::other(e.to_string()))
}

/// `notes.size` of a plain twin of a locked note, stored without its text: no file has this size, so `diff` sees the
/// row as stale whenever the file is no longer a twin, even with its mtime and size unchanged.
const TWIN_SIZE: u64 = u64::MAX;

/// Notes per index transaction in bulk paths (10k-note cold build: 500 writes 544 MB, 2000 writes 270 MB, one transaction 155 MB).
const CHUNK: usize = 2000;

/// Notes replaced or removed from the index from which a bulk re-index (`Index::begin_bulk`) pays off: secure deletes
/// cost ~13 ms each, the closing FTS rebuild ~1 s at 10k notes.
pub const BULK: usize = 100;

impl Vault {
    /// `progress(done, total)` counts files needing (re)indexing; every 250 files and at the end, never when none.
    pub fn open_with_progress(dir: PathBuf, db_path: &Path, identity: Option<&str>, progress: &mut dyn FnMut(usize, usize)) -> anyhow::Result<Vault> {
        // revisions live next to the index db (the app data dir), keyed by vault dir
        let root = db_path.parent().unwrap_or(Path::new(".")).join("revisions").join(fnv64(&dir.to_string_lossy()));
        let mut v = Vault { store: Store::new(dir), index: Index::open(db_path)?, unlocked: HashMap::new(), revisions: Revisions::new(root), archive_loaded: Default::default(), archive_error: Default::default(), archive_read_logged: Default::default(), retry: Vec::new(), resync_deferred: None, #[cfg(test)] resync_scans: 0 };
        v.revisions.maybe_prune(now_ms());
        v.store.clean_leftovers();
        let files = v.store.list()?;
        let (stale, gone, replaced) = v.diff(&files)?;
        let total = stale.len();
        // `replaced`, not `total`: a cold build deletes nothing, so it needs no bulk
        if replaced >= BULK {
            v.index.begin_bulk().ok(); // no room: as on main, slow but safe
        }
        v.deferring_resync(|v| -> anyhow::Result<()> {
            // One transaction per chunk: a crash loses at most a chunk, which isn't in `known()`, so the next open redoes it.
            v.index.begin()?;
            for (i, (path, nf, meta)) in stale.into_iter().enumerate() {
                if let Ok(bytes) = v.read_for_index(path) {
                    let mut meta = Meta { ..*meta };
                    let body = bytes.map(|b| lossy(&b));
                    let body = row_text(path, &mut meta, body.as_deref()); // see `reindex`
                    v.index.upsert(&s(path), nf, &meta, body)?;
                }
                if (i + 1) % CHUNK == 0 {
                    v.index.commit()?;
                    v.index.begin()?;
                }
                if (i + 1) % 250 == 0 || i + 1 == total {
                    progress(i + 1, total);
                }
            }
            for g in &gone {
                v.remove_note(g)?;
            }
            v.index.commit()
        })?;
        v.index.finish_bulk(); // ours, or an interrupted one
        // Don't keep a bulk build's WAL (or a crashed session's) for the whole session. Best effort: a full disk must
        // not keep the vault closed.
        v.index.checkpoint().ok();
        if let Some(id) = identity {
            for (path, nf, _) in &files {
                if nf.encrypted {
                    v.try_unlock(path, id);
                }
            }
        }
        Ok(v)
    }

    /// Files whose mtime or size differ from the index, and indexed paths no longer on disk.
    /// Also how many indexed notes those replace or remove.
    #[allow(clippy::type_complexity)]
    fn diff<'a>(&self, files: &'a [(PathBuf, NoteFile, Meta)]) -> anyhow::Result<(Vec<&'a (PathBuf, NoteFile, Meta)>, Vec<String>, usize)> {
        let known = self.index.known()?;
        // A plain twin's row matches only with `TWIN_SIZE`: a twin indexed with its text (an index from an older build,
        // a crash mid-lock) or a former twin indexed without it is stale, whatever its mtime and size. Twins as `reindex`
        // sees them, from the disk: one more stat per unchanged plain note, so the two never disagree.
        let stale: Vec<_> = files.iter().filter(|(path, _, meta)| !known.get(&s(path)).is_some_and(|k| k.mtime == meta.mtime && match twin_state(path) {
            Some(twin) => k.size == if twin { TWIN_SIZE } else { meta.size },
            None => k.size == TWIN_SIZE || k.size == meta.size, // the disk can't tell: keep the row as it is
        })).collect();
        let present: std::collections::HashSet<String> = files.iter().map(|(p, ..)| s(p)).collect();
        let gone: Vec<String> = known.keys().filter(|k| !present.contains(*k)).cloned().collect();
        let replaced = stale.iter().filter(|(p, ..)| known.contains_key(&s(p))).count() + gone.len();
        Ok((stale, gone, replaced))
    }

    /// Re-check the whole folder against the index (the watcher missed events, or they came before it started).
    pub fn rescan(&mut self, identity: Option<&str>) -> Vec<String> {
        self.try_rescan(identity).unwrap_or_default()
    }

    /// `rescan`, failing when the folder or the index can't be read.
    pub fn try_rescan(&mut self, identity: Option<&str>) -> anyhow::Result<Vec<String>> {
        let (paths, _) = self.stale_paths()?;
        Ok(self.apply_fs_changes(&paths, identity))
    }

    /// Paths a rescan would apply (files that differ from the index, indexed notes no longer on disk), and how many
    /// indexed notes they replace or remove.
    pub fn stale_paths(&self) -> anyhow::Result<(Vec<PathBuf>, usize)> {
        let files = self.store.list()?;
        let (stale, gone, replaced) = self.diff(&files)?;
        Ok((stale.into_iter().map(|(p, ..)| p.clone()).chain(gone.into_iter().map(PathBuf::from)).collect(), replaced))
    }

    /// A note file directly inside the notes folder; anything else is refused (paths come from the webview).
    fn note(&self, p: &Path) -> anyhow::Result<NoteFile> {
        if p.parent() != Some(self.store.dir.as_path()) {
            return Err(anyhow!("not a note in the notes folder"));
        }
        parse(p)
    }

    /// `note_meta`, with a file-dated created no later than the indexed one (see `Index::upsert`).
    fn note_meta(&self, path: &str, text: &str, m: &Meta) -> NoteMeta {
        let mut meta = note_meta(text, m);
        if meta.created_src == "file" && let Ok(Some(c)) = self.index.created_from_file(path) {
            meta.created = meta.created.min(c);
        }
        meta
    }

    fn try_unlock(&mut self, path: &Path, identity: &str) {
        if let Ok(plain) = self.store.read(path).and_then(|b| crypto::decrypt(identity, &b).map_err(std::io::Error::other)) {
            self.unlocked.insert(s(path), lossy(&plain));
        }
    }

    /// Index a file already on disk; plaintext `body` is dropped for encrypted notes, and for a plain twin of a locked
    /// note: it counts as locked, and may be one a lock is erasing right now in this or another process (`velo --mcp`
    /// direct mode), which writes the locked copy first so no re-index here can put the text back.
    /// Such a twin's row is stored with `TWIN_SIZE`, so `diff` re-checks it once the twin ends.
    /// Every re-index of a locked note first re-indexes the rows of its plain twins by name (`X.md`, `X.txt`): a few
    /// lookups, before its own row is written, so neither a failed write nor our own write's skipped event (a locked
    /// copy re-created under the open editor) leaves their text. A locked note new to the index also scans every row
    /// (see `resync_twins`) for the twins a name can't find. A plain file arriving later asks the rule.
    fn reindex(&mut self, path: &Path, body: Option<&str>) -> anyhow::Result<()> {
        let nf = self.note(path)?;
        let key = s(path);
        // before the stat too: a locked copy that can't be stat'ed still locks its twins
        if nf.encrypted && let Some(dir) = path.parent() {
            for ext in ["md", "txt"] {
                let p = dir.join(format!("{}.{ext}", nf.title));
                // only an existing row under this exact spelling: a case-insensitive disk opens other spellings too
                if self.index.title_modified(&s(&p)).map_or(true, |r| r.is_some()) {
                    match self.read_for_index(&p) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        r => {
                            if r.map_err(anyhow::Error::from).and_then(|b| self.reindex(&p, b.map(|b| lossy(&b)).as_deref())).is_err() {
                                self.retry.push(p);
                            }
                        }
                    }
                }
            }
            if self.index.title_modified(&key).ok().flatten().is_none() {
                self.resync_twins(path);
            }
        }
        let mut meta = stat(path)?;
        let body = row_text(path, &mut meta, body);
        self.index.upsert(&key, &nf, &meta, body)?;
        Ok(())
    }

    /// A locked note appeared or went away: re-index its plain twins (`X.md`, `X.txt`) from disk, so `reindex` drops
    /// their text while it exists and restores it once it is gone (its file keeps its mtime and size, so nothing else
    /// would). A failure is retried at the next change.
    /// The twins are the plain rows whose `TWIN_SIZE` mark disagrees with `plain_twin_of_locked`: the disk decides,
    /// never a name built or folded here (`What?.md` pairs with `What-.md.age`, `Straße.md` with `STRASSE.md.age`).
    /// Rows, not the folder listing: a row under a spelling the folder no longer lists (a case-only rename outside
    /// Velo) is asked too. One stat per plain row (about 30 ms at 10k notes), once per `deferring_resync` call.
    fn resync_twins(&mut self, locked: &Path) {
        if !parse_note_file(locked).is_some_and(|n| n.encrypted) {
            return;
        }
        if let Some(d) = &mut self.resync_deferred {
            *d = Some(locked.to_path_buf());
            return;
        }
        #[cfg(test)]
        {
            self.resync_scans += 1;
        }
        let Ok(known) = self.index.known() else {
            self.retry.push(locked.to_path_buf()); // applying it again re-syncs its twins
            return;
        };
        let mut gone: Vec<String> = Vec::new();
        let mut doubt = false;
        for (key, k) in known {
            let p = PathBuf::from(&key);
            if !parse_note_file(&p).is_some_and(|n| !n.encrypted) {
                continue;
            }
            // a stat error leaves the row as it is (it would strip every note on a failing disk): asked again later
            let Some(twin) = twin_state(&p) else {
                doubt = true;
                continue;
            };
            if (k.size == TWIN_SIZE) != twin {
                let r = match self.read_for_index(&p) {
                    // a row whose file is gone, now a twin: no delete event may ever name it (a row under an old
                    // spelling), so erase it here
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        gone.push(key);
                        Ok(())
                    }
                    r => r.map_err(anyhow::Error::from).and_then(|b| self.reindex(&p, b.map(|b| lossy(&b)).as_deref())),
                };
                if r.is_err() {
                    self.retry.push(p);
                }
            }
        }
        if doubt {
            self.retry.push(locked.to_path_buf()); // applying it again scans again
        }
        if gone.is_empty() {
            return;
        }
        // In a batch of its own: an erase there doesn't end a bulk (see `remove_erasing`), whose finish (or this
        // checkpoint, outside one) drops the older copies.
        let own = !self.index.in_batch() && self.index.begin().is_ok();
        let failed: Vec<PathBuf> = gone.iter().filter(|k| self.index.remove_erasing(k).is_err()).map(PathBuf::from).collect();
        let all = own && self.index.commit().is_err();
        self.retry.extend(if all { gone.iter().map(PathBuf::from).collect() } else { failed }); // applied again: a missing file is a deletion
        if !self.index.bulk_off() {
            self.index.checkpoint().ok();
        }
    }

    /// Runs `f` with twin re-syncs held back, then runs one (`resync_twins`) if `f` added or removed a locked note,
    /// whatever `f` returned: the one owner of "re-sync needed", so a batch scans once, not once per locked note.
    /// Nested calls join the outer one. Each call of `apply_fs_changes` is one batch: the app's watcher and rescans
    /// apply chunks of 100 (700 in a bulk), each releasing the vault, so a re-sync never waits past its chunk.
    fn deferring_resync<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> T {
        let outer = self.resync_deferred.is_none();
        if outer {
            self.resync_deferred = Some(None);
        }
        let r = f(self);
        if outer && let Some(Some(locked)) = self.resync_deferred.take() {
            self.resync_twins(&locked);
        }
        r
    }

    /// `p`'s bytes for the index, or `None` for a file whose row needs none and that can't be read (evicted by iCloud,
    /// held by a sync): a locked note, or a plain twin of one. Such a file is still indexed, without its text, so a
    /// locked copy that can't be read yet still takes the text of its plain twin. A folder keeps its error: no row.
    fn read_for_index(&self, p: &Path) -> std::io::Result<Option<Vec<u8>>> {
        match self.store.read(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound && file_on_disk(p) && (parse_note_file(p).is_some_and(|n| n.encrypted) || plain_twin_of_locked(p)) => Ok(None),
            r => r.map(Some),
        }
    }

    /// A failed lock left its locked copy `to` on disk: index it now (the watcher would skip it as our own write),
    /// which also takes the plain twin's text, or retry it at the next change.
    fn list_stray_lock(&mut self, to: &Path, locked: &[u8]) {
        self.store.take_self_write(to, locked);
        self.deferring_resync(|v| {
            if v.reindex(to, None).is_err() {
                v.retry.push(to.to_path_buf());
            }
            v.resync_twins(to); // also over a stale row of `to`
        });
    }

    pub fn search(&self, query: &str, sort: Sort, offset: usize, tags: &[String]) -> anyhow::Result<Page> {
        self.search_where(query, sort, offset, tags, false, false)
    }

    pub fn search_where(&self, query: &str, sort: Sort, offset: usize, tags: &[String], no_links: bool, include_archived: bool) -> anyhow::Result<Page> {
        self.sync_archive();
        let mut page = self.index.search_page_where(query, sort, offset, PAGE, tags, &self.unlocked, no_links, include_archived)?;
        // nothing archived: hidden is 0 by definition. saturating: another process can change the note set between the two reads
        if !include_archived && offset == 0 && !self.archive_loaded.borrow().is_empty() {
            page.hidden = self.index.search_page_where(query, sort, 0, 0, tags, &self.unlocked, no_links, true)?.total.saturating_sub(page.total);
        }
        Ok(page)
    }

    /// Load the list file into the index when it differs from what is loaded. Compares content, not mtime: an
    /// equal-size rewrite in one timestamp tick must not be missed. A read failure keeps the loaded set and is retried
    /// at the next query; only the first one per vault is logged.
    pub fn sync_archive(&self) {
        let list = match crate::archive::read(&self.store.dir) {
            Ok(l) => l,
            Err(e) => return self.log_archive_read(&e),
        };
        if *self.archive_loaded.borrow() != list && self.index.set_archived(&list).is_ok() {
            *self.archive_loaded.borrow_mut() = list;
        }
    }

    fn log_archive_read(&self, e: &std::io::Error) {
        if !self.archive_read_logged.replace(true) {
            let m = format!("cannot read {}: {e}", crate::archive::FILE);
            crate::log::line(&m);
            eprintln!("{m}");
        }
    }

    fn archive_edit(&mut self, change: impl FnOnce(&mut Vec<String>)) -> anyhow::Result<()> {
        debug_assert!(!self.index.in_batch());
        let entries = crate::archive::update(&self.store.dir, change)?;
        if *self.archive_loaded.borrow() != entries {
            self.index.set_archived(&entries)?;
            *self.archive_loaded.borrow_mut() = entries;
        }
        Ok(())
    }

    /// `archive_edit` for a note operation that already succeeded: a failure is logged and kept in `archive_error`,
    /// never returned. Runs after the operation's index batch has committed.
    /// An unreadable list (checked first, so only write failures reach `archive_error`) is logged once per vault.
    fn archive_follow(&mut self, change: impl FnOnce(&mut Vec<String>)) {
        if let Err(e) = crate::archive::read(&self.store.dir) {
            return self.log_archive_read(&e);
        }
        if let Err(e) = self.archive_edit(change) {
            let m = format!("cannot update {}: {e}", crate::archive::FILE);
            crate::log::line(&m);
            eprintln!("{m}");
            self.archive_error.set(Some(e.to_string())); // the reason only: the reports name the list themselves
        }
    }

    /// The list on disk has an entry for `title` (an unreadable list counts as listed): only then is there anything to
    /// keep or drop. Read fresh: another process may have archived it since this vault last loaded the list.
    fn listed(&self, title: &str) -> bool {
        let f = fold(title);
        crate::archive::read(&self.store.dir).map_or(true, |l| l.iter().any(|t| fold(t) == f))
    }

    /// Some file in the vault other than `except` has a title folding to `title` (a twin: `Foo.md` beside `Foo.txt`).
    fn title_on_disk(&self, title: &str, except: &Path) -> bool {
        let f = fold(title);
        self.store.list().map_or(true, |l| l.iter().any(|(p, n, _)| crate::names::nfc_name(p) != crate::names::nfc_name(except) && fold(&n.title) == f))
    }

    /// The note now at `to` moved from title `old` to `new`. A stale entry for `new` is cleared and only an archived
    /// note carries its entry over; a twin still on disk keeps `old`'s entry, and a file other than `to` already
    /// holding `new` keeps `new`'s state: the move never flips it.
    fn archive_retitle(&mut self, old: &str, new: &str, to: &Path) {
        let moved = fold(old) != fold(new);
        let twin = moved && self.listed(old) && self.title_on_disk(old, to);
        let held = moved && self.title_on_disk(new, to);
        self.archive_follow(|e| {
            let was = e.iter().any(|t| fold(t) == fold(old));
            if was && !twin {
                e.retain(|t| fold(t) != fold(old));
            }
            if !held {
                e.retain(|t| fold(t) != fold(new));
                if was {
                    e.push(new.to_string());
                }
            }
        });
    }

    /// Archive or unarchive the note at `path`; never reads, decrypts or rewrites the note.
    pub fn set_archived(&mut self, path: &str, on: bool) -> anyhow::Result<()> {
        let title = self.note(Path::new(path))?.title;
        let f = fold(&title);
        self.archive_edit(|e| {
            e.retain(|t| fold(t) != f);
            if on {
                e.push(title);
            }
        })
    }

    /// Every note matching the search filters, newest first by `by`, dated by its indexed created/modified; `since_ms` drops older ones.
    /// Snippets are blanked for locked notes: an unlocked-in-memory one would otherwise carry its body.
    pub fn timeline(&self, query: &str, tags: &[String], no_links: bool, include_archived: bool, by: TimelineBy, since_ms: Option<i64>) -> anyhow::Result<Vec<TimelineRow>> {
        self.sync_archive();
        let dates = self.index.dates()?;
        let mut rows: Vec<TimelineRow> = self.index.search_page_where(query, Sort::Modified, 0, ALL, tags, &self.unlocked, no_links, include_archived)?.hits.into_iter().filter_map(|h| {
            let &(c, m) = dates.get(&h.path)?;
            let date = match by { TimelineBy::Created => c, TimelineBy::Updated => m };
            let snippet = if h.encrypted { String::new() } else { h.snippet };
            Some(TimelineRow { path: h.path, title: h.title, date, snippet, locked: h.encrypted, archived: h.archived })
        }).filter(|r| since_ms.is_none_or(|s| r.date >= s)).collect();
        rows.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.path.cmp(&b.path)));
        Ok(rows)
    }

    /// Open and recent tasks; unlocked notes' tasks come from memory, so they never reach SQLite.
    pub fn tasks(&self, query: &str, tags: &[String], show_done: bool, include_archived: bool) -> anyhow::Result<TaskView> {
        self.sync_archive();
        let mut rows = self.index.task_rows(tags, include_archived)?;
        let archived = self.index.archived_titles()?;
        let wanted: Vec<String> = tags.iter().map(|t| fold(t)).collect();
        for (path, plain) in &self.unlocked {
            let Some((title, modified)) = self.index.title_modified(path)? else { continue };
            let arc = archived.contains(&fold(&title));
            if arc && !include_archived {
                continue;
            }
            let have = all_tags(frontmatter::body(plain), frontmatter::parse(plain).as_ref());
            if !wanted.iter().all(|w| have.iter().any(|(h, _)| h == w)) {
                continue;
            }
            rows.extend(parse_tasks(plain).into_iter().map(|t| TaskRow { path: path.clone(), title: title.clone(), modified, line: t.line, text: t.text, done: t.done, due: t.due, done_on: t.done_on, line_text: t.line_text, archived: arc }));
        }
        Ok(group_tasks(rows, query, show_done, &local_today()))
    }

    /// Tags of plain notes only: unlocked notes' tags stay in memory and out of this list.
    pub fn tags(&self, include_archived: bool) -> anyhow::Result<Vec<TagCount>> {
        self.sync_archive();
        self.index.tags(include_archived)
    }

    pub fn titles(&self) -> anyhow::Result<Vec<String>> {
        self.index.titles()
    }

    pub fn link_targets(&self, include_archived: bool) -> anyhow::Result<Vec<LinkTarget>> {
        self.sync_archive();
        self.index.link_targets(include_archived)
    }

    /// A new plain note `title` holding `text`; refuses a title another note (locked ones too) already names. Returns its path.
    pub fn create_from_selection(&mut self, title: &str, text: &str, write_fm: bool) -> anyhow::Result<String> {
        if !title_ok(title) {
            return Err(anyhow!("invalid-title"));
        }
        let (title, dir) = (title.trim(), self.store.dir.clone());
        if self.find_note(title)?.is_some() || note_path(&dir, title, false).exists() || note_path(&dir, title, true).exists() {
            return Err(anyhow!("already-exists"));
        }
        // a selection that opens with a `---` block would read as front matter: a leading newline keeps it body
        let text = if frontmatter::parse(text).is_some() { format!("\n{text}") } else { text.to_string() };
        let now = chrono::Local::now().fixed_offset();
        let content = if write_fm { frontmatter::stamp(&text, now, now) } else { text };
        let p = note_path(&dir, title, false);
        self.store.write_atomic(&p, content.as_bytes())?;
        self.reindex(&p, Some(&content))?;
        self.archive_follow(|e| e.retain(|t| fold(t) != fold(title)));
        Ok(s(&p))
    }

    pub fn open_note(&mut self, path: &str, identity: Option<&str>) -> anyhow::Result<NoteDoc> {
        self.sync_archive();
        let p = Path::new(path);
        let nf = self.note(p)?;
        let bytes = self.store.read(p)?;
        let text = if nf.encrypted {
            let id = identity.ok_or_else(|| anyhow!("locked"))?;
            let plain = lossy(&crypto::decrypt(id, &bytes)?);
            self.unlocked.insert(path.to_string(), plain.clone());
            plain
        } else {
            lossy(&bytes)
        };
        let meta = self.note_meta(path, &text, &stat(p)?);
        // the list, not the index: a file the index has not seen yet has no row there
        let archived = self.archive_loaded.borrow().iter().any(|t| fold(t) == fold(&nf.title));
        Ok(NoteDoc { path: path.into(), title: nf.title, text, archived, hash: hash(&bytes), encrypted: nf.encrypted, meta })
    }

    /// The existing note `title` names (title or alias, case-folded): the one open_or_create and capture_task use.
    pub fn find_note(&self, title: &str) -> anyhow::Result<Option<String>> {
        self.index.find_title(title)
    }

    pub fn open_or_create(&mut self, title: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<NoteDoc> {
        self.open_or_create_new(title, identity, write_fm).map(|(doc, _)| doc)
    }

    /// Like `open_or_create`; true = this call wrote the file.
    pub fn open_or_create_new(&mut self, title: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<(NoteDoc, bool)> {
        if let Some(path) = self.find_note(title)? {
            return Ok((self.open_note(&path, identity)?, false));
        }
        let p = note_path(&self.store.dir, title, false);
        let created = !p.exists();
        if created {
            let now = chrono::Local::now().fixed_offset();
            let init = if write_fm { frontmatter::stamp("", now, now) } else { String::new() };
            self.store.write_atomic(&p, init.as_bytes())?;
        }
        let body = lossy(&self.store.read(&p)?);
        self.reindex(&p, Some(&body))?;
        if created && let Some(written) = parse_note_file(&p) {
            self.archive_follow(|e| e.retain(|t| fold(t) != fold(&written.title)));
        }
        Ok((self.open_note(&s(&p), identity)?, created))
    }

    /// Tick or untick the task on `line` (0-based) if it still reads `expected`; saves through `save_note`.
    pub fn toggle_task(&mut self, path: &str, line: usize, expected: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<Toggled> {
        let doc = self.open_note(path, identity)?;
        self.toggle_in(doc, line, expected, identity, write_fm)
    }

    fn toggle_in(&mut self, doc: NoteDoc, line: usize, expected: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<Toggled> {
        let (text, line_text) = toggled_text(&doc.text, line, expected)?;
        match self.save_note(&doc.path, &text, &doc.hash, identity, write_fm)? {
            // stamping may replace or prepend the front-matter block: shift the line by its change in height
            SaveResult::Saved { front_matter, hash, .. } => Ok(Toggled { line: line - fm_lines(&text) + front_matter.as_deref().map_or(fm_lines(&text), fm_lines), line_text, hash }),
            SaveResult::Conflict { .. } => Err(anyhow!("task-moved")), // disk changed since we read it
        }
    }

    /// Append `- [ ] text` to the note titled `title` (created if missing); returns its path.
    pub fn capture_task(&mut self, title: &str, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<String> {
        if text.trim().is_empty() { return Err(anyhow!("empty")); }
        let path = self.open_or_create(title, identity, write_fm)?.path;
        self.append_task(&path, text, identity, write_fm).map(|(p, _)| p)
    }

    /// Append `- [ ] text` to the note at `path`; returns the path and the hash its save left.
    pub fn append_task(&mut self, path: &str, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<(String, String)> {
        let text = text.trim().replace(['\r', '\n'], " ");
        if text.is_empty() { return Err(anyhow!("empty")); }
        let doc = self.open_note(path, identity)?;
        self.append_in(doc, &text, identity, write_fm)
    }

    fn append_in(&mut self, doc: NoteDoc, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<(String, String)> {
        let eol = if doc.text.contains("\r\n") { "\r\n" } else { "\n" };
        let sep = if doc.text.is_empty() || doc.text.ends_with('\n') { "" } else { eol };
        match self.save_note(&doc.path, &format!("{}{sep}- [ ] {text}{eol}", doc.text), &doc.hash, identity, write_fm)? {
            SaveResult::Saved { hash, .. } => Ok((doc.path, hash)),
            SaveResult::Conflict { .. } => Err(anyhow!("conflict")),
        }
    }

    pub fn save_note(&mut self, path: &str, text: &str, base_hash: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<SaveResult> {
        let p = Path::new(path);
        let nf = self.note(p)?;
        let encrypted = nf.encrypted;
        // A stale editor bound to the pre-lock path must not resurrect the plaintext next to Title.md.age.
        if plain_twin_of_locked(p) {
            return Err(anyhow!("locked-sibling"));
        }
        let orig = text;
        let now = chrono::Local::now().fixed_offset();
        let stamped = write_fm.then(|| {
            // created fallback: the file's earliest time before this write (now if missing)
            let ms = stat(p).map_or(now.timestamp_millis(), |m| effective_dates(None, &m).0);
            let created = chrono::DateTime::from_timestamp_millis(ms).map_or(now, |d| d.with_timezone(&chrono::Local).fixed_offset());
            frontmatter::stamp(text, now, created)
        });
        let text = stamped.as_deref().unwrap_or(text);
        let bytes = if encrypted {
            crypto::encrypt(identity.ok_or_else(|| anyhow!("locked"))?, text.as_bytes())?
        } else {
            text.as_bytes().to_vec()
        };
        let before = crate::store::read_regular(p).ok(); // the version this save replaces, for the revision snapshot
        let mut res = self.store.save(p, &bytes, base_hash)?;
        let target = match &res {
            SaveResult::Saved { .. } => p.to_path_buf(),
            SaveResult::Conflict { conflict_path, .. } => PathBuf::from(conflict_path),
        };
        self.reindex(&target, (!encrypted).then_some(text))?;
        if let Some(c) = parse_note_file(&target).filter(|_| target != p) {
            self.archive_follow(|e| e.retain(|t| fold(t) != fold(&c.title)));
        }
        // Snapshot the bytes this save replaced, as they were on disk (ciphertext when locked); a conflict replaced nothing.
        // A failed snapshot must never fail a save that already hit the disk.
        if let (SaveResult::Saved { .. }, Some(before)) = (&res, before.filter(|b| !b.is_empty())) {
            self.revisions.maybe_prune(now_ms());
            self.revisions.snapshot_bytes(&nf.title, &before, encrypted, now_ms(), true).ok();
        }
        if encrypted {
            self.unlocked.insert(s(&target), text.to_string());
        }
        if let SaveResult::Saved { front_matter, meta, .. } = &mut res {
            *meta = self.note_meta(&s(&target), text, &stat(&target)?);
            *front_matter = stamped.as_deref().filter(|t| *t != orig).and_then(|t| frontmatter::parse(t).map(|f| t[..f.end].to_string()));
        }
        Ok(res)
    }

    /// Wrap the first mention of `target` in `path` as a link. With the editor's `editor_text` it only returns the
    /// rewritten text (the editor saves it); otherwise it saves through `save_note` and returns None.
    /// A locked note, or the plain twin of one, is never rewritten from here.
    pub fn link_mention(&mut self, path: &str, target: &str, expected: usize, editor_text: Option<&str>, write_fm: bool, include_archived: bool) -> anyhow::Result<Option<String>> {
        if self.note(Path::new(path))?.encrypted || self.locked_twin(path) {
            return Err(anyhow!("locked"));
        }
        // the same names the Related panel offered: archived ones only when it showed them
        self.sync_archive();
        let mut hidden = if include_archived { HashSet::new() } else { self.index.archived_paths()? };
        hidden.remove(path); // the centre keeps its own names, as in `connections::build`
        let names: HashSet<String> = self.index.names()?.into_iter().filter(|(_, p)| !hidden.contains(p)).map(|(n, _)| n).collect();
        let rewrite = |text: &str| link_mention_text(text, target, &names, expected).map_err(|e| anyhow!(e));
        if let Some(text) = editor_text {
            return rewrite(text).map(Some);
        }
        let doc = self.open_note(path, None)?;
        let text = rewrite(&doc.text)?;
        match self.save_note(path, &text, &doc.hash, None, write_fm)? {
            SaveResult::Saved { .. } => Ok(None),
            SaveResult::Conflict { .. } => Err(anyhow!("conflict")),
        }
    }

    pub fn rename_note(&mut self, path: &str, new_title: &str, rewrite_links_too: bool) -> anyhow::Result<RenameResult> {
        self.deferring_resync(|v| v.rename_note_now(path, new_title, rewrite_links_too))
    }

    fn rename_note_now(&mut self, path: &str, new_title: &str, rewrite_links_too: bool) -> anyhow::Result<RenameResult> {
        let from = Path::new(path);
        let old = self.note(from)?;
        if new_title.contains(']') { return Err(anyhow!("invalid-title")); } // see `title_ok`
        let to = self.store.rename(from, new_title)?; // keeps io::ErrorKind::AlreadyExists
        // The file has moved: from here on nothing may fail the rename, or the UI keeps the old path and its next
        // save recreates the old file. Index errors heal on the next change; an unreadable link source is skipped.
        let (from_s, to_s) = (path.to_string(), s(&to));
        if to_s != from_s {
            if let Err(e) = self.remove_note(&from_s) {
                crate::log::warn(&format!("velo: removing a renamed note's old index entry failed: {e}"));
            }
            if let Some(plain) = self.unlocked.remove(&from_s) {
                self.unlocked.insert(to_s.clone(), plain);
            }
        }
        let nf = parse(&to)?; // same extension as `from`, which parsed: cannot fail
        self.revisions.rename(&old.title, &nf.title);
        let body = (!nf.encrypted).then(|| lossy(&self.store.read(&to).unwrap_or_default()));
        self.reindex(&to, body.as_deref()).ok();

        let rewritten = if rewrite_links_too { self.rewrite_backlinks(&old.title, &nf.title, "") } else { 0 };
        self.archive_retitle(&old.title, &nf.title, &to);
        Ok(RenameResult { path: to_s, rewritten })
    }

    /// Rewrite `[[old_title]]` links to `new_title` in every rewritable note but `skip`; returns the links rewritten.
    /// Never fails: an unreadable or locked source is skipped.
    fn rewrite_backlinks(&mut self, old_title: &str, new_title: &str, skip: &str) -> usize {
        let mut rewritten = 0;
        let batched = self.index.begin().is_ok();
        let mut done = Vec::new();
        for src in self.index.backlinks(old_title).unwrap_or_default() {
            let sp = Path::new(&src);
            if src == skip || !self.rewritable(sp) {
                continue;
            }
            let Ok(bytes) = self.store.read(sp) else { continue };
            // a non-UTF-8 note (legacy Latin-1 .txt) would be rewritten lossily, for good: skip it
            let Ok(text) = String::from_utf8(bytes) else { continue };
            let (new_text, n) = rewrite_links(&text, old_title, new_title);
            if n > 0 && self.store.write_atomic(sp, new_text.as_bytes()).is_ok() {
                self.reindex(sp, Some(&new_text)).ok();
                rewritten += n;
                done.push((src, new_text));
            }
        }
        if batched && !(self.index.in_batch() && self.index.commit().is_ok()) {
            // Disk full or I/O error lost the batch; the self-write hides these files from the watcher, so redo them.
            for (src, text) in &done {
                self.reindex(Path::new(src), Some(text)).ok();
            }
            // a failed redo can leave a transaction open; the list update after this must not run inside one
            if self.index.in_batch() {
                self.index.commit().ok();
            }
        }
        rewritten
    }

    /// Every refusal `merge_notes` would give before it writes anything, without writing.
    pub fn merge_check(&mut self, source: &str, target: &str) -> anyhow::Result<()> {
        self.merge_plan(source, target).map(|_| ())
    }

    /// The source, the target and the merged target text; or the refusal.
    fn merge_plan(&mut self, source: &str, target: &str) -> anyhow::Result<(NoteDoc, NoteDoc, String)> {
        if source == target {
            return Err(anyhow!("same-note"));
        }
        for p in [source, target] {
            if self.note(Path::new(p))?.encrypted || self.locked_twin(p) {
                return Err(anyhow!("locked"));
            }
        }
        let s = self.open_note(source, None)?;
        let t = self.open_note(target, None)?;
        let merged = merged_text(&t.text, &t.title, &s.text, &s.title).map_err(|e| anyhow!(e))?;
        Ok((s, t, merged))
    }

    /// Merge `source` into `target`, rewrite links to the source, and move it to the Trash.
    pub fn merge_notes(&mut self, source: &str, target: &str, write_fm: bool) -> anyhow::Result<MergeResult> {
        self.merge_notes_with(source, target, write_fm, move_to_trash)
    }

    /// `remove` as in `delete_note_with`. Any failure before the target is saved changes nothing; after it, nothing
    /// is rolled back: links left unrewritten are skipped and a failed trash is reported in `trash_error`.
    pub fn merge_notes_with(&mut self, source: &str, target: &str, write_fm: bool, remove: impl FnOnce(&Path) -> std::io::Result<()>) -> anyhow::Result<MergeResult> {
        let (s, t, merged) = self.merge_plan(source, target)?;
        self.snapshot_text(target, &t.text, None)?;
        if let SaveResult::Conflict { .. } = self.save_note(target, &merged, &t.hash, None, write_fm)? {
            return Err(anyhow!("conflict"));
        }
        let rewritten = self.rewrite_backlinks(&s.title, &t.title, source);
        let trash_error = self.delete_note_with(source, remove).err().map(|e| e.to_string());
        Ok(MergeResult { path: target.to_string(), rewritten, trash_error })
    }

    /// The one-hop graph around `path`; an encrypted note gives `locked` unless unlocked. `hide`: see `connections::build`.
    pub fn connections(&self, path: &str, hide: &dyn Fn(&str) -> bool, include_archived: bool) -> anyhow::Result<Connections> {
        self.sync_archive();
        let p = Path::new(path);
        let plain;
        let text = if self.note(p)?.encrypted {
            self.unlocked.get(path).ok_or_else(|| anyhow!("locked"))?
        } else {
            plain = lossy(&self.store.read(p)?);
            &plain
        };
        connections::build(&self.index, &self.unlocked, path, text, hide, include_archived)
    }

    /// Notes whose links a rename of `title` would rewrite (the "Update N links?" count).
    pub fn backlink_count(&self, title: &str) -> anyhow::Result<usize> {
        Ok(self.index.backlinks(title)?.iter().filter(|p| self.rewritable(Path::new(p))).count())
    }

    /// A link source a rename may rewrite: a plain note on disk. A plain twin of a locked note is locked too
    /// (save_note refuses it the same way); a source the index still lists after it was deleted, or one that can't be
    /// read, is skipped.
    pub fn rewritable(&self, src: &Path) -> bool {
        parse_note_file(src).is_some_and(|n| !n.encrypted) && !plain_twin_of_locked(src) && crate::store::open_regular(src).is_ok()
    }

    pub fn lock_note(&mut self, path: &str, identity: &str) -> anyhow::Result<String> {
        let from = Path::new(path);
        let nf = self.note(from)?;
        if nf.encrypted {
            return Err(anyhow!("already encrypted"));
        }
        let to = note_path(&self.store.dir, &nf.title, true);
        if to.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
        }
        // first: on failure nothing else has changed, and no plaintext snapshot survives a lock
        self.revisions.encrypt_all(&nf.title, |b| crypto::encrypt(identity, b))?;
        let plain = self.store.read(from)?;
        let created = self.index.created_from_file(path)?; // the erase drops it; a failed lock's re-index restores it
        // The locked copy first: a failed write (disk full, folder not writable) leaves the index untouched. From here
        // the plain file is a plain twin, which no re-index stores with its text (see `reindex`), in any process.
        let locked = crypto::encrypt(identity, &plain)?;
        self.store.write_atomic(&to, &locked)?;
        // Erase before the move: a failure here fails the lock with the note still plain and indexed, never a lock
        // that reports success while the plain row stays searchable.
        if let Err(e) = self.index.remove_erasing(path) {
            if let Err(re) = std::fs::remove_file(&to) {
                self.list_stray_lock(&to, &locked);
                // the user must know: the stray locked copy makes the plain note refuse saves
                return Err(anyhow!("{e}; the locked copy {} could not be removed ({re}): move it to the Trash to edit the note again", to.display()));
            }
            self.resync_twins(&to); // another process may have indexed the note as a twin meanwhile
            return Err(e);
        }
        if let Err(e) = finish_move(from, &to).context("removing plaintext note") {
            // `finish_move` removed the locked copy: still plain, back in the index (else the next rescan does it),
            // with its earliest file date (see `upsert`)
            let text = lossy(&plain);
            let back = stat(from).and_then(|mut m| {
                if let Some(c) = created {
                    m.birth = if m.birth > 0 { m.birth.min(c) } else { c };
                }
                let body = row_text(from, &mut m, Some(&text)); // no text while a stray locked copy is left
                self.index.upsert(path, &nf, &m, body)
            });
            if let Err(re) = back {
                crate::log::warn(&format!("velo: re-indexing a note after a failed lock failed, missing from search until the next rescan: {re}"));
            }
            if to.symlink_metadata().is_ok() {
                self.list_stray_lock(&to, &locked);
                return Err(anyhow!("{e:#}; the locked copy {} could not be removed: move it to the Trash to edit the note again", to.display()));
            }
            return Err(e);
        }
        // The file has moved: from here on nothing may fail the lock (as in `rename_note`), or the UI keeps the old
        // path, whose saves are refused. Index errors heal on the next change.
        self.deferring_resync(|v| {
            v.reindex(&to, None).ok();
            v.resync_twins(&to); // also over a stale row of `to`
        });
        // Again, now the plaintext is gone: another process (`velo --mcp` direct mode, as the app starts) may have
        // re-indexed it since the first erase. A failure is logged; the watcher's delete event erases it too.
        if let Err(e) = self.index.remove_erasing(path) {
            crate::log::warn(&format!("velo: erasing a locked note's plain index entry failed, retried at the next change: {e}"));
            self.retry.push(from.to_path_buf());
        }
        // Older versions from a bulk (even this process's) are still in the FTS segments. Best effort from here: the
        // note is locked, and a failure (disk full) stays marked for the next lock or open.
        self.index.finish_bulk();
        self.index.checkpoint().ok(); // drop pre-lock WAL frames holding plaintext
        self.unlocked.insert(s(&to), lossy(&plain));
        if let Some(n) = parse_note_file(&to).filter(|n| fold(&n.title) != fold(&nf.title)) {
            self.archive_retitle(&nf.title, &n.title, &to);
        }
        Ok(s(&to))
    }

    pub fn unlock_note(&mut self, path: &str, identity: &str) -> anyhow::Result<String> {
        let from = Path::new(path);
        let nf = self.note(from)?;
        if !nf.encrypted {
            return Err(anyhow!("not encrypted"));
        }
        let to = note_path(&self.store.dir, &nf.title, false);
        if to.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
        }
        let plain = crypto::decrypt(identity, &self.store.read(from)?)?;
        self.store.write_atomic(&to, &plain)?;
        finish_move(from, &to).context("removing encrypted note")?;
        // as in `lock_note`: the file has moved, so nothing may fail the unlock. The stale row has no text (locked
        // notes are indexed without a body); the watcher's delete event removes it.
        if let Err(e) = self.remove_note(path) {
            crate::log::warn(&format!("velo: removing an unlocked note's old index entry failed: {e}"));
        }
        self.unlocked.remove(path);
        self.reindex(&to, Some(&lossy(&plain))).ok();
        if let Some(n) = parse_note_file(&to).filter(|n| fold(&n.title) != fold(&nf.title)) {
            self.archive_retitle(&nf.title, &n.title, &to);
        }
        Ok(s(&to))
    }

    /// Move a note to the OS Trash and drop it from the index and the unlocked cache.
    pub fn delete_note(&mut self, path: &str) -> anyhow::Result<()> {
        self.delete_note_with(path, move_to_trash)
    }

    /// `remove` does the actual file removal (Trash in the app, plain remove in tests).
    pub fn delete_note_with(&mut self, path: &str, remove: impl FnOnce(&Path) -> std::io::Result<()>) -> anyhow::Result<()> {
        let p = Path::new(path);
        let title = self.note(p)?.title;
        remove(p)?;
        self.remove_note(path)?;
        self.unlocked.remove(path);
        if self.listed(&title) && !self.title_on_disk(&title, p) {
            self.archive_follow(|e| e.retain(|t| fold(t) != fold(&title)));
        }
        Ok(())
    }

    /// A locked note lists only encrypted snapshots: a plaintext one under its folded key belongs to a fold-equal
    /// plain note, or waits to be secured (see `secure_revisions`).
    pub fn list_revisions(&self, path: &str) -> anyhow::Result<Vec<RevisionInfo>> {
        let nf = self.note(Path::new(path))?;
        Ok(self.revisions.list(&nf.title).into_iter().filter(|r| !nf.encrypted || r.id.ends_with(".age")).collect())
    }

    pub fn read_revision(&self, path: &str, id: &str, identity: Option<&str>) -> anyhow::Result<String> {
        let nf = self.note(Path::new(path))?;
        let (bytes, enc) = self.revisions.read(&nf.title, id)?;
        if nf.encrypted && !enc {
            return Err(anyhow!("locked")); // see `list_revisions`
        }
        if !enc {
            return Ok(lossy(&bytes));
        }
        Ok(lossy(&crypto::decrypt(identity.ok_or_else(|| anyhow!("locked"))?, &bytes)?))
    }

    /// Not throttled. Locked notes get ciphertext; their identical-content check decrypts the newest snapshot.
    pub fn snapshot_text(&mut self, path: &str, text: &str, identity: Option<&str>) -> anyhow::Result<()> {
        let nf = self.note(Path::new(path))?;
        // a stale pre-lock path still means a locked note: never write its text as plaintext
        if !nf.encrypted && !plain_twin_of_locked(Path::new(path)) {
            self.revisions.snapshot_bytes(&nf.title, text.as_bytes(), false, now_ms(), false)?;
            return Ok(());
        }
        let id = identity.ok_or_else(|| anyhow!("locked"))?;
        if let Some(newest) = self.revisions.list(&nf.title).first()
            && self.read_revision(path, &newest.id, Some(id)).is_ok_and(|t| t == text)
        {
            return Ok(());
        }
        self.revisions.snapshot_bytes(&nf.title, &crypto::encrypt(id, text.as_bytes())?, true, now_ms(), false)?;
        Ok(())
    }

    /// Agent undo trail: an unthrottled snapshot of the note's current on-disk bytes, with the agent's summary.
    /// Plain notes only; the agent never reaches a locked one.
    /// Returns the snapshot id (`None`: an empty file has nothing to keep).
    pub fn agent_snapshot(&mut self, path: &str, summary: &str) -> anyhow::Result<Option<String>> {
        let nf = self.note(Path::new(path))?;
        if nf.encrypted || plain_twin_of_locked(Path::new(path)) {
            return Err(anyhow!("locked"));
        }
        let bytes = crate::store::read_regular(Path::new(path))?;
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.revisions.snapshot_agent(&nf.title, &bytes, false, now_ms(), summary)?))
    }

    /// Deletes revision `id` (and its summary) of the note at `path`: an agent snapshot whose write never happened.
    pub fn drop_revision(&self, path: &str, id: &str) {
        if let Ok(nf) = self.note(Path::new(path)) {
            self.revisions.remove(&nf.title, id);
        }
    }

    /// First revision of a note the agent just created: its created text, with the summary.
    pub fn agent_snapshot_text(&mut self, path: &str, text: &str, summary: &str) -> anyhow::Result<()> {
        let nf = self.note(Path::new(path))?;
        if nf.encrypted || plain_twin_of_locked(Path::new(path)) {
            return Err(anyhow!("locked"));
        }
        self.revisions.snapshot_agent(&nf.title, text.as_bytes(), false, now_ms(), summary)?;
        Ok(())
    }

    pub fn lock_all(&mut self) {
        self.unlocked.clear();
    }

    pub fn apply_fs_changes(&mut self, paths: &[PathBuf], identity: Option<&str>) -> Vec<String> {
        self.apply_paths(paths, identity, false)
    }

    /// `apply_fs_changes`; `bulk`: a chunk of this process's bulk, whose own finish erases what it deletes.
    fn apply_paths(&mut self, paths: &[PathBuf], identity: Option<&str>, bulk: bool) -> Vec<String> {
        let mut paths = paths.to_vec();
        for p in std::mem::take(&mut self.retry) {
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
        let mut changed = Vec::new();
        let mut lost_plain = false;
        self.deferring_resync(|v| {
            // Plain notes being locked elsewhere are deleted securely, in a batch of their own after the rest: a bulk is
            // ended just before it (a rebuild inside a batch could fail the whole batch on a low disk), so those deletes are
            // cheap and the rest still runs fast.
            let (erasing, rest): (Vec<PathBuf>, Vec<PathBuf>) = paths.iter().cloned().partition(|p| !p.exists() && v.locked_twin(&s(p)));
            let rest_chunks = rest.len().div_ceil(CHUNK);
            for (i, chunk) in rest.chunks(CHUNK).chain(erasing.chunks(CHUNK)).enumerate() {
                if i >= rest_chunks && v.index.bulk_off() {
                    v.index.finish_bulk();
                }
                let mark = changed.len();
                // If `begin` fails, each upsert/remove commits on its own, as before.
                let batched = v.index.begin().is_ok();
                let ok = v.apply_chunk(chunk, identity, batched, &mut changed, &mut lost_plain);
                if batched && !(ok && v.index.commit().is_ok()) {
                    // Disk full or I/O error: the whole batch is gone, so redo it note by note, else `changed` would list
                    // notes that aren't indexed.
                    changed.truncate(mark);
                    v.apply_chunk(chunk, identity, false, &mut changed, &mut lost_plain);
                }
            }
        });
        // Inside a bulk the delete itself was secure; older versions wait for the bulk's one finish, not one per chunk.
        if lost_plain && !bulk {
            self.index.finish_bulk(); // as in `lock_note`
            self.index.checkpoint().ok(); // locked on another machine: drop WAL frames holding its plaintext
        }
        changed
    }

    /// Drop a note from the index; a plain note whose locked twin exists (on disk, or still indexed: a sync may be
    /// rewriting it) is being locked, so its text is erased now.
    /// Every path by which a locked note leaves the index (watcher, open, rescan, trash, rename, unlock, retry) goes
    /// through here, so its plain twins get their text back.
    fn remove_note(&mut self, path: &str) -> anyhow::Result<()> {
        let r = if self.locked_twin(path) { self.index.remove_erasing(path) } else { self.index.remove(path) };
        self.resync_twins(Path::new(path));
        r
    }

    fn locked_twin(&self, path: &str) -> bool {
        let twin = parse_note_file(Path::new(path)).filter(|nf| !nf.encrypted).map(|nf| note_path(&self.store.dir, &nf.title, true));
        plain_twin_of_locked(Path::new(path)) || twin.is_some_and(|t| self.index.title_modified(&s(&t)).ok().flatten().is_some())
    }

    /// One chunk of a bulk re-index: if something ended the bulk (a lock, another process), start it again, else the
    /// remaining chunks run with secure deletes (~13 ms per note, seconds per chunk).
    pub fn apply_bulk_chunk(&mut self, paths: &[PathBuf], identity: Option<&str>) -> Vec<String> {
        if !self.index.bulk_off() {
            self.index.begin_bulk().ok();
        }
        self.apply_paths(paths, identity, true)
    }

    /// `apply_fs_changes` for one chunk; false (and stop) when an error aborted the `batched` transaction.
    fn apply_chunk(&mut self, paths: &[PathBuf], identity: Option<&str>, batched: bool, changed: &mut Vec<String>, lost_plain: &mut bool) -> bool {
        let (mut listing, mut folds) = (None, None);
        for p in paths {
            let Some(nf) = parse_note_file(p) else { continue };
            let key = s(p);
            let read = self.read_for_index(p);
            if let Ok(Some(b)) = &read && self.store.take_self_write(p, b) {
                continue;
            }
            // A case-insensitive disk still opens `Meeting.md` once it is `meeting.md`: that spelling is gone, not a
            // second note (its row would keep the text once the note is locked, and no event names it again).
            let read = match read {
                Ok(_) if !self.listed_as(p, &mut listing) => Err(std::io::ErrorKind::NotFound.into()),
                r => r,
            };
            match read {
                Ok(bytes) => {
                    let body = bytes.filter(|_| !nf.encrypted).map(|b| lossy(&b));
                    // locked elsewhere and new here: its plain twin may have been deleted mid-bulk in an earlier batch
                    *lost_plain |= nf.encrypted && self.index.bulk_off() && self.index.title_modified(&key).ok().flatten().is_none();
                    if nf.encrypted {
                        // held to the batch's end; also when its row can't be written (a locked copy that can't be
                        // stat'ed still makes its twins locked), or when a retry asks for the scan again
                        self.resync_twins(p);
                    }
                    if self.reindex(p, body.as_deref()).is_err() {
                        if batched && !self.index.in_batch() {
                            return false;
                        }
                        self.retry.push(p.clone()); // a retried path (a plain twin's erase) must not be dropped
                        continue;
                    }
                    // a real locked copy only: deleting or encrypting history never follows from the index alone
                    if nf.encrypted && std::fs::metadata(p).is_ok_and(|m| m.is_file()) {
                        self.secure_revisions(&nf.title, identity, &mut folds);
                        if let Some(id) = identity {
                            self.try_unlock(p, id);
                        }
                    }
                }
                // Only a missing file is a deletion: iCloud-evicted, unreadable or sync-locked files stay listed.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if let Err(e) = self.remove_note(&key) {
                        if batched && !self.index.in_batch() {
                            return false;
                        }
                        // a plain twin's text stays searchable until then: say so, and try again at the next change
                        crate::log::warn(&format!("velo: removing a deleted note from the search index failed, retried at the next change: {e}"));
                        self.retry.push(p.clone());
                        continue;
                    }
                    self.unlocked.remove(&key);
                    *lost_plain |= plain_twin_of_locked(p);
                }
                Err(_) => continue,
            }
            changed.push(key);
        }
        true
    }

    /// Whether the folder lists `p`'s file name under exactly this spelling. `listing` caches the names, read again
    /// before a miss is believed (a file new since); a folder that can't be read lists everything, as before.
    fn listed_as(&self, p: &Path, listing: &mut Option<HashSet<String>>) -> bool {
        let Some(name) = p.file_name() else { return true };
        let name = s(Path::new(name));
        for fresh in [listing.is_none(), true] {
            if fresh {
                let Ok(rd) = std::fs::read_dir(&self.store.dir) else { return true };
                *listing = Some(rd.flatten().map(|e| s(Path::new(&e.file_name()))).collect());
            }
            if listing.as_ref().is_some_and(|l| l.contains(&name)) {
                return true;
            }
        }
        false
    }

    /// A note locked elsewhere (synced in as .md.age) must leave no plaintext revisions here: encrypt them,
    /// or delete them when this machine has no key.
    /// Revisions are keyed by the folded title, so the folder may also hold the history of another note: a disk that
    /// tells `Plan.md` from `plan.md.age` (case-sensitive) or `Café.md` from `Cafe.md.age` (any) keeps both as notes.
    /// Encrypting with the key keeps both readable with it; deleting would lose the other note's history, so it is
    /// skipped while such a plain note is on disk, and done at a later arrival of the locked file without one. Until
    /// then the locked note never lists or reads that plaintext (`list_revisions`, `read_revision`).
    fn secure_revisions(&self, title: &str, identity: Option<&str>, folds: &mut FoldListing) {
        match identity {
            Some(id) => self.revisions.encrypt_all(title, |b| crypto::encrypt(id, b)).ok(),
            // nothing plaintext to delete, so nothing to ask: no folder listing (a bulk of new locked notes stays cheap)
            None if !self.revisions.has_plain(title) || self.history_shared_with_plain(title, folds) => None,
            None => self.revisions.remove_plain(title).ok(),
        };
    }

    /// Whether a plain note folding to `title` is on disk and is no plain twin of a locked note (the disk decides, see
    /// `twin_state`): its history shares `title`'s folder. A doubt (folder, entry or stat error) counts as one; a
    /// dangling link does not (no note to open, and the folder listing skips it).
    /// shortcut: the names come from one listing per chunk (`folds`), the file checks are fresh; a plain note named
    /// into the folder after that listing, in the same chunk, is not seen. Upgrade: re-list on each call with history.
    fn history_shared_with_plain(&self, title: &str, folds: &mut FoldListing) -> bool {
        let listing = folds.get_or_insert_with(|| {
            #[cfg(test)]
            tests::FOLD_LISTINGS.with(|c| c.set(c.get() + 1));
            let mut m: HashMap<String, Vec<PathBuf>> = HashMap::new();
            for e in std::fs::read_dir(&self.store.dir).ok()? {
                let p = e.ok()?.path();
                if let Some(n) = parse_note_file(&p).filter(|n| !n.encrypted) {
                    m.entry(fold(&n.title)).or_default().push(p);
                }
            }
            Some(m)
        });
        let Some(m) = listing else { return true };
        let regular_or_doubt = |p: &Path| match std::fs::metadata(p) {
            Ok(m) => m.is_file(),
            Err(e) => !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidFilename),
        };
        m.get(&fold(title)).is_some_and(|ps| ps.iter().any(|p| regular_or_doubt(p) && twin_state(p) != Some(true)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    thread_local! {
        /// Makes `note_file_at` fail with this error for every `.md.age` name (a failing disk, a short NAME_MAX).
        pub(super) static STAT_FAIL: std::cell::Cell<Option<std::io::ErrorKind>> = const { std::cell::Cell::new(None) };
        /// Folder listings `history_shared_with_plain` read.
        pub(super) static FOLD_LISTINGS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }
    use crate::crypto;
    use std::path::Path;

    fn open(dir: PathBuf, db: &Path, identity: Option<&str>) -> anyhow::Result<Vault> {
        Vault::open_with_progress(dir, db, identity, &mut |_, _| {})
    }

    fn open_empty() -> Vault {
        let dir = tempfile::tempdir().unwrap().keep();
        let db = tempfile::tempdir().unwrap().keep().join("i.sqlite");
        open(dir, &db, None).unwrap()
    }

    fn setup() -> (PathBuf, PathBuf) {
        (tempfile::tempdir().unwrap().keep(), tempfile::tempdir().unwrap().keep().join("i.sqlite"))
    }

    #[test] fn timeline_orders_and_filters() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let note = |n: &str, c: &str, m: &str, body: &str| std::fs::write(dir.join(format!("{n}.md")), format!("---\ncreated: {c}\nmodified: {m}\n---\n{body}\n")).unwrap();
        note("a", "2020-01-01T00:00:00+00:00", "2022-01-01T00:00:00+00:00", "zebra #x");
        note("b", "2021-01-01T00:00:00+00:00", "2021-06-01T00:00:00+00:00", "zebra");
        note("c", "2019-01-01T00:00:00+00:00", "2023-01-01T00:00:00+00:00", "other");
        let mut v = open(dir.clone(), &db, None).unwrap();
        let ms = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis();
        let t = |v: &Vault, by, since| v.timeline("zebra", &[], false, false, by, since).unwrap();
        let r = t(&v, TimelineBy::Updated, None);
        assert_eq!(r.iter().map(|r| (r.title.as_str(), r.date)).collect::<Vec<_>>(), [("a", ms("2022-01-01T00:00:00+00:00")), ("b", ms("2021-06-01T00:00:00+00:00"))]);
        assert!(!r[0].locked && r[0].snippet.contains("zebra"));
        assert_eq!(t(&v, TimelineBy::Created, None).iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(t(&v, TimelineBy::Updated, Some(ms("2022-01-01T00:00:00+00:00"))).len(), 1);
        assert_eq!(v.timeline("zebra", &["x".into()], false, false, TimelineBy::Updated, None).unwrap().len(), 1);
        assert_eq!(v.timeline("", &[], true, false, TimelineBy::Updated, None).unwrap().len(), 3);
        // locked: one matches by title, one only by its in-memory body; neither may leak text
        let d = v.open_or_create("zebra lock", None, false).unwrap(); v.lock_note(&d.path, &id).unwrap();
        let d = v.open_or_create("hidden", None, false).unwrap(); let p = v.lock_note(&d.path, &id).unwrap();
        v.save_note(&p, "zebra secret", &stat_hash(&p), Some(&id), false).unwrap();
        let locked: Vec<_> = t(&v, TimelineBy::Updated, None).into_iter().filter(|r| r.locked).collect();
        assert_eq!(locked.len(), 2);
        assert!(locked.iter().all(|r| r.snippet.is_empty()));
    }
    #[test] fn open_reconciles_and_rebuilds() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "zebra").unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); drop(v); std::fs::remove_file(&db).unwrap();
        assert_eq!(open(dir, &db, None).unwrap().search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
    }
    #[test] fn progress_reports_total_and_end() {
        let (dir, db) = setup();
        for i in 0..600 { std::fs::write(dir.join(format!("n{i}.md")), format!("body {i}")).unwrap(); }
        let mut calls = vec![];
        Vault::open_with_progress(dir, &db, None, &mut |d, t| calls.push((d, t))).unwrap();
        assert_eq!(calls.last(), Some(&(600, 600)));
        assert!(calls.iter().all(|c| c.1 == 600) && calls.len() <= 4, "{calls:?}");
    }
    #[test] fn warm_open_reports_nothing() {
        let (dir, db) = setup();
        for i in 0..5 { std::fs::write(dir.join(format!("n{i}.md")), "x").unwrap(); }
        open(dir.clone(), &db, None).unwrap();
        let mut n = 0;
        Vault::open_with_progress(dir, &db, None, &mut |_, _| n += 1).unwrap();
        assert_eq!(n, 0);
    }
    #[test] fn reconcile_tolerates_non_utf8() {
        let (dir, db) = setup();
        std::fs::write(dir.join("bin.txt"), [0xff, 0xfe, b'o', b'k', b'a', b'y']).unwrap();
        let before = std::fs::read(dir.join("bin.txt")).unwrap(); let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.search("bin", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); assert_eq!(std::fs::read(dir.join("bin.txt")).unwrap(), before);
    }
    #[test] fn open_or_create_new_says_whether_it_made_the_file() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a-b.md"), "").unwrap(); // empty, and "a/b" sanitises to it
        let mut v = open(dir, &db, None).unwrap();
        assert!(!v.open_or_create_new("a/b", None, false).unwrap().1);
        assert!(v.open_or_create_new("fresh", None, false).unwrap().1);
        assert!(!v.open_or_create_new("fresh", None, false).unwrap().1);
    }
    #[test] fn open_or_create_dedupes_case_insensitive() {
        let mut v = open_empty(); let a = v.open_or_create("Foo", None, false).unwrap();
        let b = v.open_or_create("FOO", None, false).unwrap(); assert_eq!(a.path, b.path);
    }
    #[test] fn save_after_external_delete_recreates() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        std::fs::remove_file(&d.path).unwrap(); assert!(matches!(v.save_note(&d.path, "kept", &d.hash, None, false).unwrap(), SaveResult::Saved { .. }));
        assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "kept");
    }
    #[test] fn lock_keeps_plaintext_off_disk_and_db() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "uniqueplain zqxjvkplmwqbyfh", &d.hash, None, false).unwrap(); let p = v.lock_note(&d.path, &id).unwrap();
        assert!(p.ends_with(".md.age")); assert!(!Path::new(&d.path).exists());
        assert!(!std::fs::read(&p).unwrap().windows(11).any(|w| w == b"uniqueplain"));
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{}{suffix}", db.display());
            if let Ok(b) = std::fs::read(&f) { assert!(!b.windows(11).any(|w| w == b"uniqueplain"), "{f}"); }
        }
        // FTS trigram index keeps overlapping 3-byte terms; none may survive
        assert!(!trigram_on_disk(&db, &["zqxjvkplmwqbyfh"]), "trigram leak");
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap(); assert_eq!(v.search("uniqueplain", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        v.lock_all(); assert!(v.search("uniqueplain", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(v.open_note(&p, None).is_err()); assert_eq!(v.open_note(&p, Some(&id)).unwrap().text, "uniqueplain zqxjvkplmwqbyfh");
    }
    #[test] fn locked_tasks_never_in_sqlite_but_listed_while_unlocked() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "- [ ] secretzebra", &d.hash, None, false).unwrap();
        assert_eq!(v.tasks("", &[], false, false).unwrap().no_date.len(), 1);
        v.lock_note(&d.path, &id).unwrap();
        assert!(v.index.task_rows(&[], true).unwrap().iter().all(|r| !r.text.contains("secretzebra")));
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            if let Ok(b) = std::fs::read(format!("{}{suffix}", db.display())) { assert!(!b.windows(11).any(|w| w == b"secretzebra"), "{suffix}"); }
        }
        let mut v = open(dir, &db, Some(&id)).unwrap();
        let t = v.tasks("", &[], false, false).unwrap();
        assert_eq!(t.no_date.len(), 1); assert_eq!(t.no_date[0].text, "secretzebra");
        v.lock_all();
        assert!(v.tasks("", &[], false, false).unwrap().no_date.is_empty());
    }
    #[test] fn locked_note_tags_stay_out_of_sqlite() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "#zqxjvkplmwqbyfh text", &d.hash, None, false).unwrap();
        assert_eq!(v.tags(false).unwrap().len(), 1); v.lock_note(&d.path, &id).unwrap();
        assert!(v.tags(false).unwrap().is_empty());
        drop(v);
        assert!(!trigram_on_disk(&db, &["zqxjvkplmwqbyfh"]), "trigram leak");
        let v = open(dir, &db, Some(&id)).unwrap();
        assert!(v.tags(false).unwrap().is_empty());
        assert_eq!(v.search("", Sort::Title, 0, &["zqxjvkplmwqbyfh".to_string()]).unwrap().hits.len(), 1);
    }
    #[test] fn link_mention_saves_when_not_open() {
        let (dir, db) = setup();
        std::fs::write(dir.join("Nick.md"), "").unwrap(); std::fs::write(dir.join("C.md"), "see Nick").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let (c, n) = (s(&dir.join("C.md")), s(&dir.join("Nick.md")));
        assert_eq!(v.index.linked_from(&n).unwrap().len(), 0);
        assert_eq!(v.link_mention(&c, "Nick", 1, None, false, false).unwrap(), None);
        assert_eq!(std::fs::read_to_string(dir.join("C.md")).unwrap(), "see [[Nick]]");
        assert_eq!(v.index.linked_from(&n).unwrap().len(), 1);
    }
    #[test] fn link_mention_uses_the_names_the_panel_shows() { // archived `Foo Bar` must not shadow the visible `Foo`
        let (dir, db) = setup();
        for (n, b) in [("Foo", ""), ("Foo Bar", ""), ("C", "see Foo Bar")] { std::fs::write(dir.join(format!("{n}.md")), b).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.set_archived(&s(&dir.join("Foo Bar.md")), true).unwrap();
        let c = s(&dir.join("C.md"));
        assert_eq!(v.connections(&c, &|_| false, false).unwrap().mentions[0].name, "Foo");
        assert_eq!(v.link_mention(&c, "Foo", 1, None, false, true).unwrap_err().to_string(), "mention-moved");
        assert_eq!(v.link_mention(&c, "Foo", 1, None, false, false).unwrap(), None);
        assert_eq!(std::fs::read_to_string(dir.join("C.md")).unwrap(), "see [[Foo]] Bar");
    }
    #[test] fn link_mention_keeps_an_archived_centres_own_names() { // the panel does, so a mention of `Foo` inside `Foo Bar` stays hidden
        let (dir, db) = setup();
        for (n, b) in [("Foo", ""), ("Foo Bar", "see Foo Bar")] { std::fs::write(dir.join(format!("{n}.md")), b).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let c = s(&dir.join("Foo Bar.md"));
        v.set_archived(&c, true).unwrap();
        assert!(v.connections(&c, &|_| false, false).unwrap().mentions.is_empty());
        assert_eq!(v.link_mention(&c, "Foo", 1, None, false, false).unwrap_err().to_string(), "mention-moved");
        assert_eq!(std::fs::read_to_string(&c).unwrap(), "see Foo Bar");
    }
    #[test] fn open_or_create_keeps_the_entry_of_a_file_it_did_not_create() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("Late.md"), "").unwrap(); // after open, no rescan: not indexed
        std::fs::create_dir_all(dir.join(".velo")).unwrap();
        std::fs::write(dir.join(".velo/archived"), "Late\n").unwrap();
        let (_, created) = v.open_or_create_new("Late", None, false).unwrap();
        assert!(!created);
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "Late\n");
    }
    #[test] fn link_mention_with_editor_text_writes_nothing() {
        let (dir, db) = setup();
        std::fs::write(dir.join("Nick.md"), "").unwrap(); std::fs::write(dir.join("C.md"), "see Nick").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let got = v.link_mention(&s(&dir.join("C.md")), "Nick", 1, Some("typed Nick"), false, false).unwrap();
        assert_eq!(got.as_deref(), Some("typed [[Nick]]"));
        assert_eq!(std::fs::read_to_string(dir.join("C.md")).unwrap(), "see Nick");
    }
    #[test] fn link_mention_count_mismatch() {
        let (dir, db) = setup();
        std::fs::write(dir.join("Nick.md"), "").unwrap(); std::fs::write(dir.join("C.md"), "see Nick").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.link_mention(&s(&dir.join("C.md")), "Nick", 2, None, false, false).unwrap_err().to_string(), "mention-moved");
        assert_eq!(std::fs::read_to_string(dir.join("C.md")).unwrap(), "see Nick");
    }
    #[test] fn link_mention_refuses_locked() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let d = v.open_or_create("L", Some(&id), false).unwrap();
        v.save_note(&d.path, "see Nick", &d.hash, Some(&id), false).unwrap();
        let plain = d.path.clone();
        let locked = v.lock_note(&d.path, &id).unwrap();
        let e = v.link_mention(&locked, "Nick", 1, None, false, false).unwrap_err();
        assert_eq!(e.to_string(), "locked");
        std::fs::write(&plain, "see Nick").unwrap(); // a plain twin of a locked note
        assert_eq!(v.link_mention(&plain, "Nick", 1, None, false, false).unwrap_err().to_string(), "locked");
    }
    #[test] fn save_to_plain_path_refused_when_locked_sibling_exists() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        let e = v.save_note(&d.path, "stale zqxjvkplmwqbyfh", &d.hash, Some(&id), false).err().unwrap();
        assert_eq!(e.to_string(), "locked-sibling");
        assert!(!Path::new(&d.path).exists());
        drop(v);
        assert!(!trigram_on_disk(&db, &["zqxjvkplmwqbyfh"]), "trigram leak");
    }
    #[test] fn rename_rewrites_backlinks() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let old = dir.join("Old.md").to_string_lossy().into_owned();
        let r = v.rename_note(&old, "New", true).unwrap();
        assert_eq!(r.rewritten, 1); assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "see [[New]]");
    }
    /// A legacy Latin-1 note is never rewritten (lossy, with no revision to undo it).
    #[test] fn rename_skips_non_utf8_link_source() {
        let (dir, db) = setup();
        let latin1 = b"caf\xe9 [[Old]]".to_vec();
        std::fs::write(dir.join("a.txt"), &latin1).unwrap(); std::fs::write(dir.join("b.md"), "[[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let r = v.rename_note(&dir.join("Old.md").to_string_lossy(), "New", true).unwrap();
        assert_eq!(r.rewritten, 1);
        assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), latin1);
        assert_eq!(std::fs::read_to_string(dir.join("b.md")).unwrap(), "[[New]]");
    }
    /// Once the file has moved, an index error must not fail the lock or unlock (the UI would keep a dead path).
    #[test] fn lock_and_unlock_succeed_when_the_index_fails_after_the_move() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let c = rusqlite::Connection::open(&db).unwrap();
        // the lock's erase of the plain row runs before the move (see `lock_fails_when_the_index_cannot_erase_the_plaintext`)
        c.execute_batch("CREATE TRIGGER boom BEFORE INSERT ON notes WHEN NEW.path LIKE '%.age' BEGIN SELECT RAISE(FAIL, 'boom'); END;").unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        assert!(Path::new(&p).exists() && !Path::new(&d.path).exists());
        c.execute_batch("DROP TRIGGER boom").unwrap();
        v.reindex(Path::new(&p), None).unwrap(); // the unlock's delete must find a row to fail on
        c.execute_batch("CREATE TRIGGER boom BEFORE DELETE ON notes BEGIN SELECT RAISE(FAIL, 'boom'); END;").unwrap();
        assert!(v.index.remove(&p).is_err());
        let q = v.unlock_note(&p, &id).unwrap();
        assert!(Path::new(&q).exists() && !Path::new(&p).exists());
        c.execute_batch("DROP TRIGGER boom").unwrap();
    }
    /// The old file already gone (deleted by a sync mid-lock): the new file is the only copy and stays.
    #[test] fn finish_move_keeps_the_only_copy() {
        let d = tempfile::tempdir().unwrap();
        let (from, to) = (d.path().join("X.md"), d.path().join("X.md.age"));
        std::fs::write(&to, "c").unwrap();
        assert!(finish_move(&from, &to).is_ok());
        assert!(to.exists());
        std::fs::write(&from, "p").unwrap();
        assert!(finish_move(&from, &to).is_ok());
        assert!(!from.exists() && to.exists());
    }
    /// A lock whose plaintext can't be removed changes nothing: no locked twin is left to refuse the note's saves.
    #[cfg(target_os = "macos")]
    #[test] fn lock_rolls_back_when_the_plaintext_cannot_be_removed() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let p = dir.join("s.md");
        std::fs::write(&p, "old").unwrap();
        let jan = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_704_067_200); // 2024-01-01
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(jan).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_note(&p.to_string_lossy(), None).unwrap();
        let _r = v.save_note(&d.path, "plainzebra", &d.hash, None, false).unwrap(); // new file: only the index keeps January
        let dates = |v: &Vault| (v.index.created_from_file(&d.path).unwrap(), v.index.title_modified(&d.path).unwrap());
        let before = dates(&v);
        assert!(before.0.unwrap() <= 1_704_067_200_000);
        let flags = |f: &str| assert!(std::process::Command::new("chflags").args([f, &d.path]).status().unwrap().success());
        flags("uchg"); // immutable: can't be deleted
        let r = v.lock_note(&d.path, &id);
        flags("nouchg");
        assert!(r.is_err());
        assert!(Path::new(&d.path).exists() && !dir.join("s.md.age").exists());
        assert_eq!(v.search("plainzebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); // still indexed: it is still plain
        assert_eq!(dates(&v), before); // the re-index keeps the indexed created date
    }
    /// A plain row put back between the lock's first erase and the move (a rescan in `velo --mcp` direct mode, on
    /// another connection) is erased after the move. A trigger on a second connection stands in for that process.
    #[test] fn lock_erases_a_plain_row_reinserted_before_the_move() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "racezebra", &d.hash, None, false).unwrap();
        let c = rusqlite::Connection::open(&db).unwrap();
        let path = d.path.replace('\'', "''");
        c.execute_batch(&format!(
            "CREATE TRIGGER back AFTER INSERT ON notes WHEN NEW.path LIKE '%.md.age' BEGIN
               INSERT INTO notes(path,title,title_folded,mtime,size,encrypted,preview,created,created_src,modified,modified_src) VALUES('{path}','s','s',1,1,0,'racezebra',1,'file',1,'file');
               INSERT INTO notes_fts(rowid,path,body) VALUES((SELECT rowid FROM notes WHERE path='{path}'),'{path}','racezebra');
             END;")).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        c.execute_batch("DROP TRIGGER back").unwrap();
        v.lock_all();
        assert!(v.search("racezebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty(), "the reinserted plain row is still live");
        assert!(v.index.title_modified(&d.path).unwrap().is_none());
    }
    /// A lock that can't erase the note from the index must fail: it used to succeed and leave the old plain row
    /// (body, preview, tasks) searchable until the watcher's delete or the next launch.
    #[test] fn lock_fails_when_the_index_cannot_erase_the_plaintext() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "- [ ] secretzebra", &d.hash, None, false).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE DELETE ON notes WHEN OLD.path NOT LIKE '%.age' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        let r = v.lock_note(&d.path, &id);
        v.lock_all();
        let hits = v.search("secretzebra", Sort::Modified, 0, &[]).unwrap().hits;
        assert!(r.is_err(), "lock reported success (plain text still searchable: {})", !hits.is_empty());
        assert!(Path::new(&d.path).exists() && !dir.join("s.md.age").exists()); // still plain on disk
        assert_eq!(v.open_note(&d.path, None).unwrap().text, "- [ ] secretzebra");
        assert_eq!(hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), vec![d.path.as_str()]); // still indexed
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap();
        v.lock_note(&d.path, &id).unwrap();
        v.lock_all();
        assert!(v.search("secretzebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(v.index.task_rows(&[], true).unwrap().is_empty());
    }
    /// #93 (a): a lock whose encrypted write fails (folder not writable, disk full) must not touch the index: the
    /// still-plain note used to be erased first and stay out of search when the rollback re-index failed too.
    #[cfg(unix)]
    #[test] fn failed_lock_write_keeps_the_note_indexed() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "- [ ] writezebra", &d.hash, None, false).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let r = v.lock_note(&d.path, &id);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap();
        assert!(r.is_err());
        assert!(Path::new(&d.path).exists() && !dir.join("s.md.age").exists());
        assert_eq!(v.search("writezebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1, "the still-plain note dropped out of search");
        assert_eq!(v.index.task_rows(&[], true).unwrap().len(), 1);
    }
    /// #93 cross-process: once the locked copy is on disk, the plain file is a plain twin. A second process (`velo
    /// --mcp` direct mode, a second app instance) that re-indexes it, or opens the index, must not store its text.
    #[test] fn a_plain_twin_of_a_locked_note_is_indexed_without_its_text() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), "- [ ] twinzebra #twintag").unwrap();
        let mut a = open(dir.clone(), &db, None).unwrap();
        let mut b = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap(); // a lock mid-way
        b.apply_fs_changes(&[dir.join("s.md")], None);
        let leaks = |v: &Vault| (v.search("twinzebra", Sort::Modified, 0, &[]).unwrap().hits.len(), v.index.task_rows(&[], true).unwrap().len(), v.tags(true).unwrap().len());
        assert_eq!(leaks(&a), (0, 0, 0), "a re-index stored the plain twin's text");
        assert!(a.index.title_modified(&dir.join("s.md").to_string_lossy()).unwrap().is_some(), "still listed");
        drop((a, b));
        std::fs::remove_file(&db).unwrap(); // a crash between the write and the erase, then a cold open
        a = open(dir.clone(), &db, None).unwrap();
        assert_eq!(leaks(&a), (0, 0, 0), "a cold open stored the plain twin's text");
        std::fs::remove_file(dir.join("s.md.age")).unwrap(); // the twin is gone, s.md unchanged: the note is plain again
        a.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert_eq!(leaks(&a), (1, 1, 1));
    }
    /// #93 cross-process (review m1 on #102): another process takes the index right after the lock's erase, applies the
    /// note and holds the write lock past the lock's busy timeout. The lock either fails with the note intact, or
    /// succeeds with no plain text in the index. Used to succeed and leave it searchable. In practice the other process
    /// finds the file already moved, so this pins the order (locked copy, erase, move); the twin rule and the retries
    /// have their own deterministic tests.
    #[test] fn a_second_process_holding_the_index_during_a_lock_leaves_no_plain_text() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut a = open(dir.clone(), &db, None).unwrap();
        let d = a.open_or_create("s", None, false).unwrap();
        let _r = a.save_note(&d.path, "- [ ] racezebra", &d.hash, None, false).unwrap();
        let mut b = open(dir.clone(), &db, None).unwrap();
        a.index.raw().busy_timeout(std::time::Duration::from_millis(100)).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let tx = std::sync::Mutex::new(tx);
        a.index.raw().create_scalar_function("erased", 0, rusqlite::functions::FunctionFlags::SQLITE_UTF8, move |_| { tx.lock().unwrap().send(()).ok(); Ok(0) }).unwrap();
        a.index.raw().execute_batch(&format!("CREATE TEMP TRIGGER erased AFTER DELETE ON notes WHEN OLD.path = '{}' BEGIN SELECT erased(); END;", d.path.replace('\'', "''"))).unwrap();
        let p = PathBuf::from(&d.path);
        let other = std::thread::spawn(move || {
            rx.recv().unwrap(); // inside the lock's erase: `begin` waits for its commit
            b.index.begin().unwrap();
            assert!(b.apply_chunk(&[p], None, true, &mut vec![], &mut false));
            std::thread::sleep(std::time::Duration::from_millis(400));
            b.index.commit().unwrap();
        });
        let r = a.lock_note(&d.path, &id);
        other.join().unwrap();
        a.index.raw().execute_batch("DROP TRIGGER erased").unwrap();
        a.lock_all();
        match r {
            Ok(_) => {
                assert!(a.search("racezebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty(), "plain text searchable after a successful lock");
                assert!(a.index.task_rows(&[], true).unwrap().is_empty());
            }
            Err(_) => {
                assert!(Path::new(&d.path).exists() && !dir.join("s.md.age").exists());
                assert_eq!(a.open_note(&d.path, None).unwrap().text, "- [ ] racezebra");
            }
        }
    }
    /// A plain row put back by a writer that ignores twins (an older build) and a failing second erase: the lock
    /// still succeeds (the file has moved), and the next change in the session erases the row.
    #[test] fn a_failed_second_erase_of_a_lock_is_retried_by_the_next_change() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let path = d.path.replace('\'', "''");
        v.index.raw().execute_batch(&format!(
            "CREATE TEMP TRIGGER back AFTER INSERT ON notes WHEN NEW.path LIKE '%.md.age' BEGIN
               INSERT INTO notes(path,title,title_folded,mtime,size,encrypted,preview,created,created_src,modified,modified_src) VALUES('{path}','s','s',1,1,0,'retryzebra',1,'file',1,'file');
               INSERT INTO notes_fts(rowid,path,body) VALUES((SELECT rowid FROM notes WHERE path='{path}'),'{path}','retryzebra');
             END;
             CREATE TEMP TRIGGER full BEFORE DELETE ON notes WHEN OLD.path = '{path}' AND EXISTS(SELECT 1 FROM notes WHERE path LIKE '%.md.age') BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;")).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        assert_eq!(v.search("retryzebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); // the second erase failed
        v.index.raw().execute_batch("DROP TRIGGER back; DROP TRIGGER full").unwrap();
        let changed = v.apply_fs_changes(&[], None);
        assert!(v.search("retryzebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty(), "the plain row is still searchable");
        assert!(v.index.title_modified(&d.path).unwrap().is_none());
        assert_eq!(changed, vec![d.path.clone()]);
    }
    /// Body, tasks, tags and outgoing links of `s.md` (`BACK`) as the index has them.
    fn twin_text(v: &Vault) -> (usize, usize, usize, usize) {
        (v.search("backzebra", Sort::Modified, 0, &[]).unwrap().hits.len(), v.index.task_rows(&[], true).unwrap().len(), v.tags(true).unwrap().len(), v.index.backlinks("Target").unwrap().len())
    }
    const BACK: &str = "- [ ] backzebra #backtag [[Target]]";
    /// A twin pair on disk, opened: the plain copy is indexed without its text.
    fn twin_pair() -> (Vault, PathBuf, PathBuf) {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
        (v, dir, db)
    }
    /// #147 review M1: an unlock on another device synced in as "s.md added", then "s.md.age deleted". The plain
    /// file keeps its mtime and size, and the delete event names only the locked copy: its text must come back.
    #[test] fn a_twin_gets_its_text_back_when_the_watcher_sees_the_locked_copy_go() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        v.apply_fs_changes(&[dir.join("s.md")], None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
        std::fs::remove_file(dir.join("s.md.age")).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
        assert!(v.rescan(None).is_empty(), "the row is current: a rescan finds nothing");
    }
    /// #147 review M1: the user trashes the locked copy of a twin pair in the app.
    #[test] fn a_twin_gets_its_text_back_when_its_locked_copy_is_trashed() {
        let (mut v, dir, _db) = twin_pair();
        v.delete_note_with(&dir.join("s.md.age").to_string_lossy(), |p| std::fs::remove_file(p)).unwrap();
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// #147 review M1: the twin ended while Velo was closed. A warm open must not skip the text-less row because the
    /// file's mtime and size are unchanged.
    #[test] fn a_twin_gets_its_text_back_at_a_warm_open() {
        let (v, dir, db) = twin_pair();
        drop(v);
        std::fs::remove_file(dir.join("s.md.age")).unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// #147 review M1: the watcher missed the delete; a rescan repairs it.
    #[test] fn a_twin_gets_its_text_back_at_a_rescan() {
        let (mut v, dir, _db) = twin_pair();
        std::fs::remove_file(dir.join("s.md.age")).unwrap();
        let changed = v.rescan(None);
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
        assert!(changed.contains(&dir.join("s.md").to_string_lossy().into_owned()), "{changed:?}");
        assert!(v.rescan(None).is_empty(), "no churn once current");
    }
    /// The reverse: a lock on another device syncs in as "s.md.age added" first. The plain row loses its text at
    /// once, though the event names only the locked copy; a rescan of a still-twin row finds nothing to do.
    #[test] fn a_plain_note_loses_its_text_when_a_locked_copy_appears() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
        assert!(v.rescan(None).is_empty(), "a twin's row is current: no churn");
    }
    /// #147 review m1 / Copilot: Velo killed between the lock's write of the locked copy and its erase, or an index
    /// written by an older build that kept a twin's text. A warm open (index kept, `s.md` unchanged) must drop it.
    #[test] fn a_warm_open_drops_the_text_of_a_twin_indexed_with_it() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
        drop(v);
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
    }
    /// Renaming the locked copy of a twin pair to another title ends the twin too.
    #[test] fn a_twin_gets_its_text_back_when_its_locked_copy_is_renamed() {
        let (mut v, dir, _db) = twin_pair();
        let r = v.rename_note(&dir.join("s.md.age").to_string_lossy(), "other", false).unwrap();
        assert!(r.path.ends_with("other.md.age"));
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// Unlocking `s.md.age` beside a `s.txt` twin: `s.txt` is no longer a twin and gets its text back.
    #[test] fn a_txt_twin_gets_its_text_back_when_the_locked_note_is_unlocked() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.txt"), BACK).unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"locked").unwrap()).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
        v.unlock_note(&dir.join("s.md.age").to_string_lossy(), &id).unwrap();
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// Copilot on #147: a retried path whose re-index fails (a plain twin recreated by a sync) stays on the retry list.
    #[test] fn a_retried_path_whose_reindex_fails_is_kept() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let p = dir.join("s.md");
        v.retry.push(p.clone());
        std::fs::write(&p, BACK).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        v.apply_fs_changes(&[], None);
        assert_eq!(v.retry, vec![p.clone()]);
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap();
        assert_eq!(v.apply_fs_changes(&[], None), vec![p.to_string_lossy().into_owned()]);
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// Paths the index lists, sorted.
    fn rows(v: &Vault) -> Vec<String> {
        let mut r: Vec<String> = v.index.known().unwrap().into_keys().collect();
        r.sort();
        r
    }
    /// #148: a disk that folds case (macOS, Windows) makes `meeting.md.age` the locked copy of `Meeting.md`; one that
    /// doesn't (Linux) keeps them two notes. Either way the index follows the disk: no second row for `Meeting.md`,
    /// and no row a rescan finds stale. Also for pairs only full case folding makes (APFS: `µ`/`μ`, `ß`/`ss`).
    #[test] fn a_case_only_twin_is_paired_as_the_disk_pairs_it() {
        for (plain, other) in [("Meeting", "meeting"), ("µq", "μq"), ("Straße", "STRASSE")] {
            let (dir, db) = setup(); let id = crypto::new_identity();
            let plain = dir.join(format!("{plain}.md"));
            std::fs::write(&plain, BACK).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            let locked = dir.join(format!("{other}.md.age"));
            std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
            let folds = plain.with_extension("md.age").exists();
            let paired = if folds { (0, 0, 0, 0) } else { (1, 1, 1, 1) };
            v.apply_fs_changes(std::slice::from_ref(&locked), None);
            let mut both = vec![s(&plain), s(&locked)];
            both.sort();
            assert_eq!((twin_text(&v), rows(&v)), (paired, both), "{plain:?}");
            assert!(v.rescan(None).is_empty(), "no churn");
            std::fs::remove_file(&locked).unwrap();
            v.apply_fs_changes(std::slice::from_ref(&locked), None);
            assert_eq!((twin_text(&v), rows(&v)), ((1, 1, 1, 1), vec![s(&plain)]), "{plain:?}");
            assert!(v.rescan(None).is_empty(), "no churn");
        }
    }
    /// #148 (Copilot on #147): the case-only locked copy appeared while Velo was closed, `Meeting.md` unchanged.
    #[test] fn a_case_only_twin_is_paired_at_a_warm_open() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Meeting.md"), BACK).unwrap();
        drop(open(dir.clone(), &db, None).unwrap());
        std::fs::write(dir.join("meeting.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        let folds = dir.join("Meeting.md.age").exists();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), if folds { (0, 0, 0, 0) } else { (1, 1, 1, 1) });
        assert!(v.rescan(None).is_empty(), "no churn");
    }
    /// #159: a FIFO named like a note (`s.md`, `s.md.age`) reaching the watcher, a save or the agent fails at once,
    /// instead of blocking in `open` with the vault lock held. No row is written for it.
    #[cfg(unix)]
    #[test] fn a_fifo_named_like_a_note_never_blocks() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let (plain, locked) = (dir.join("s.md"), dir.join("s.md.age"));
        for p in [&plain, &locked] {
            crate::store::fifo::make(p);
        }
        let (changed, rows, refused) = crate::store::fifo::within("vault", move || {
            let changed = v.apply_fs_changes(&[plain.clone(), locked.clone()], None);
            let p = s(&plain);
            let refused = (v.open_note(&p, None).is_err(), v.save_note(&p, "x", "h", None, false).is_err(), v.agent_snapshot(&p, "x").is_err(), v.rewritable(&plain));
            (changed, rows(&v), refused)
        });
        assert_eq!((changed, rows, refused), (vec![], vec![], (true, true, true, false)));
    }
    /// #159: revisions are keyed by the folded title. A locked note arriving with no key deletes the plaintext history
    /// under that key only when no other plain note shares it: `Café.md` beside `Cafe.md.age` (two notes on every disk),
    /// `Plan.md` beside `plan.md.age` on a case-sensitive one. Where the disk pairs them, the plain note is the locked
    /// note's twin and its history goes as before. With a key the history is encrypted, never lost.
    #[test] fn a_locked_note_keeps_the_history_of_a_fold_equal_plain_note() {
        for (plain, other) in [("Café", "Cafe"), ("Plan", "plan")] {
            for with_id in [false, true] {
                let (dir, db) = setup(); let id = crypto::new_identity();
                let ident = with_id.then_some(id.as_str());
                let plain_p = dir.join(format!("{plain}.md"));
                std::fs::write(&plain_p, BACK).unwrap();
                let mut v = open(dir.clone(), &db, ident).unwrap();
                for (i, h) in ["history one", "history two"].iter().enumerate() {
                    v.revisions.snapshot_bytes(plain, h.as_bytes(), false, now_ms() - 10_000 + i as i64 * 1_000, false).unwrap();
                }
                let locked = dir.join(format!("{other}.md.age"));
                std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
                let twins = plain_p.with_extension("md.age").exists();
                v.apply_fs_changes(std::slice::from_ref(&locked), ident);
                let case = format!("{plain}/{other} id={with_id} twins={twins}");
                let revs = v.list_revisions(&s(&plain_p)).unwrap();
                if twins && !with_id {
                    assert!(revs.is_empty(), "{case}: a twin's plaintext history goes");
                    continue;
                }
                assert_eq!(revs.len(), 2, "{case}");
                for r in &revs {
                    assert!(v.read_revision(&s(&plain_p), &r.id, ident).unwrap().starts_with("history"), "{case}");
                }
            }
        }
    }
    /// `Café.md` (made by `make`) with two plaintext revisions, opened with no key; then `Cafe.md.age` arrives through
    /// the watcher.
    fn cafe_pair(make: impl FnOnce(&Path)) -> (Vault, PathBuf, PathBuf, String, PathBuf) {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let plain = dir.join("Caf\u{e9}.md");
        make(&plain);
        let mut v = open(dir.clone(), &db, None).unwrap();
        for (i, h) in ["history one", "history two"].iter().enumerate() {
            v.revisions.snapshot_bytes("Caf\u{e9}", h.as_bytes(), false, now_ms() - 10_000 + i as i64 * 1_000, false).unwrap();
        }
        let locked = dir.join("Cafe.md.age");
        std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&locked), None);
        (v, plain, locked, id, db)
    }
    /// #163: history the guard held back is never listed or read through the locked note. The plain note that shares
    /// the folder keeps listing it, and takes it along on a rename. Once that note is gone, a rescan or a relaunch does
    /// not secure it (the locked row is current); the next arrival of the locked file does.
    #[test] fn held_back_history_is_hidden_from_the_locked_note_and_secured_at_its_next_arrival() {
        for how in ["delete", "rename"] {
            let (mut v, plain, locked, id, db) = cafe_pair(|p| std::fs::write(p, BACK).unwrap());
            let (ps, ls) = (s(&plain), s(&locked));
            let ids: Vec<String> = v.list_revisions(&ps).unwrap().into_iter().map(|r| r.id).collect();
            assert_eq!(ids.len(), 2, "{how}: the plain note keeps its history");
            assert!(v.list_revisions(&ls).unwrap().is_empty(), "{how}: the locked note lists no plaintext");
            assert!(ids.iter().all(|i| v.read_revision(&ls, i, None).is_err()), "{how}: nor reads it");
            if how == "rename" {
                let foo = v.rename_note(&ps, "Foo", false).unwrap().path;
                assert_eq!(v.list_revisions(&foo).unwrap().len(), 2, "rename: the shared history moves with the plain note");
                assert!(!v.revisions.has_plain("Cafe"));
                continue;
            }
            std::fs::remove_file(&plain).unwrap();
            v.apply_fs_changes(std::slice::from_ref(&plain), None);
            v.rescan(None);
            assert!(v.revisions.has_plain("Cafe"), "a rescan alone does not secure it");
            let dir = plain.parent().unwrap().to_path_buf();
            drop(v);
            let mut v = open(dir, &db, None).unwrap();
            assert!(v.revisions.has_plain("Cafe"), "a relaunch alone does not secure it");
            assert!(v.list_revisions(&ls).unwrap().is_empty(), "still hidden from the locked note");
            std::fs::write(&locked, crypto::encrypt(&id, b"y").unwrap()).unwrap();
            v.apply_fs_changes(std::slice::from_ref(&locked), None);
            assert!(!v.revisions.has_plain("Cafe"), "the next arrival secures it");
        }
    }
    /// #163 review: what holds the delete back. A dangling link is no note (m1): the history goes. A twin check the
    /// disk can't answer, or a folder that can't be listed, is a doubt: the history stays (mutations M4, M3).
    #[test] fn only_a_plain_note_or_a_doubt_holds_history_back() {
        #[cfg(unix)]
        {
            let (v, ..) = cafe_pair(|p| std::os::unix::fs::symlink(p.with_file_name("gone"), p).unwrap());
            assert!(!v.revisions.has_plain("Cafe"), "dangling link: secured");
        }
        STAT_FAIL.with(|f| f.set(Some(std::io::ErrorKind::PermissionDenied)));
        let (v, ..) = cafe_pair(|p| std::fs::write(p, BACK).unwrap());
        STAT_FAIL.with(|f| f.set(None));
        assert!(v.revisions.has_plain("Cafe"), "twin doubt: kept");
        // a folder that can be searched but not listed
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let (dir, db) = setup(); let id = crypto::new_identity();
            std::fs::write(dir.join("Caf\u{e9}.md"), BACK).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            v.revisions.snapshot_bytes("Cafe", b"history", false, now_ms() - 1_000, false).unwrap();
            let locked = dir.join("Cafe.md.age");
            std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o300)).unwrap();
            let listable = std::fs::read_dir(&dir).is_ok(); // root lists anyway
            v.apply_fs_changes(std::slice::from_ref(&locked), None);
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(listable || v.revisions.has_plain("Cafe"), "unlistable folder: kept");
        }
    }
    /// #163 review M1: a bulk of locked notes arriving with no key lists the folder only for titles with plaintext
    /// history, and then once per chunk.
    #[test] fn securing_lists_the_folder_once_and_only_for_plaintext_history() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        for i in 0..5 { std::fs::write(dir.join(format!("p{i}.md")), "x").unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let arrive = |v: &mut Vault, names: Vec<String>| {
            let paths: Vec<PathBuf> = names.iter().map(|n| dir.join(format!("{n}.md.age"))).collect();
            for p in &paths { std::fs::write(p, crypto::encrypt(&id, b"x").unwrap()).unwrap(); }
            FOLD_LISTINGS.with(|c| c.set(0));
            v.apply_fs_changes(&paths, None);
            FOLD_LISTINGS.with(|c| c.get())
        };
        assert_eq!(arrive(&mut v, (0..20).map(|i| format!("L{i}")).collect()), 0, "no plaintext history: no listing");
        for i in 0..3 { v.revisions.snapshot_bytes(&format!("M{i}"), b"old", false, now_ms() - 1_000, false).unwrap(); }
        assert_eq!(arrive(&mut v, (0..3).map(|i| format!("M{i}")).collect()), 1, "one listing per chunk");
        assert!((0..3).all(|i| !v.revisions.has_plain(&format!("M{i}"))), "no plain note shares them: secured");
    }
    /// #148: a title the stem mapping rewrites (cut at 200 bytes here; `What?` → `What-` alike) pairs with the locked
    /// copy `note_path` names, and is re-synced when that copy comes and goes.
    #[test] fn a_twin_whose_stem_differs_from_its_title_is_resynced() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let plain = dir.join(format!("{}.md", "ж".repeat(101)));
        std::fs::write(&plain, BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let locked = note_path(&dir, &"ж".repeat(101), true);
        assert_eq!(locked, dir.join(format!("{}.md.age", "ж".repeat(100))));
        std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&locked), None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
        assert!(v.rescan(None).is_empty(), "no churn");
        std::fs::remove_file(&locked).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&locked), None);
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// #148: a folder named like a locked copy is not one (the folder listing skips it): `s.md` keeps its text and
    /// a rescan finds it current.
    #[test] fn a_folder_named_like_a_locked_copy_is_not_one() {
        let (dir, db) = setup();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        std::fs::create_dir(dir.join("s.md.age")).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
        assert!(v.rescan(None).is_empty(), "no churn");
        assert!(!plain_twin_of_locked(&dir.join("s.md")));
        #[cfg(unix)] // a link to a folder neither
        {
            std::fs::write(dir.join("t.md"), "t").unwrap();
            std::os::unix::fs::symlink(dir.join("s.md.age"), dir.join("t.md.age")).unwrap();
            assert!(!plain_twin_of_locked(&dir.join("t.md")));
        }
    }
    /// Makes a folder at `p`, or (unix) a link to one or a socket.
    fn folder_at(p: &Path, kind: &str) {
        match kind {
            "folder" => std::fs::create_dir(p).unwrap(),
            #[cfg(unix)]
            "link" => std::os::unix::fs::symlink(tempfile::tempdir().unwrap().keep(), p).unwrap(),
            #[cfg(unix)]
            "socket" => drop(std::os::unix::net::UnixListener::bind(p).unwrap()), // the socket file stays
            _ => unreachable!(),
        }
    }
    const SPECIAL: &[&str] = if cfg!(unix) { &["folder", "link", "socket"] } else { &["folder"] };
    /// Copilot on #156: a folder (or a link to one) named `s.md.age` that reaches the watcher, a rescan or a warm open
    /// is no locked note: no row, and the plain note `s.md` keeps its text and its plaintext history, with or without
    /// a key. A bogus row an earlier build wrote is removed by a warm open. #156 full review m2: a socket neither.
    #[test] fn a_folder_named_like_a_locked_copy_touches_no_history() {
        for &link in SPECIAL {
            for with_id in [false, true] {
                for how in ["event", "rescan", "open"] {
                    let (dir, db) = setup(); let id = crypto::new_identity();
                    let ident = with_id.then_some(id.as_str());
                    let plain = dir.join("s.md");
                    std::fs::write(&plain, BACK).unwrap();
                    let mut v = open(dir.clone(), &db, ident).unwrap();
                    for (i, h) in ["history one", "history two"].iter().enumerate() {
                        v.revisions.snapshot_bytes("s", h.as_bytes(), false, now_ms() - 10_000 + i as i64 * 1_000, false).unwrap();
                    }
                    let age = dir.join("s.md.age");
                    folder_at(&age, link);
                    match how {
                        "event" => { v.apply_fs_changes(std::slice::from_ref(&age), ident); }
                        "rescan" => { v.rescan(ident); }
                        _ => v = open(dir.clone(), &db, ident).unwrap(),
                    }
                    let case = format!("link={link} id={with_id} {how}");
                    assert_eq!((rows(&v), twin_text(&v)), (vec![s(&plain)], (1, 1, 1, 1)), "{case}");
                    let revs = v.revisions.list("s");
                    assert_eq!(revs.len(), 2, "{case}");
                    for r in &revs {
                        let (bytes, enc) = v.revisions.read("s", &r.id).unwrap();
                        assert!(!enc && bytes.starts_with(b"history"), "{case}");
                    }
                    if how == "rescan" { // a bogus row from an earlier build: kept like any unreadable path, history too
                        v.index.upsert(&s(&age), &parse_note_file(&age).unwrap(), &stat(&plain).unwrap(), None).unwrap();
                        v.rescan(ident);
                        assert_eq!((twin_text(&v), v.revisions.list("s").len()), ((1, 1, 1, 1), 2), "{case}: bogus row");
                    }
                    if how == "open" {
                        v.index.upsert(&s(&age), &parse_note_file(&age).unwrap(), &stat(&plain).unwrap(), None).unwrap();
                        drop(v);
                        let v = open(dir.clone(), &db, ident).unwrap();
                        assert_eq!((rows(&v), v.revisions.list("s").len()), (vec![s(&plain)], 2), "{case}: a bogus row from an earlier build");
                    }
                }
            }
        }
    }
    /// #156 scoped check m4: a link `s.md.age -> /dev/null` stats, but it is no regular file: since #159 it is not read
    /// and gets no row (it wrote a stray locked row before), and the history of `s` is neither deleted nor encrypted,
    /// with or without a key.
    #[cfg(unix)]
    #[test] fn a_locked_name_linked_to_a_device_keeps_the_history() {
        for with_id in [false, true] {
            for how in ["event", "rescan"] {
                let (dir, db) = setup(); let id = crypto::new_identity();
                let ident = with_id.then_some(id.as_str());
                std::fs::write(dir.join("s.md"), BACK).unwrap();
                let mut v = open(dir.clone(), &db, ident).unwrap();
                for (i, h) in ["history one", "history two"].iter().enumerate() {
                    v.revisions.snapshot_bytes("s", h.as_bytes(), false, now_ms() - 10_000 + i as i64 * 1_000, false).unwrap();
                }
                let age = dir.join("s.md.age");
                std::os::unix::fs::symlink("/dev/null", &age).unwrap();
                v.apply_fs_changes(std::slice::from_ref(&age), ident);
                let case = format!("id={with_id} {how}");
                assert!(!rows(&v).contains(&s(&age)), "{case}: a device is not read: no row");
                if how == "rescan" {
                    v.rescan(ident);
                }
                let revs = v.revisions.list("s");
                assert_eq!(revs.len(), 2, "{case}");
                for r in &revs {
                    let (bytes, enc) = v.revisions.read("s", &r.id).unwrap();
                    assert!(!enc && bytes.starts_with(b"history"), "{case}");
                }
            }
        }
    }
    /// The mirror image: a folder (or a link to one) named `s.md` or `s.txt` beside a real `s.md.age` is no plain twin.
    #[test] fn a_folder_named_like_a_plain_twin_is_not_one() {
        for &link in SPECIAL {
            let (dir, db) = setup(); let id = crypto::new_identity();
            let age = dir.join("s.md.age");
            std::fs::write(&age, crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            let folders = [dir.join("s.md"), dir.join("s.txt")];
            for f in &folders { folder_at(f, link); }
            v.apply_fs_changes(&folders, None);
            v.rescan(None);
            assert_eq!(rows(&v), vec![s(&age)], "link={link}");
            assert_eq!(rows(&open(dir.clone(), &db, None).unwrap()), vec![s(&age)], "link={link}: warm open");
        }
    }
    /// #156 full review m1: while the disk can't stat `.md.age` names (I/O errors), a locked-note event leaves every
    /// other row as it is and asks again later; the retry settles them once the error ends, with no locked event. A
    /// name too long to exist is no locked copy: the plain note saves, as on `main`.
    #[test] fn a_disk_that_cannot_stat_locked_names_strips_no_other_text() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        for k in 0..3 { std::fs::write(dir.join(format!("p{k}.md")), "plainzebra").unwrap(); }
        std::fs::write(dir.join("u.md"), "uzebra").unwrap();
        let (u_age, new_age) = (dir.join("u.md.age"), dir.join("new.md.age"));
        std::fs::write(&u_age, crypto::encrypt(&id, b"x").unwrap()).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let hits = |v: &Vault| ["plainzebra", "uzebra"].map(|q| v.search(q, Sort::Modified, 0, &[]).unwrap().hits.len());
        assert_eq!(hits(&v), [3, 0]);
        STAT_FAIL.set(Some(std::io::ErrorKind::Other));
        std::fs::remove_file(&u_age).unwrap();
        std::fs::write(&new_age, crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(&[u_age, new_age], None);
        assert_eq!(hits(&v), [3, 0], "no row rewritten on a stat error");
        let p0 = s(&dir.join("p0.md"));
        let save = |v: &mut Vault| { let h = v.open_note(&p0, None).unwrap().hash; v.save_note(&p0, "plainzebra again", &h, None, false).map(|_| ()) };
        assert_eq!(save(&mut v).unwrap_err().to_string(), "locked-sibling", "a note decided on its own fails closed");
        STAT_FAIL.set(Some(std::io::ErrorKind::InvalidFilename));
        save(&mut v).unwrap();
        STAT_FAIL.set(None);
        v.apply_fs_changes(&[], None); // the retry
        assert_eq!(hits(&v), [3, 1]);
        drop(v);
        STAT_FAIL.set(Some(std::io::ErrorKind::Other));
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(hits(&v), [3, 1], "a warm open keeps the rows too");
        STAT_FAIL.set(None);
    }
    /// #156 review M1: a symlink named like a locked copy (git-annex keeps `.md.age` files as links) is one when it
    /// leads to a file, and so is a dangling one: in doubt, the plain note is locked.
    #[cfg(unix)]
    #[test] fn a_symlinked_locked_copy_counts_even_dangling() {
        for dangling in [false, true] {
            let (dir, db) = setup(); let id = crypto::new_identity();
            let real = tempfile::tempdir().unwrap().keep().join("s.md.age");
            if !dangling {
                std::fs::write(&real, crypto::encrypt(&id, b"x").unwrap()).unwrap();
            }
            std::fs::write(dir.join("s.md"), BACK).unwrap();
            std::os::unix::fs::symlink(&real, dir.join("s.md.age")).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            assert_eq!(twin_text(&v), (0, 0, 0, 0), "dangling: {dangling}");
            assert!(v.rescan(None).is_empty(), "no churn");
            let p = s(&dir.join("s.md"));
            let d = v.open_note(&p, None).unwrap();
            assert!(v.save_note(&p, "edited", &d.hash, None, false).is_err());
            assert!(v.snapshot_text(&p, "edited", None).is_err() && v.agent_snapshot(&p, "x").is_err());
        }
    }
    /// #156 review M1: a locked copy the disk can't tell about (a folder without search permission) counts as one.
    #[cfg(unix)]
    #[test] fn a_locked_copy_that_cannot_be_checked_counts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap().keep();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o600)).unwrap();
        let twin = plain_twin_of_locked(&dir.join("s.md"));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(twin);
        assert!(!plain_twin_of_locked(&dir.join("s.md")), "nothing there: no locked copy");
    }
    /// #156 review M2: a plain twin that can't be read (evicted by iCloud, held by a sync) loses its text all the same:
    /// a twin's row needs no bytes. Through the watcher, a warm open and a rescan.
    #[cfg(unix)]
    #[test] fn an_unreadable_twin_loses_its_text() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path, m| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        for path in ["watcher", "warm open", "rescan", "plain event"] {
            let (dir, db) = setup(); let id = crypto::new_identity();
            let plain = dir.join("s.md");
            std::fs::write(&plain, BACK).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            let locked = dir.join("s.md.age");
            std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
            mode(&plain, 0o000);
            match path {
                "watcher" => { v.apply_fs_changes(std::slice::from_ref(&locked), None); }
                "warm open" => { drop(v); v = open(dir.clone(), &db, None).unwrap(); }
                "rescan" => { v.rescan(None); }
                _ => { // a twin row with its text (an older build, a late writer in another process), then an event for it
                    v.apply_fs_changes(std::slice::from_ref(&locked), None);
                    v.index.upsert(&s(&plain), &parse_note_file(&plain).unwrap(), &stat(&plain).unwrap(), Some(BACK)).unwrap();
                    v.apply_fs_changes(std::slice::from_ref(&plain), None);
                }
            }
            let hidden = twin_text(&v);
            mode(&plain, 0o644);
            assert_eq!(hidden, (0, 0, 0, 0), "{path}");
            std::fs::write(dir.join("other.md"), "o").unwrap();
            v.apply_fs_changes(&[dir.join("other.md")], None);
            assert_eq!(twin_text(&v), (0, 0, 0, 0), "{path}: readable again");
            assert!(v.rescan(None).is_empty(), "{path}: no churn");
        }
    }
    /// #148: a twin whose re-index fails as its locked copy appears keeps its text only until the next change.
    #[test] fn a_twin_whose_resync_fails_is_retried_by_the_next_change() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE INSERT ON notes WHEN NEW.path NOT LIKE '%.age' BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert_eq!(twin_text(&v), (1, 1, 1, 1)); // the resync failed
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap();
        v.apply_fs_changes(&[], None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0), "the twin's text is still searchable");
    }
    /// #156 review 2 MJ1: a locked copy that can't be read when it arrives (evicted by iCloud, held by a sync) is still
    /// listed and still takes its plain twin's text: a locked note's row needs no bytes.
    #[cfg(unix)]
    #[test] fn an_unreadable_locked_copy_takes_its_twins_text() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path, m| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        for path in ["watcher", "warm open", "rescan"] {
            let (dir, db) = setup(); let id = crypto::new_identity();
            std::fs::write(dir.join("s.md"), BACK).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            let locked = dir.join("s.md.age");
            std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
            mode(&locked, 0o000);
            match path {
                "watcher" => { v.apply_fs_changes(std::slice::from_ref(&locked), None); }
                "warm open" => { drop(v); v = open(dir.clone(), &db, None).unwrap(); }
                _ => { v.rescan(None); }
            }
            let (hidden, listed) = (twin_text(&v), v.index.title_modified(&s(&locked)).unwrap().is_some());
            std::fs::write(dir.join("other.md"), "o").unwrap();
            v.apply_fs_changes(&[dir.join("other.md")], None);
            let next = twin_text(&v);
            mode(&locked, 0o644);
            assert_eq!((hidden, listed, next), ((0, 0, 0, 0), true, (0, 0, 0, 0)), "{path}");
            std::fs::write(dir.join("other.md"), "o2").unwrap();
            v.apply_fs_changes(&[dir.join("other.md")], None);
            assert_eq!(twin_text(&v), (0, 0, 0, 0), "{path}: readable again");
        }
    }
    /// #156 review 2 m1: re-syncing twins scans every plain row, so it runs once per open, batch or rename, not once
    /// per locked note in it.
    #[test] fn twins_are_resynced_once_per_open_batch_and_rename() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let age = |k: usize| dir.join(format!("s{k}.md.age"));
        for k in 0..3 {
            std::fs::write(dir.join(format!("s{k}.md")), BACK).unwrap();
            std::fs::write(age(k), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        }
        drop(open(dir.clone(), &db, None).unwrap());
        for k in 0..3 { std::fs::remove_file(age(k)).unwrap(); } // three locked notes gone while Velo was closed
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!((v.resync_scans, twin_text(&v).0), (1, 3));
        for k in 0..3 { std::fs::write(age(k), crypto::encrypt(&id, b"x").unwrap()).unwrap(); }
        v.apply_fs_changes(&(0..3).map(age).collect::<Vec<_>>(), None);
        assert_eq!((v.resync_scans, twin_text(&v).0), (2, 0));
        v.rename_note(&s(&age(0)), "renamed", false).unwrap(); // the locked note leaves `s0` and arrives at `renamed`
        assert_eq!((v.resync_scans, twin_text(&v).0), (3, 1));
    }
    /// #156 review 2 m1: the batch's one re-sync runs even when the batch fails partway (a transaction-ending error,
    /// then note by note).
    #[test] fn a_batch_that_fails_partway_still_resyncs_twins() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE INSERT ON notes WHEN NEW.path LIKE '%bad.md' BEGIN SELECT RAISE(ROLLBACK, 'disk I/O error'); END;").unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        std::fs::write(dir.join("bad.md"), "bad").unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age"), dir.join("bad.md")], None);
        assert_eq!((v.resync_scans, twin_text(&v)), (1, (0, 0, 0, 0)));
        assert!(v.index.title_modified(&s(&dir.join("bad.md"))).unwrap().is_none()); // the batch did fail
    }
    /// #156 review 2 m3: a row left under the old spelling of a case-only rename made outside Velo (a case-insensitive
    /// disk reads it under both) loses its text too when the locked copy arrives.
    #[test] fn a_row_under_an_old_spelling_loses_its_text_to_a_locked_copy() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Meeting.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::rename(dir.join("Meeting.md"), dir.join("meeting.md")).unwrap();
        v.apply_fs_changes(&[dir.join("Meeting.md"), dir.join("meeting.md")], None);
        assert!(twin_text(&v).0 >= 1);
        let locked = dir.join("meeting.md.age");
        std::fs::write(&locked, crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&locked), None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0), "{:?}", rows(&v));
    }
    /// #156 review m2: a lock whose plaintext and locked copy can't be removed (a folder made read-only after the
    /// erase) leaves a stray locked copy: it is listed at once, takes the plain row's text, and the error names it.
    #[cfg(unix)]
    #[test] fn a_failed_move_that_leaves_its_locked_copy_lists_it() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, BACK, &d.hash, None, false).unwrap();
        let ro = dir.clone();
        v.index.raw().create_scalar_function("readonly", 0, rusqlite::functions::FunctionFlags::SQLITE_UTF8, move |_| {
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).ok();
            Ok(0)
        }).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER ro AFTER DELETE ON notes WHEN OLD.path NOT LIKE '%.age' BEGIN SELECT readonly(); END;
            CREATE TEMP TABLE seen(path); CREATE TEMP TRIGGER seen AFTER INSERT ON notes WHEN NEW.preview LIKE '%backzebra%' BEGIN INSERT INTO seen VALUES(NEW.path); END;").unwrap();
        let r = v.lock_note(&d.path, &id);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        v.index.raw().execute_batch("DROP TRIGGER ro").unwrap();
        let e = r.unwrap_err().to_string();
        assert!(e.contains("removing plaintext note") && e.contains("s.md.age") && e.contains("Trash"), "{e}");
        assert!(Path::new(&d.path).exists() && dir.join("s.md.age").exists());
        assert!(v.index.title_modified(&s(&dir.join("s.md.age"))).unwrap().is_some(), "the stray locked copy is not listed");
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
        let seen: i64 = v.index.raw().query_row("SELECT count(*) FROM seen", [], |r| r.get(0)).unwrap();
        assert_eq!(seen, 0, "the rollback wrote the text, even for a moment");
        v.apply_fs_changes(&[], None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
    }
    /// Every cell that can hold a note's text: previews, the full-text body, tasks, tags, links.
    fn text_cells(v: &Vault) -> i64 {
        v.index.raw().query_row(
            "SELECT (SELECT count(*) FROM notes WHERE preview LIKE '%backzebra%') + (SELECT count(*) FROM notes_fts WHERE body LIKE '%backzebra%') + (SELECT count(*) FROM tasks) + (SELECT count(*) FROM tags) + (SELECT count(*) FROM links)",
            [], |r| r.get(0)).unwrap()
    }
    /// #156 review 3 MJ1: a case-only rename (in Finder, or by Velo) gives the watcher both spellings; a
    /// case-insensitive disk still opens the old one. It must not become a second row, which no event would ever erase
    /// once the note is locked (by Velo, or synced in).
    #[test] fn a_case_only_rename_then_a_lock_leaves_no_text() {
        for (velo_rename, velo_lock) in [(false, true), (false, false), (true, true), (true, false)] {
            let (dir, db) = setup(); let id = crypto::new_identity();
            std::fs::write(dir.join("Meeting.md"), BACK).unwrap();
            let mut v = open(dir.clone(), &db, None).unwrap();
            if velo_rename {
                v.rename_note(&s(&dir.join("Meeting.md")), "meeting", false).unwrap();
            } else {
                std::fs::rename(dir.join("Meeting.md"), dir.join("meeting.md")).unwrap();
            }
            v.apply_fs_changes(&[dir.join("Meeting.md"), dir.join("meeting.md")], None);
            let how = format!("velo_rename={velo_rename} velo_lock={velo_lock}");
            assert_eq!(rows(&v), vec![s(&dir.join("meeting.md"))], "{how}: one row per file");
            let (plain, age) = (dir.join("meeting.md"), dir.join("meeting.md.age"));
            if velo_lock {
                v.lock_note(&s(&plain), &id).unwrap();
            } else {
                std::fs::write(&age, crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
                std::fs::remove_file(&plain).unwrap();
            }
            v.apply_fs_changes(&[plain.clone(), age.clone()], None);
            v.lock_all();
            assert_eq!((twin_text(&v), text_cells(&v), rows(&v)), ((0, 0, 0, 0), 0, vec![s(&age)]), "{how}");
        }
    }
    /// #156 review 3 MJ1: a file created after the batch read the folder listing is still a note of its own.
    #[test] fn a_file_new_since_the_listing_is_indexed() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("a.md"), "a").unwrap();
        let b = dir.join("b.md");
        let made = b.clone();
        v.index.raw().create_scalar_function("make_b", 0, rusqlite::functions::FunctionFlags::SQLITE_UTF8, move |_| { std::fs::write(&made, "b").ok(); Ok(0) }).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER mk AFTER INSERT ON notes WHEN NEW.path LIKE '%a.md' BEGIN SELECT make_b(); END;").unwrap();
        v.apply_fs_changes(&[dir.join("a.md"), b.clone()], None);
        assert_eq!(rows(&v), vec![s(&dir.join("a.md")), s(&b)]);
    }
    /// #156 review 4 n1: another device unlocked `s` (the sync deletes `s.md.age` and writes `s.md`, in two batches);
    /// between them the open editor autosaves the locked note and so writes `s.md.age` again. Its row never went, and
    /// the watcher skips our own write: the save itself must take the twin's text.
    #[test] fn an_autosave_that_recreates_a_locked_copy_takes_its_twins_text() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let d = v.open_or_create("s", Some(&id), false).unwrap();
        v.save_note(&d.path, "orig", &d.hash, Some(&id), false).unwrap();
        let locked = v.lock_note(&d.path, &id).unwrap();
        let doc = v.open_note(&locked, Some(&id)).unwrap();
        let (plain, age) = (dir.join("s.md"), dir.join("s.md.age"));
        std::fs::remove_file(&age).unwrap();
        std::fs::write(&plain, BACK).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&plain), None);
        assert_eq!(twin_text(&v), (1, 1, 1, 1)); // no locked copy on disk: the text is fine
        v.save_note(&locked, "edited here", &doc.hash, Some(&id), false).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&age), None);
        v.lock_all();
        assert_eq!((twin_text(&v), text_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// #156 review 4 n3: Velo's own lock of `s.md` takes the text of a plain `s.txt` beside it (the watcher skips the
    /// lock's own write, so the lock must scan).
    #[test] fn a_lock_takes_the_text_of_a_txt_twin() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.txt"), BACK).unwrap();
        std::fs::write(dir.join("s.md"), "plain md").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(twin_text(&v).0, 1);
        let to = v.lock_note(&s(&dir.join("s.md")), &id).unwrap();
        v.apply_fs_changes(&[dir.join("s.md"), PathBuf::from(&to)], None);
        v.lock_all();
        assert_eq!((twin_text(&v), text_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// A locked `s`, open in the editor, then unlocked on another device: `s.md` (with front matter) is applied and the
    /// delete of `s.md.age` waits in a later batch. Returns (vault, dir, locked path, editor hash, id, locked bytes).
    fn unlocked_elsewhere() -> (Vault, PathBuf, String, String, String, Vec<u8>) {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let d = v.open_or_create("s", Some(&id), false).unwrap();
        v.save_note(&d.path, "orig", &d.hash, Some(&id), false).unwrap();
        let locked = v.lock_note(&d.path, &id).unwrap();
        let doc = v.open_note(&locked, Some(&id)).unwrap();
        let bytes = std::fs::read(&locked).unwrap();
        std::fs::remove_file(&locked).unwrap();
        std::fs::write(dir.join("s.md"), format!("---\naliases: [backalias]\ntags: [backfmtag]\n---\n{BACK}")).unwrap();
        v.apply_fs_changes(&[dir.join("s.md")], None);
        assert_eq!(twin_text(&v).0, 1); // no locked copy on disk: the text is fine
        (v, dir, locked, doc.hash, id, bytes)
    }
    /// `text_cells`, plus aliases.
    fn all_cells(v: &Vault) -> i64 {
        text_cells(v) + v.index.raw().query_row("SELECT count(*) FROM aliases", [], |r| r.get::<_, i64>(0)).unwrap()
    }
    /// #156 scoped check m1: the sync puts back the same locked bytes, the editor autosaves over them (the file
    /// exists, the row never went), and the watcher skips the restore's event as our own write. A plain `s.txt` too.
    #[test] fn an_autosave_over_a_restored_locked_copy_takes_its_twins_text() {
        let (mut v, dir, locked, hash, id, bytes) = unlocked_elsewhere();
        std::fs::write(dir.join("s.txt"), BACK).unwrap();
        v.apply_fs_changes(&[dir.join("s.txt")], None);
        let age = dir.join("s.md.age");
        std::fs::write(&age, &bytes).unwrap(); // its event waits in a later batch
        v.save_note(&locked, "edited here", &hash, Some(&id), false).unwrap();
        v.apply_fs_changes(&[age], None);
        v.apply_fs_changes(&[], None);
        v.lock_all();
        assert_eq!((twin_text(&v), all_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// #156 scoped check m2: a save that re-creates the locked copy but can't write its row still takes the twin's text.
    #[test] fn a_save_whose_row_write_fails_takes_its_twins_text() {
        let (mut v, dir, locked, hash, id, _) = unlocked_elsewhere();
        let age = dir.join("s.md.age");
        let key = s(&age).replace('\'', "''");
        v.index.raw().execute_batch(&format!("CREATE TEMP TRIGGER f BEFORE INSERT ON notes WHEN NEW.path = '{key}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;")).unwrap();
        assert!(v.save_note(&locked, "edited here", &hash, Some(&id), false).is_err());
        assert!(age.exists());
        assert_eq!((twin_text(&v), all_cells(&v)), ((0, 0, 0, 0), 0));
        v.index.raw().execute_batch("DROP TRIGGER f").unwrap();
        v.apply_fs_changes(&[age], None); // skipped as our own write
        v.lock_all();
        assert_eq!((twin_text(&v), all_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// A save that brings back a locked note whose row went (its delete was applied) scans every row: a twin under
    /// another spelling (`S.md`, on a disk that pairs it with `s.md.age`) is out of reach by name.
    #[test] fn a_save_that_brings_back_a_locked_row_scans_its_twins() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let d = v.open_or_create("s", Some(&id), false).unwrap();
        let locked = v.lock_note(&d.path, &id).unwrap();
        let doc = v.open_note(&locked, Some(&id)).unwrap();
        std::fs::remove_file(&locked).unwrap();
        v.apply_fs_changes(&[PathBuf::from(&locked)], None);
        let other = dir.join("S.md");
        std::fs::write(&other, BACK).unwrap();
        v.apply_fs_changes(std::slice::from_ref(&other), None);
        assert_eq!(twin_text(&v).0, 1);
        v.save_note(&locked, "edited here", &doc.hash, Some(&id), false).unwrap();
        let folds = plain_twin_of_locked(&other);
        assert_eq!(twin_text(&v).0, if folds { 0 } else { 1 }, "the disk pairs S.md with s.md.age: {folds}");
    }
    /// #156 scoped check: Velo locks `s.md` while a stale `s.md.age` row waits for its delete event; a plain `s.txt`
    /// took text meanwhile. A disk that pairs `S.txt` with `s.md.age` gets `S.txt`, out of reach by name: the lock
    /// itself scans.
    #[test] fn a_lock_over_a_stale_locked_row_takes_txt_text() {
        let (mut v, dir, _, _, id, _) = unlocked_elsewhere();
        let folds = dir.join("S.MD").exists();
        let (plain, txt) = (dir.join("s.md"), dir.join(if folds { "S.txt" } else { "s.txt" }));
        std::fs::write(&plain, "plain md").unwrap();
        std::fs::write(&txt, BACK).unwrap();
        v.apply_fs_changes(&[plain.clone(), txt], None);
        assert_eq!(twin_text(&v).0, 1);
        let to = v.lock_note(&s(&plain), &id).unwrap();
        v.apply_fs_changes(&[plain, PathBuf::from(&to)], None);
        v.lock_all();
        assert_eq!((twin_text(&v), all_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// #156 review 4 n3: a folder that can't be listed is not a folder that lists nothing: every changed note keeps
    /// its row.
    #[cfg(unix)]
    #[test] fn a_folder_that_cannot_be_listed_keeps_every_row() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup();
        let paths: Vec<PathBuf> = (0..3).map(|i| dir.join(format!("n{i}.md"))).collect();
        for p in &paths { std::fs::write(p, "one").unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        for p in &paths { std::fs::write(p, BACK).unwrap(); }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o311)).unwrap(); // search, no list
        v.apply_fs_changes(&paths, None);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!((rows(&v).len(), twin_text(&v).0), (3, 3));
    }
    /// #156 review 4 n3: a row the scan must erase (now a twin, its file gone) whose erase fails is erased at the next
    /// change.
    #[test] fn a_failed_erase_of_a_gone_twin_row_is_retried() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let plain = dir.join("s.md");
        std::fs::write(&plain, BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::remove_file(&plain).unwrap(); // its delete event waits in a later batch
        let key = s(&plain).replace('\'', "''");
        v.index.raw().execute_batch(&format!("CREATE TEMP TRIGGER full BEFORE DELETE ON notes WHEN OLD.path = '{key}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;")).unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert_eq!(twin_text(&v).0, 1); // the erase failed
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap();
        v.apply_fs_changes(&[], None);
        assert_eq!((twin_text(&v), text_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// #156 review 3 MJ1, the backstop: a row under an old spelling already in an index (written by an older build)
    /// is erased once the disk rule makes it a twin and its file is gone, with no event for it.
    #[test] fn a_gone_row_that_turns_twin_is_erased() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("meeting.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let ghost = dir.join("Meeting.md");
        let folds = ghost.exists();
        let meta = stat(&dir.join("meeting.md")).unwrap();
        v.index.upsert(&s(&ghost), &parse_note_file(&ghost).unwrap(), &meta, Some(BACK)).unwrap();
        let age = dir.join("meeting.md.age");
        std::fs::write(&age, crypto::encrypt(&id, BACK.as_bytes()).unwrap()).unwrap();
        std::fs::remove_file(dir.join("meeting.md")).unwrap();
        v.apply_fs_changes(&[dir.join("meeting.md"), age.clone()], None);
        // a case-sensitive disk: `Meeting.md` is another, deleted note, not a twin; its own delete event erases it
        let expected = if folds { vec![s(&age)] } else { vec![s(&ghost), s(&age)] };
        assert_eq!(rows(&v), expected);
    }
    /// #156 review 3 m1: saving a locked note again changes no twin, so it runs no twin scan; a plain twin arriving
    /// after its locked copy (separately, or in the same batch) is still indexed without its text.
    #[test] fn saving_a_locked_note_scans_no_twins() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let d = v.open_or_create("s", Some(&id), false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let scans = v.resync_scans;
        let d = v.open_note(&p, Some(&id)).unwrap();
        v.save_note(&p, "edited", &d.hash, Some(&id), false).unwrap();
        v.append_task(&p, "t", Some(&id), false).unwrap();
        v.toggle_task(&p, 1, "- [ ] t", Some(&id), false).unwrap();
        assert_eq!(v.resync_scans, scans);
        for same in [false, true] {
            let (dir, db) = setup();
            let mut v = open(dir.clone(), &db, None).unwrap();
            std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
            if !same {
                v.apply_fs_changes(&[dir.join("s.md.age")], None);
            }
            std::fs::write(dir.join("s.md"), BACK).unwrap();
            v.apply_fs_changes(&if same { vec![dir.join("s.md"), dir.join("s.md.age")] } else { vec![dir.join("s.md")] }, None);
            assert_eq!((twin_text(&v), text_cells(&v)), ((0, 0, 0, 0), 0), "same batch: {same}");
        }
    }
    /// #156 review 3 m2: a locked copy that can't even be stat'ed (a link loop here; EIO on a network volume alike)
    /// still takes its twin's text through the watcher, though its own row can't be written.
    #[cfg(unix)]
    #[test] fn a_locked_copy_that_cannot_be_statted_takes_its_twins_text() {
        let (dir, db) = setup();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::os::unix::fs::symlink(dir.join("s.md.age"), dir.join("s.md.age")).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert_eq!((twin_text(&v), text_cells(&v)), ((0, 0, 0, 0), 0));
    }
    /// #156 review 3 m3: a twin scan that can't read the index is retried at the next change.
    #[test] fn a_twin_scan_that_cannot_read_the_index_is_retried() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("s.md"), BACK).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        // a row whose size isn't an integer makes `known()` fail
        v.index.raw().execute_batch("CREATE TEMP TRIGGER bad AFTER INSERT ON notes WHEN NEW.encrypted = 1 BEGIN
            INSERT INTO notes(path,title,title_folded,mtime,size,encrypted,preview,created,created_src,modified,modified_src) VALUES('zz.md','zz','zz',1,'x',0,'',1,'file',1,'file'); END;").unwrap();
        // a row only the scan fixes (its file is gone, its delete event waits): a twin still on disk loses its text
        // by name, without the scan
        std::fs::remove_file(dir.join("s.md")).unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert!(v.index.known().is_err());
        assert_eq!((twin_text(&v).0, v.retry.clone()), (1, vec![dir.join("s.md.age")]));
        v.index.raw().execute_batch("DROP TRIGGER bad; DELETE FROM notes WHERE path='zz.md';").unwrap();
        std::fs::write(dir.join("other.md"), "o").unwrap();
        v.apply_fs_changes(&[dir.join("other.md")], None);
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
    }
    /// #148: a lock whose erase fails puts back the text of a twin row another process wrote meanwhile (`velo --mcp`
    /// re-indexed the note while the locked copy was on disk; here written before the lock, as it would be).
    #[test] fn a_lock_whose_erase_fails_gives_a_twin_row_its_text_back() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let p = dir.join("s.md");
        std::fs::write(&p, BACK).unwrap();
        let mut m = stat(&p).unwrap();
        m.size = TWIN_SIZE;
        v.index.upsert(&s(&p), &parse_note_file(&p).unwrap(), &m, None).unwrap();
        let once = std::sync::atomic::AtomicBool::new(true);
        v.index.raw().create_scalar_function("fail_once", 0, rusqlite::functions::FunctionFlags::SQLITE_UTF8, move |_| Ok(once.swap(false, std::sync::atomic::Ordering::SeqCst))).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE DELETE ON notes WHEN OLD.path NOT LIKE '%.age' AND fail_once() BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        assert!(v.lock_note(&s(&p), &id).is_err());
        assert!(p.exists() && !dir.join("s.md.age").exists());
        assert_eq!(twin_text(&v), (1, 1, 1, 1));
    }
    /// #147 review m2: the erase fails and the locked copy can't be removed either. The error must name the stray
    /// file (it makes the plain note refuse saves), not only the index error.
    #[cfg(unix)]
    #[test] fn a_failed_lock_that_leaves_its_locked_copy_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, BACK, &d.hash, None, false).unwrap();
        let ro = dir.clone();
        v.index.raw().create_scalar_function("readonly", 0, rusqlite::functions::FunctionFlags::SQLITE_UTF8, move |_| {
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).ok();
            Ok(0)
        }).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE DELETE ON notes WHEN OLD.path NOT LIKE '%.age' BEGIN SELECT readonly(); SELECT RAISE(ABORT, 'disk I/O error'); END;
            CREATE TEMP TRIGGER full_age BEFORE INSERT ON notes WHEN NEW.path LIKE '%.age' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        let r = v.lock_note(&d.path, &id);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = r.unwrap_err().to_string();
        assert!(e.contains("disk I/O error") && e.contains("s.md.age") && e.contains("Trash"), "{e}");
        assert!(Path::new(&d.path).exists()); // nothing lost
        // #148: the stray copy is indexed at once (here that fails too, so the next change retries it, though no watcher
        // event comes: it would be skipped as Velo's own write), and its plain twin loses its text
        v.index.raw().execute_batch("DROP TRIGGER full; DROP TRIGGER full_age").unwrap();
        v.apply_fs_changes(&[], None);
        assert!(v.index.title_modified(&s(&dir.join("s.md.age"))).unwrap().is_some(), "the stray locked copy is not listed");
        assert_eq!(twin_text(&v), (0, 0, 0, 0));
    }
    /// #93 (b): a note locked on another machine whose plain row can't be erased by the watcher is erased by the next
    /// change in the session, not only at the next rescan or launch.
    #[test] fn a_failed_watcher_erase_is_retried_by_the_next_change() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "- [ ] watchzebra", &d.hash, None, false).unwrap();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE DELETE ON notes WHEN OLD.path NOT LIKE '%.age' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        std::fs::remove_file(&d.path).unwrap();
        v.apply_fs_changes(&[dir.join("s.md"), dir.join("s.md.age")], None);
        assert_eq!(v.search("watchzebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1); // the erase failed
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap();
        std::fs::write(dir.join("other.md"), "x").unwrap();
        let changed = v.apply_fs_changes(&[dir.join("other.md")], None);
        assert!(v.search("watchzebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty(), "the plain row is still searchable");
        assert!(v.index.task_rows(&[], true).unwrap().is_empty());
        assert!(changed.contains(&d.path), "the UI is told: {changed:?}");
    }
    /// With front matter off, an atomic save (new inode, new birth time) keeps the indexed created date.
    #[test] fn file_dated_created_survives_saves() {
        let (dir, db) = setup();
        let p = dir.join("n.md");
        std::fs::write(&p, "old").unwrap();
        let jan = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_704_067_200); // 2024-01-01
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(jan).unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let ps = p.to_string_lossy().into_owned();
        let before = v.open_note(&ps, None).unwrap().meta.created;
        assert!(before <= 1_704_067_200_000);
        let SaveResult::Saved { meta, .. } = v.save_note(&ps, "new", &stat_hash(&ps), None, false).unwrap() else { panic!() };
        assert_eq!(meta.created, before);
        assert_eq!(v.index.created_from_file(&ps).unwrap(), Some(before));
        assert_eq!(v.open_note(&ps, None).unwrap().meta.created, before);
    }
    #[test] fn leading_dot_titles_stay_visible_and_indexed() {
        let mut v = open_empty();
        let d = v.open_or_create(".foo", None, false).unwrap();
        assert!(!Path::new(&d.path).file_name().unwrap().to_str().unwrap().starts_with('.'));
        assert_eq!(v.search("", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        let r = v.rename_note(&d.path, ".bar", false).unwrap();
        assert!(!Path::new(&r.path).file_name().unwrap().to_str().unwrap().starts_with('.'));
        assert_eq!(v.search("", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        assert!(v.open_note(&r.path, None).is_ok());
    }
    #[test] fn fs_changes_skip_self_writes() {
        let mut v = open_empty(); let d = v.open_or_create("w", None, false).unwrap();
        v.save_note(&d.path, "x", &d.hash, None, false).unwrap(); assert!(v.apply_fs_changes(&[d.path.clone().into()], None).is_empty());
        std::fs::write(&d.path, "external zebra").unwrap(); assert_eq!(v.apply_fs_changes(&[d.path.clone().into()], None), vec![d.path.clone()]);
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
    }
    #[test] fn fs_changes_remove_only_missing_files() {
        let (dir, db) = setup();
        std::fs::write(dir.join("gone.md"), "zebra").unwrap(); std::fs::write(dir.join("odd.md"), "zebra").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::remove_file(dir.join("gone.md")).unwrap();
        std::fs::remove_file(dir.join("odd.md")).unwrap(); std::fs::create_dir(dir.join("odd.md")).unwrap(); // read fails, not NotFound
        let changed = v.apply_fs_changes(&[dir.join("gone.md"), dir.join("odd.md")], None);
        assert_eq!(changed, vec![dir.join("gone.md").to_string_lossy().into_owned()]);
        let hits = v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits;
        assert_eq!(hits.len(), 1, "only the unreadable note stays listed");
    }
    fn plain_revisions(db: &Path) -> usize {
        let root = db.parent().unwrap().join("revisions");
        let mut n = 0;
        for v in std::fs::read_dir(root).unwrap().flatten() { for k in std::fs::read_dir(v.path()).unwrap().flatten() {
            n += std::fs::read_dir(k.path()).unwrap().flatten().filter(|f| f.path().extension().is_some_and(|x| x == "md")).count();
        } }
        n
    }
    /// "s" is locked on another machine: the watcher sees s.md vanish and s.md.age appear.
    fn lock_elsewhere(identity: Option<&str>) -> (Vault, PathBuf, PathBuf, String) {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, identity.map(|_| id.as_str())).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        std::fs::write(&d.path, "plainsecret").unwrap();
        v.save_note(&d.path, "later zebra", &stat_hash(&d.path), None, false).unwrap(); // plaintext revision of "plainsecret"
        assert_eq!(plain_revisions(&db), 1);
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&id, b"later zebra").unwrap()).unwrap();
        std::fs::remove_file(&d.path).unwrap();
        let ident = identity.map(|_| id.clone());
        v.apply_fs_changes(&[dir.join("s.md"), dir.join("s.md.age")], ident.as_deref());
        (v, dir, db, id)
    }
    #[test] fn note_locked_elsewhere_encrypts_its_revisions_and_unlocks() {
        let (v, dir, db, id) = lock_elsewhere(Some("key"));
        assert_eq!(plain_revisions(&db), 0);
        let locked = dir.join("s.md.age").to_string_lossy().into_owned();
        let r = v.list_revisions(&locked).unwrap();
        assert_eq!(v.read_revision(&locked, &r[0].id, Some(&id)).unwrap(), "plainsecret");
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1, "unlocked in memory");
    }
    #[test] fn note_locked_elsewhere_without_key_drops_plain_revisions() {
        let (v, dir, db, _) = lock_elsewhere(None);
        assert_eq!(plain_revisions(&db), 0);
        assert!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(dir.join("s.md.age").exists());
    }
    #[test] fn rescan_picks_up_changes_the_watcher_missed() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "old").unwrap(); std::fs::write(dir.join("b.md"), "x").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("a.md"), "zebra and more").unwrap(); std::fs::remove_file(dir.join("b.md")).unwrap();
        let mut changed = v.rescan(None); changed.sort();
        assert_eq!(changed, vec![dir.join("a.md").to_string_lossy().into_owned(), dir.join("b.md").to_string_lossy().into_owned()]);
        assert_eq!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        assert!(v.rescan(None).is_empty());
    }
    #[test] fn rename_survives_a_missing_link_source() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap(); std::fs::write(dir.join("b.md"), "and [[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::remove_file(dir.join("a.md")).unwrap(); // deleted by sync, still in the index
        let r = v.rename_note(&dir.join("Old.md").to_string_lossy(), "New", true).unwrap();
        assert_eq!(r.rewritten, 1);
        assert!(!dir.join("Old.md").exists() && dir.join("New.md").exists());
        assert_eq!(std::fs::read_to_string(dir.join("b.md")).unwrap(), "and [[New]]");
    }
    #[test] fn backlink_count_skips_sources_rename_would_skip() {
        let (dir, db) = setup();
        for (f, t) in [("a.md", "see [[Old]]"), ("gone.md", "[[Old]]"), ("X.md", "pre-lock [[Old]]"), ("Old.md", "")] { std::fs::write(dir.join(f), t).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("X.md.age"), "ciphertext").unwrap(); // X.md is now a locked note's plain twin
        std::fs::remove_file(dir.join("gone.md")).unwrap(); // deleted, still indexed
        assert_eq!(v.backlink_count("Old").unwrap(), 1);
        assert_eq!(v.rename_note(&dir.join("Old.md").to_string_lossy(), "New", true).unwrap().rewritten, 1);
    }
    #[test] fn rename_count_stays_title_only() {
        let (dir, db) = setup();
        for (f, t) in [("Nick.md", "---\naliases: [Nicholas]\n---\n"), ("a.md", "[[Nicholas]]"), ("b.md", "[[Nick]]")] { std::fs::write(dir.join(f), t).unwrap(); }
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(v.backlink_count("Nick").unwrap(), 1);
        assert_eq!(v.index.linked_from(&dir.join("Nick.md").to_string_lossy()).unwrap().len(), 2);
    }
    #[test] fn rename_rewrites_links_to_the_saved_title() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let r = v.rename_note(&dir.join("Old.md").to_string_lossy(), "A/B", true).unwrap();
        assert!(r.path.ends_with("A-B.md"), "{}", r.path);
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "see [[A-B]]");
    }
    #[test] fn commands_refuse_paths_outside_the_notes_folder() {
        let mut v = open_empty();
        let outside = tempfile::tempdir().unwrap().keep().join("other.md");
        std::fs::write(&outside, "private").unwrap();
        let o = outside.to_string_lossy().into_owned();
        assert!(v.open_note(&o, None).is_err());
        assert!(v.save_note(&o, "overwritten", &stat_hash(&o), None, false).is_err());
        assert!(v.rename_note(&o, "x", false).is_err());
        assert!(v.snapshot_text(&o, "x", None).is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "private");
    }
    #[test] fn delete_moves_file_out_and_drops_it_from_index() {
        let mut v = open_empty(); let d = v.open_or_create("doomed", None, false).unwrap();
        v.save_note(&d.path, "zebra", &d.hash, None, false).unwrap();
        v.delete_note_with(&d.path, |p| std::fs::remove_file(p)).unwrap();
        assert!(!Path::new(&d.path).exists());
        assert!(v.search("zebra", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(v.titles().unwrap().is_empty());
    }
    #[test] fn delete_refuses_paths_outside_the_notes_folder() {
        let mut v = open_empty();
        let outside = tempfile::tempdir().unwrap().keep().join("x.md"); std::fs::write(&outside, "keep").unwrap();
        assert!(v.delete_note_with(&s(&outside), |p| std::fs::remove_file(p)).is_err());
        assert!(outside.exists());
    }
    fn fm_of(r: SaveResult) -> (Option<String>, String) { match r { SaveResult::Saved { front_matter, hash, .. } => (front_matter, hash), _ => panic!("conflict") } }
    #[test] fn save_stamps_plain_note() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let (fm, _) = fm_of(v.save_note(&d.path, "hello", &d.hash, None, true).unwrap());
        let fm = fm.unwrap(); assert!(fm.starts_with("---\ncreated: ") && fm.ends_with("---\n"));
        let disk = std::fs::read_to_string(&d.path).unwrap(); assert!(disk.starts_with(&fm) && disk.ends_with("hello"));
        // created = earliest file time before the write
        let md = std::fs::metadata(&d.path).unwrap(); let _ = md;
        let c = frontmatter::parse(&disk).unwrap().created.unwrap();
        assert!((c.timestamp() - chrono::Local::now().timestamp()).abs() < 5);
    }
    #[test] fn created_comes_from_file_time() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let m = stat(Path::new(&d.path)).unwrap(); let want = effective_dates(None, &m).0 / 1000;
        v.save_note(&d.path, "x", &d.hash, None, true).unwrap();
        assert_eq!(frontmatter::parse(&std::fs::read_to_string(&d.path).unwrap()).unwrap().created.unwrap().timestamp(), want);
    }
    #[test] fn save_setting_off_writes_as_is() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let (fm, _) = fm_of(v.save_note(&d.path, "hello", &d.hash, None, false).unwrap());
        assert!(fm.is_none()); assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "hello");
    }
    #[test] fn current_block_same_second_is_unchanged() {
        // save_note reports front_matter only when stamp() changed the text; same `now` must be a no-op
        let now = chrono::Local::now().fixed_offset();
        let t = frontmatter::stamp("body", now, now);
        assert_eq!(frontmatter::stamp(&t, now, now), t);
    }

    fn note_with(v: &mut Vault, title: &str, text: &str) -> String {
        let d = v.open_or_create(title, None, false).unwrap();
        std::fs::write(&d.path, text).unwrap();
        d.path
    }
    #[test] fn toggle_task_flips_and_dates() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "- [ ] a\n");
        v.toggle_task(&p, 0, "- [ ] a", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), format!("- [x] a @done({})\n", local_today()));
    }
    #[test] fn toggle_task_reports_line_after_stamping() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "x\n- [ ] a\n");
        let t = v.toggle_task(&p, 1, "- [ ] a", None, true).unwrap();
        let saved = std::fs::read_to_string(&p).unwrap();
        assert!(saved.starts_with("---\n"), "stamped front matter: {saved}");
        assert!(t.line > 1);
        assert_eq!(saved.split('\n').nth(t.line).unwrap(), t.line_text);
        assert_eq!(t.line_text, format!("- [x] a @done({})", local_today()));
        let back = v.toggle_task(&p, t.line, &t.line_text, None, true).unwrap();
        assert_eq!((back.line, back.line_text.as_str()), (t.line, "- [ ] a"));
        assert_eq!(back.hash, hash(&std::fs::read(&p).unwrap()));
        assert!(std::fs::read_to_string(&p).unwrap().ends_with("x\n- [ ] a\n"));
    }
    #[test] fn toggle_task_refuses_moved_line() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "- [ ] a\n");
        let e = v.toggle_task(&p, 0, "- [ ] b", None, false).unwrap_err();
        assert_eq!(e.to_string(), "task-moved");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "- [ ] a\n");
    }
    #[test] fn toggle_task_keeps_crlf() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "x\r\n- [ ] a\r\n");
        v.toggle_task(&p, 1, "- [ ] a", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), format!("x\r\n- [x] a @done({})\r\n", local_today()));
    }
    #[test] fn toggle_task_in_code_fence_refused() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "```\n- [ ] a\n```\n");
        assert_eq!(v.toggle_task(&p, 1, "- [ ] a", None, false).unwrap_err().to_string(), "task-moved");
    }
    #[test] fn capture_appends_and_creates() {
        let mut v = open_empty();
        let p = v.capture_task("Inbox", "buy milk", None, false).unwrap();
        assert!(p.ends_with("Inbox.md"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "- [ ] buy milk\n");
        v.capture_task("Inbox", "two", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "- [ ] buy milk\n- [ ] two\n");
        std::fs::write(&p, "no newline").unwrap();
        v.capture_task("Inbox", "three", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "no newline\n- [ ] three\n");
    }
    #[test] fn capture_target_resolves_an_alias_like_capture() {
        let mut v = open_empty();
        let p = note_with(&mut v, "Todo", "---\naliases: [Inbox]\n---\n");
        v.reindex(Path::new(&p), Some("---\naliases: [Inbox]\n---\n")).unwrap();
        assert_eq!(v.find_note("inbox").unwrap().as_deref(), Some(p.as_str()));
        assert_eq!(v.capture_task("Inbox", "x", None, false).unwrap(), p);
        assert_eq!(v.find_note("Nope").unwrap(), None);
    }
    #[test] fn capture_to_locked_without_key_fails_locked() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir, &db, None).unwrap(); let d = v.open_or_create("Inbox", None, false).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        assert_eq!(v.capture_task("Inbox", "x", None, false).unwrap_err().to_string(), "locked");
    }
    fn stat_hash(p: &str) -> String { hash(&std::fs::read(p).unwrap()) }
    #[test] fn toggle_and_capture_conflict_on_stale_hash() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "- [ ] a\n");
        let stale = |v: &mut Vault| { let mut d = v.open_note(&p, None).unwrap(); d.hash = "stale".into(); d };
        let d = stale(&mut v);
        assert_eq!(v.toggle_in(d, 0, "- [ ] a", None, false).unwrap_err().to_string(), "task-moved");
        let d = stale(&mut v);
        assert_eq!(v.append_in(d, "x", None, false).unwrap_err().to_string(), "conflict");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "- [ ] a\n");
    }
    #[test] fn capture_trims_flattens_and_keeps_crlf() {
        let mut v = open_empty();
        assert_eq!(v.capture_task("Inbox", " \n ", None, false).unwrap_err().to_string(), "empty");
        let p = v.capture_task("Inbox", "  a\r\nb\nc ", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "- [ ] a  b c\n");
        std::fs::write(&p, "x\r\ny").unwrap();
        v.capture_task("Inbox", "z", None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "x\r\ny\r\n- [ ] z\r\n");
    }
    #[test] fn toggle_locked_note_needs_key_and_stays_ciphertext() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir, &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let h = stat_hash(&p);
        v.save_note(&p, "- [ ] secret\n", &h, Some(&id), false).unwrap();
        assert_eq!(v.toggle_task(&p, 0, "- [ ] secret", None, false).unwrap_err().to_string(), "locked");
        v.toggle_task(&p, 0, "- [ ] secret", Some(&id), false).unwrap();
        let raw = std::fs::read(&p).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret"));
        let plain = String::from_utf8(crypto::decrypt(&id, &raw).unwrap()).unwrap();
        assert_eq!(plain, format!("- [x] secret @done({})\n", local_today()));
    }
    #[test] fn locked_note_encrypts_stamped_text() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir, &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let h = stat_hash(&p);
        v.save_note(&p, "secret", &h, Some(&id), true).unwrap();
        let plain = String::from_utf8(crypto::decrypt(&id, &std::fs::read(&p).unwrap()).unwrap()).unwrap();
        assert!(plain.starts_with("---\ncreated: ") && plain.ends_with("secret"));
    }
    #[test] fn new_note_gets_block() {
        let mut v = open_empty();
        let d = v.open_or_create("a", None, true).unwrap(); assert!(d.text.starts_with("---\ncreated: ") && d.text.ends_with("---\n"));
        assert_eq!(d.meta.created_src, "frontmatter");
        assert_eq!(v.open_or_create("b", None, false).unwrap().text, "");
    }
    #[test] fn second_save_with_returned_hash_is_saved() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        let (_, mut cur) = fm_of(v.save_note(&d.path, "one", &d.hash, None, true).unwrap());
        for t in ["one", "onex"] {
            let SaveResult::Saved { hash, .. } = v.save_note(&d.path, t, &cur, None, true).unwrap() else { panic!("conflict") };
            assert_eq!(hash, stat_hash(&d.path));
            cur = hash;
        }
    }
    #[test] fn second_save_locked_is_saved() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir, &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let (_, h) = fm_of(v.save_note(&p, "secret", &stat_hash(&p), Some(&id), true).unwrap());
        assert!(matches!(v.save_note(&p, "secretx", &h, Some(&id), true).unwrap(), SaveResult::Saved { .. }));
    }
    #[test] fn stamped_conflict_copy_keeps_both_sides() {
        let mut v = open_empty(); let d = v.open_or_create("n", None, false).unwrap();
        std::fs::write(&d.path, "external").unwrap();
        let r = v.save_note(&d.path, "mine", &d.hash, None, true).unwrap();
        let SaveResult::Conflict { conflict_path, .. } = r else { panic!("expected conflict") };
        assert_eq!(std::fs::read_to_string(&d.path).unwrap(), "external");
        let c = std::fs::read_to_string(&conflict_path).unwrap();
        let f = frontmatter::parse(&c).unwrap();
        assert!(f.created.is_some() && f.modified.is_some() && c.ends_with("mine"), "{c:?}");
    }
    #[test] fn first_save_of_existing_note_snapshots_previous_content() {
        let (dir, db) = setup();
        std::fs::write(dir.join("e.md"), "before velo").unwrap();
        std::fs::write(dir.join("c.md"), "external").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let p = s(&dir.join("e.md"));
        v.save_note(&p, "edited", &stat_hash(&p), None, true).unwrap();
        let r = v.list_revisions(&p).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(v.read_revision(&p, &r[0].id, None).unwrap(), "before velo");
        // a conflict replaces nothing on disk: no snapshot
        let c = s(&dir.join("c.md"));
        assert!(matches!(v.save_note(&c, "mine", "stale", None, true).unwrap(), SaveResult::Conflict { .. }));
        assert!(v.list_revisions(&c).unwrap().is_empty());
        // a new (empty) note has nothing to keep
        let d = v.open_or_create("n", None, false).unwrap();
        v.save_note(&d.path, "new note", &d.hash, None, false).unwrap();
        assert!(v.list_revisions(&d.path).unwrap().is_empty());
    }
    #[test] fn locked_note_pre_write_snapshot_is_ciphertext() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir, &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        std::fs::write(&d.path, "oldsecret").unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let disk = std::fs::read(&p).unwrap();
        v.save_note(&p, "newsecret", &hash(&disk), Some(&id), true).unwrap();
        let r = v.list_revisions(&p).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].id.ends_with(".md.age"));
        let (raw, enc) = v.revisions.read("s", &r[0].id).unwrap();
        assert!(enc && raw == disk, "snapshot must be the exact pre-write ciphertext");
        assert_eq!(v.read_revision(&p, &r[0].id, Some(&id)).unwrap(), "oldsecret");
    }
    #[test] fn lock_reencrypts_snapshots_and_snapshot_text_encrypts() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        std::fs::write(&d.path, "plainsecret").unwrap();
        v.save_note(&d.path, "later", &stat_hash(&d.path), None, false).unwrap(); // snapshots the pre-write "plainsecret"
        let root = db.parent().unwrap().join("revisions");
        let files = |root: &Path| -> Vec<String> {
            let mut out = vec![];
            for k in std::fs::read_dir(root).unwrap().flatten() { for f in std::fs::read_dir(k.path()).unwrap().flatten() { out.push(f.file_name().to_string_lossy().into_owned()); } }
            out
        };
        let vdir = std::fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
        assert!(files(&vdir).iter().all(|f| f.ends_with(".md")));
        let locked = v.lock_note(&d.path, &id).unwrap();
        assert!(files(&vdir).iter().all(|f| f.ends_with(".md.age")));
        let r = v.list_revisions(&locked).unwrap();
        assert_eq!(v.read_revision(&locked, &r[0].id, Some(&id)).unwrap(), "plainsecret");
        assert_eq!(v.read_revision(&locked, &r[0].id, None).err().unwrap().to_string(), "locked");
        v.snapshot_text(&locked, "newer", Some(&id)).unwrap();
        v.snapshot_text(&locked, "newer", Some(&id)).unwrap(); // identical: skipped
        assert_eq!(v.list_revisions(&locked).unwrap().len(), 2);
        assert!(files(&vdir).iter().all(|f| f.ends_with(".md.age")));
        assert_eq!(v.snapshot_text(&locked, "x", None).err().unwrap().to_string(), "locked");
    }
    #[test] fn snapshot_text_stale_plain_path_of_locked_note_never_plain() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        let vdir = || std::fs::read_dir(db.parent().unwrap().join("revisions")).ok().and_then(|mut r| r.next()).map(|e| e.unwrap().path());
        let names = || vdir().map(|d| std::fs::read_dir(d).unwrap().flatten().flat_map(|k| std::fs::read_dir(k.path()).unwrap().flatten().map(|f| f.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>()).collect::<Vec<_>>()).unwrap_or_default();
        assert_eq!(v.snapshot_text(&d.path, "stalesecret", None).err().unwrap().to_string(), "locked");
        assert!(names().is_empty());
        v.snapshot_text(&d.path, "stalesecret", Some(&id)).unwrap();
        assert_eq!(names().len(), 1);
        assert!(names().iter().all(|f| f.ends_with(".md.age")));
    }

    /// Two or more distinct 3-byte FTS trigrams of `words` in the index files (the vault may still be open). One alone
    /// can be chance: in A-r3, 5 of 2500 runs matched one trigram in a timestamp's low bytes plus a rowid byte, a WAL
    /// frame checksum or the WAL salt. A real leak leaves several (each word's trigrams with distinct first letters
    /// are stored whole). Temp paths and WAL headers are blanked: the random temp dir name holds trigrams too
    /// (".tmplmQvNQ" has "plm"; it failed CI on Windows).
    fn trigram_on_disk(db: &Path, words: &[&str]) -> bool {
        let mut seen: Vec<String> = trigram_hits(db, words).into_iter().map(|h| h.2).collect();
        seen.sort();
        seen.dedup();
        seen.len() >= 2
    }
    /// Every hit as (file, offset, trigram, context), for failure messages.
    fn trigram_hits(db: &Path, words: &[&str]) -> Vec<(&'static str, usize, String, String)> {
        let tmp = s(&std::env::temp_dir());
        let p = tmp.as_bytes();
        let mut hits = vec![];
        for x in ["", "-wal", "-shm"] {
            let Ok(mut b) = std::fs::read(format!("{}{x}", db.display())) else { continue };
            // blank the temp prefix and the random dir name that follows it
            let mut i = 0;
            while let Some(k) = b[i..].windows(p.len()).position(|w| w == p) {
                let end = (i + k + p.len() + 12).min(b.len());
                b[i + k..end].fill(0);
                i = end;
            }
            if x == "-wal" && b.len() >= 32 {
                // the WAL header and each frame header: salts and checksums, random bytes
                let frame = 24 + u32::from_be_bytes(b[8..12].try_into().unwrap()) as usize;
                b[..32].fill(0);
                let n = b.len();
                (32..n).step_by(frame).for_each(|k| b[k..(k + 24).min(n)].fill(0));
            }
            for g in words.iter().flat_map(|w| w.as_bytes().windows(3)) {
                for (k, _) in b.windows(3).enumerate().filter(|(_, w)| w == &g) {
                    hits.push((x, k, String::from_utf8_lossy(g).into_owned(), format!("{:?}", String::from_utf8_lossy(&b[k.saturating_sub(16)..(k + 19).min(b.len())]))));
                }
            }
        }
        hits
    }
    // Letters absent from the other strings the index holds ("filler", "version", "lorem ipsum dolor", paths), so a
    // trigram can't be faked by two integer bytes followed by one of them.
    const OLD: [&str; 3] = ["qxzjkwbhzqjx", "jzwqhkxbjwzq", "kbzxqjhwkzxb"];
    /// A vault mid-bulk re-index (FTS secure-delete off): note s saved in three versions with filler chunks re-indexed
    /// between them, so s's old versions sit in the FTS segments.
    fn mid_bulk() -> (Vault, PathBuf, PathBuf, String) {
        let (dir, db) = setup();
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        v.index.begin_bulk().unwrap();
        for (k, w) in OLD.iter().enumerate() {
            v.save_note(&d.path, &format!("version {k} {w}"), &stat_hash(&d.path), None, false).unwrap();
            more_fillers(&mut v, &dir, k);
        }
        assert!(trigram_on_disk(&db, &OLD[..2]), "old versions linger mid-bulk: the test would prove nothing");
        (v, dir, db, d.path)
    }
    /// A bulk chunk: 50 fillers re-indexed.
    fn more_fillers(v: &mut Vault, dir: &Path, k: usize) {
        let fillers: Vec<PathBuf> = (k * 50..k * 50 + 50).map(|i| dir.join(format!("filler {}.md", i % 300))).collect();
        for f in &fillers { std::fs::write(f, format!("edited {k} lorem")).unwrap(); }
        v.apply_fs_changes(&fillers, None);
    }
    fn synced_lock(v: &mut Vault, dir: &Path, p: &str) {
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(p).unwrap();
        v.apply_fs_changes(&[PathBuf::from(p), dir.join("s.md.age")], None);
    }
    /// The app's rescan: a bulk re-index in chunks of 100.
    fn bulk_rescan(v: &mut Vault) {
        let (paths, replaced) = v.stale_paths().unwrap();
        assert!(replaced >= BULK);
        v.index.begin_bulk().unwrap();
        for c in paths.chunks(100) { v.apply_fs_changes(c, None); }
        v.index.end_bulk().unwrap();
    }
    fn secure_delete(v: &Vault) -> i64 {
        v.index.raw().query_row("SELECT v FROM notes_fts_config WHERE k='secure-delete'", [], |r| r.get(0)).unwrap()
    }
    fn config(v: &Vault, k: &str) -> i64 {
        v.index.raw().query_row("SELECT v FROM notes_fts_config WHERE k=?1", [k], |r| r.get(0)).unwrap()
    }
    #[test] fn crash_mid_bulk_is_erased_at_the_next_open() {
        let (v, dir, db, _) = mid_bulk();
        std::mem::forget(v); // a crash: no drop, secure-delete stays off
        assert!(trigram_on_disk(&db, &OLD[..2]), "control");
        let v = open(dir, &db, None).unwrap();
        assert!(!trigram_on_disk(&db, &OLD[..2]));
        assert_eq!((secure_delete(&v), config(&v, "automerge"), config(&v, "crisismerge")), (1, 4, 16));
    }
    #[test] fn lock_after_a_bulk_leaves_no_plaintext() {
        let (mut v, _dir, db, p) = mid_bulk();
        v.index.end_bulk().unwrap();
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD), "while open");
        drop(v);
        assert!(!trigram_on_disk(&db, &OLD), "after close");
    }
    /// A lock mid-bulk ends the bulk at once: the rest of the bulk runs slow, but no plaintext waits for its end.
    #[test] fn lock_during_a_bulk_erases_at_once() {
        for case in ["lock", "locked elsewhere"] {
            let (mut v, dir, db, p) = mid_bulk();
            if case == "lock" { v.lock_note(&p, &crypto::new_identity()).unwrap(); } else { synced_lock(&mut v, &dir, &p); }
            assert!(!trigram_on_disk(&db, &OLD), "{case}, while open");
            std::mem::forget(v); // then a crash
            assert!(!trigram_on_disk(&db, &OLD), "{case}, after a crash");
        }
    }
    /// Notes changed while velo was closed (a sync that also locked s elsewhere): open re-indexes them as a bulk.
    #[test] fn reconcile_of_many_changes_is_a_bulk_that_leaves_no_plaintext() {
        let (dir, db) = setup();
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        std::fs::write(dir.join("s.md"), format!("version 0 {}", OLD[0])).unwrap();
        drop(open(dir.clone(), &db, None).unwrap());
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("edited {i} lorem")).unwrap(); }
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(dir.join("s.md")).unwrap();
        let v = open(dir, &db, None).unwrap();
        assert_eq!(secure_delete(&v), 1);
        assert!(!trigram_on_disk(&db, &OLD[..1]));
    }
    /// The lock's own text is erased in the delete itself, even when the rebuild for older versions fails.
    #[test] fn lock_mid_bulk_erases_its_text_even_if_the_finish_fails() {
        for case in ["lock", "locked elsewhere"] {
            let (mut v, dir, db, p) = mid_bulk();
            v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE DELETE ON notes_fts_data BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;").unwrap();
            if case == "lock" { v.lock_note(&p, &crypto::new_identity()).unwrap(); } else { synced_lock(&mut v, &dir, &p); }
            v.index.checkpoint().unwrap();
            assert_eq!(secure_delete(&v), 0, "{case}: the rebuild failed, still pending");
            assert!(!trigram_on_disk(&db, &OLD[2..]), "{case}");
        }
    }
    /// A full disk fails the closing rebuild: secure-delete stays off, and the next lock (space freed) erases.
    #[test] fn failed_end_of_bulk_is_redone_by_the_next_lock() {
        let (mut v, _dir, db, p) = mid_bulk();
        v.index.raw().execute_batch("CREATE TEMP TRIGGER full BEFORE INSERT ON notes_fts_data BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;").unwrap();
        assert!(v.index.end_bulk().is_err());
        assert_eq!(secure_delete(&v), 0);
        v.index.raw().execute_batch("DROP TRIGGER full").unwrap(); // the user frees space
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD));
    }
    /// After an interrupted bulk, a rebuild that fails at open (here a trigger; a real full disk is
    /// `real_full_disk_open_after_crash`) still opens the vault; a later open erases.
    #[test] fn failed_finish_at_open_still_opens() {
        let (v, dir, db, p) = mid_bulk();
        std::mem::forget(v);
        // persistent, not TEMP: open's own connection must see it. (After a RAISE from a persistent trigger, a secure
        // delete on that connection overflowed the stack in SQLite; a real SQLITE_FULL does not, see the RAM-disk tests.)
        let raw = rusqlite::Connection::open(&db).unwrap();
        raw.execute_batch("CREATE TRIGGER full BEFORE INSERT ON notes_fts_data BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;").unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(secure_delete(&v), 0);
        assert_eq!(v.search("version", Sort::Title, 0, &[]).unwrap().hits.len(), 1, "the index wasn't dropped");
        drop(v);
        raw.execute_batch("DROP TRIGGER full").unwrap();
        let mut v = open(dir, &db, None).unwrap();
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD));
    }
    /// A plain note deleted while a leftover bulk (a killed `velo --mcp`) keeps secure-delete off, its locked twin
    /// synced in a batch later (iCloud applies deletes first): the twin's arrival finishes the bulk.
    #[test] fn synced_lock_delete_first_after_a_killed_bulk() {
        let (dir, db) = setup();
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        let mut app = open(dir.clone(), &db, None).unwrap();
        let t = app.open_or_create("t", None, false).unwrap();
        app.save_note(&t.path, &format!("t {}", OLD[0]), &stat_hash(&t.path), None, false).unwrap();
        let mut mcp = open(dir.clone(), &db, None).unwrap();
        mcp.index.begin_bulk().unwrap();
        more_fillers(&mut mcp, &dir, 0);
        std::mem::forget(mcp);
        std::fs::remove_file(&t.path).unwrap();
        app.apply_fs_changes(&[PathBuf::from(&t.path)], None);
        std::fs::write(dir.join("t.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        app.apply_fs_changes(&[dir.join("t.md.age")], None);
        app.index.checkpoint().unwrap();
        assert!(!trigram_on_disk(&db, &OLD[..1]));
    }
    /// Notes locked elsewhere in a rescan: their `.md.age` come in earlier chunks, which don't end the bulk (a rebuild
    /// each, ~1 s at 10k); the `.md` deletes come last together, and only the first of them ends it.
    #[test] fn notes_locked_elsewhere_in_a_rescan_end_the_bulk_once() {
        let (dir, db) = setup();
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        let plain: Vec<PathBuf> = (0..3).map(|k| dir.join(format!("x{k}.md"))).collect();
        for (p, w) in plain.iter().zip(OLD) { std::fs::write(p, format!("x {w}")).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.index.begin_bulk().unwrap();
        let id = crypto::new_identity();
        for p in &plain {
            let age = PathBuf::from(format!("{}.age", p.display()));
            std::fs::write(&age, crypto::encrypt(&id, b"x").unwrap()).unwrap();
            std::fs::remove_file(p).unwrap();
            v.apply_bulk_chunk(&[age], None);
            assert_eq!(secure_delete(&v), 0, "an .md.age chunk ended the bulk");
        }
        v.apply_bulk_chunk(&plain, None);
        assert_eq!(secure_delete(&v), 1, "the first delete ended the bulk");
        v.index.finish_bulk();
        v.index.checkpoint().unwrap();
        assert!(!trigram_on_disk(&db, &OLD), "{:?}", trigram_hits(&db, &OLD));
    }
    /// A lock mid-bulk ends the bulk (its rebuild erases older versions); the next chunk starts it again, so the rest
    /// of the rescan doesn't run with secure deletes (seconds per chunk).
    #[test] fn bulk_chunks_restart_the_bulk_after_a_lock() {
        let (mut v, dir, db, p) = mid_bulk();
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        assert_eq!(secure_delete(&v), 1);
        let fillers: Vec<PathBuf> = (0..50).map(|i| dir.join(format!("filler {i}.md"))).collect();
        for f in &fillers { std::fs::write(f, "edited again").unwrap(); }
        v.apply_bulk_chunk(&fillers, None);
        assert_eq!(secure_delete(&v), 0);
        v.index.finish_bulk();
        assert!(!trigram_on_disk(&db, &OLD));
    }
    /// `velo --mcp` direct mode killed mid-bulk: the app's next lock finishes it.
    #[test] fn second_process_killed_mid_bulk_then_a_lock() {
        let (dir, db) = setup();
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        let mut app = open(dir.clone(), &db, None).unwrap();
        let mut mcp = open(dir.clone(), &db, None).unwrap();
        mcp.index.begin_bulk().unwrap();
        more_fillers(&mut mcp, &dir, 0);
        std::mem::forget(mcp);
        let t = app.open_or_create("t", None, false).unwrap();
        for w in OLD { app.save_note(&t.path, &format!("t {w}"), &stat_hash(&t.path), None, false).unwrap(); }
        assert!(trigram_on_disk(&db, &OLD), "control");
        app.lock_note(&t.path, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD), "{:?}", trigram_hits(&db, &OLD));
    }
    /// A bulk cut short without a crash (vault switch, Quit): the dropped index ends it.
    #[test] fn dropping_the_vault_mid_bulk_ends_the_bulk() {
        let (v, _dir, db, _) = mid_bulk();
        drop(v);
        assert!(!trigram_on_disk(&db, &OLD[..2]));
    }
    #[test] fn second_index_opened_mid_bulk() {
        let (mut v, dir, db, p) = mid_bulk();
        let rowid = |v: &Vault| v.index.raw().query_row("SELECT max(rowid) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap();
        let before = rowid(&v);
        let mut b = open(dir.clone(), &db, None).unwrap(); // `velo --mcp` direct mode: its open ends the bulk early
        assert_eq!(rowid(&b), before, "finished the bulk, not a cold build under the app");
        b.lock_note(&p, &crypto::new_identity()).unwrap();
        more_fillers(&mut v, &dir, 3); // the bulk goes on
        v.index.end_bulk().unwrap();
        drop(b);
        assert!(!trigram_on_disk(&db, &OLD), "{:?}", trigram_hits(&db, &OLD));
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").unwrap();
        let cold = open(dir.clone(), &tempfile::tempdir().unwrap().keep().join("cold.sqlite"), None).unwrap();
        assert_eq!(dump(&v), dump(&cold));
    }
    fn dump(v: &Vault) -> Vec<String> {
        let mut out = vec![];
        for q in ["SELECT path,title,mtime,size,encrypted,preview,created,modified FROM notes ORDER BY path",
                  "SELECT src,dst_folded FROM links ORDER BY 1,2", "SELECT path,tag_folded,tag_display FROM tags ORDER BY 1,2,3",
                  "SELECT path,alias_folded FROM aliases ORDER BY 1,2", "SELECT path,line,text,done,due FROM tasks ORDER BY 1,2",
                  "SELECT n.path, f.body FROM notes_fts f JOIN notes n ON n.rowid=f.rowid ORDER BY 1"] {
            let mut st = v.index.raw().prepare(q).unwrap();
            let n = st.column_count();
            out.extend(st.query_map([], |r| Ok((0..n).map(|k| format!("{:?}", r.get_ref(k).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(Result::unwrap));
        }
        for w in ["alpha", "beta", "gam", "task", "zz", "edited", "s"] {
            out.push(format!("{w}: {:?}", v.search(w, Sort::Title, 0, &[]).unwrap().hits.iter().map(|h| h.path.clone()).collect::<Vec<_>>()));
        }
        out
    }
    #[test] fn bulk_reindex_matches_a_cold_build() {
        let (dir, db) = setup();
        for i in 0..250 { std::fs::write(dir.join(format!("n{i}.md")), format!("---\naliases: [al{i}]\ntags: [t{}]\n---\n# n{i}\nalpha beta {i} #tag{} [[n{}]]\n- [ ] task {i} due:2026-01-0{}\n", i%7, i%5, (i+1)%250, i%9+1)).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        for i in 0..250 { std::fs::write(dir.join(format!("n{i}.md")), format!("---\ntags: [u{}]\n---\ngamma {i} #tg{} [[n{}]] zz\n- [x] task done {i}\n", i%3, i%4, (i+2)%250)).unwrap(); }
        for i in 240..250 { std::fs::remove_file(dir.join(format!("n{i}.md"))).unwrap(); }
        bulk_rescan(&mut v);
        assert_eq!(secure_delete(&v), 1);
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").unwrap();
        let cold = open(dir.clone(), &tempfile::tempdir().unwrap().keep().join("cold.sqlite"), None).unwrap();
        assert_eq!(dump(&v), dump(&cold));
    }
    /// 0.8.2 sets FTS secure-delete on at every open and never rebuilds: an index it wrote opens here as on main
    /// (secure-delete on, so a lock erases at once), and one we left mid-bulk stays consistent there and back here.
    /// An index 0.8.2 wrote (FTS secure-delete on, never a bulk) opens here as on main: no rebuild, a lock erases at once.
    #[test] fn index_written_by_0_8_2_opens_as_on_main() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let t = v.open_or_create("t", None, false).unwrap();
        for w in OLD { v.save_note(&t.path, &format!("t {w}"), &stat_hash(&t.path), None, false).unwrap(); }
        drop(v);
        rusqlite::Connection::open(&db).unwrap().execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1);").unwrap();
        let mut v = open(dir, &db, None).unwrap();
        assert_eq!(secure_delete(&v), 1);
        v.lock_note(&t.path, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD));
    }
    #[test] fn open_leaves_no_wal_behind() {
        let (dir, db) = setup();
        for i in 0..50 { std::fs::write(dir.join(format!("n{i}.md")), "some text").unwrap(); }
        let _v = open(dir, &db, None).unwrap();
        assert_eq!(std::fs::metadata(format!("{}-wal", db.display())).unwrap().len(), 0);
    }
    /// Lets `pages` more pages into the index, so a big note fails with SQLITE_FULL (aborting the batch).
    fn nearly_full(v: &Vault, pages: i64) {
        let n: i64 = v.index.raw().query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        v.index.raw().query_row(&format!("PRAGMA max_page_count={}", n + pages), [], |_| Ok(())).unwrap();
    }
    fn huge() -> String { (0..200_000).map(|i| format!("w{i} ")).collect() }
    #[test] fn disk_full_mid_batch_reports_only_indexed_notes() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let ps: Vec<PathBuf> = ["a", "b", "c"].iter().map(|t| dir.join(format!("{t}.md"))).collect();
        for (p, body) in ps.iter().zip(["alpha", &huge(), "gamma"]) { std::fs::write(p, body).unwrap(); }
        nearly_full(&v, 3);
        let changed = v.apply_fs_changes(&ps, None);
        nearly_full(&v, 1_000_000);
        let indexed: Vec<String> = changed.iter().filter(|p| v.index.title_modified(p).unwrap().is_some()).cloned().collect();
        assert_eq!(changed, indexed);
        assert_eq!(changed.len(), 2, "a and c fit");
    }
    #[test] fn disk_full_in_link_rewrite_still_reindexes_rewritten_notes() {
        let (dir, db) = setup();
        std::fs::write(dir.join("Old.md"), "").unwrap();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("b.md"), format!("[[Old]] {}", huge())).unwrap(); // after a in the links table
        v.apply_fs_changes(&[dir.join("b.md")], None);
        nearly_full(&v, 6);
        let r = v.rename_note(&dir.join("Old.md").to_string_lossy(), "New", true).unwrap();
        nearly_full(&v, 1_000_000);
        assert_eq!(r.rewritten, 2);
        assert!(v.index.backlinks("New").unwrap().contains(&dir.join("a.md").to_string_lossy().into_owned()));
    }

    /// Real full-disk tests: `A2_DISK=<a small RAM disk> cargo test --lib real_full_disk -- --ignored`
    /// (`diskutil erasevolume HFS+ velo-ram $(hdiutil attach -nomount ram://1048576)`).
    fn ram_root(name: &str) -> PathBuf {
        let disk = PathBuf::from(std::env::var("A2_DISK").expect("A2_DISK"));
        for e in std::fs::read_dir(&disk).unwrap().flatten() { if e.file_name().to_string_lossy().starts_with("velo-") { let _ = std::fs::remove_dir_all(e.path()); } }
        let r = disk.join(format!("velo-{name}"));
        std::fs::create_dir_all(r.join("notes")).unwrap();
        r
    }
    /// Fills the volume holding `at`, leaving about `free` bytes.
    fn fill_disk(at: &Path, free: u64) -> PathBuf {
        use std::io::Write;
        let b = at.join("ballast");
        let mut f = std::fs::File::create(&b).unwrap();
        while f.write_all(&[7u8; 1 << 20]).is_ok() {}
        while f.write_all(&[7u8; 4096]).is_ok() {}
        let len = f.metadata().unwrap().len();
        f.set_len(len.saturating_sub(free)).unwrap();
        f.sync_all().unwrap();
        b
    }
    /// `mid_bulk` at scale: a 18 MB index, a WAL of tens of MB.
    fn big_mid_bulk(root: &Path) -> (Vault, PathBuf, PathBuf, String) {
        let words = |seed: u64| { let mut x = seed; (0..250).map(|_| { (0..6).map(|_| { x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); b"acdefgilmnoprstuvy"[((x >> 33) % 18) as usize] as char }).collect::<String>() }).collect::<Vec<_>>().join(" ") };
        let (dir, db) = (root.join("notes"), root.join("i.sqlite"));
        for i in 0..1500 { std::fs::write(dir.join(format!("filler {i}.md")), words(i)).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        v.index.begin_bulk().unwrap();
        for (k, w) in OLD.iter().enumerate() {
            v.save_note(&d.path, &format!("version {k} {w}"), &stat_hash(&d.path), None, false).unwrap();
            let fillers: Vec<PathBuf> = (k * 400..k * 400 + 400).map(|i| dir.join(format!("filler {}.md", i % 1500))).collect();
            for f in &fillers { std::fs::write(f, words(10_000 + i_of(f) + k as u64)).unwrap(); }
            v.apply_fs_changes(&fillers, None);
        }
        assert!(trigram_on_disk(&db, &OLD[..2]), "control");
        (v, dir, db, d.path)
    }
    fn i_of(f: &Path) -> u64 { f.to_string_lossy().len() as u64 * 7 }
    /// Another writer fills the disk mid-bulk: the lock still succeeds, and its text is gone once there is room again.
    /// shortcut: until then the WAL (up to the 64 MB cap) can't be checkpointed and keeps the lock's old pages; main's
    /// 4 MB autocheckpoint makes that window smaller. A smaller cap costs writes (2500 pages: +0.5 GB per 10k bulk).
    #[test] #[ignore] fn real_full_disk_lock_mid_bulk() {
        let root = ram_root("lockmid");
        let (mut v, dir, db, p) = big_mid_bulk(&root);
        let ballast = fill_disk(&root, 3 << 20);
        v.lock_note(&p, &crypto::new_identity()).expect("the note is locked on disk: the lock must not fail");
        assert_eq!(secure_delete(&v), 0, "the erase stays pending");
        drop(v);
        std::fs::remove_file(ballast).unwrap();
        drop(open(dir, &db, None).unwrap());
        assert!(!trigram_on_disk(&db, &OLD));
    }
    #[test] #[ignore] fn real_full_disk_open_after_crash() {
        let root = ram_root("crashopen");
        let (v, dir, db, _) = big_mid_bulk(&root);
        std::mem::forget(v);
        let ballast = fill_disk(&root, 3 << 20);
        let v = open(dir.clone(), &db, None).expect("a full disk must not keep the vault closed");
        assert_eq!(v.search("version", Sort::Title, 0, &[]).unwrap().hits.len(), 1);
        drop(v);
        std::fs::remove_file(ballast).unwrap();
        drop(open(dir, &db, None).unwrap());
        assert!(!trigram_on_disk(&db, &OLD[..2]), "s's old versions");
    }
    /// Just enough room for `begin_bulk`: the bulk's own WAL then eats into it, and its finish must still run (A-r3).
    #[test] #[ignore] fn real_full_disk_band_still_finishes() {
        let root = ram_root("band");
        let words = |seed: u64| { let mut x = seed; (0..250).map(|_| { (0..6).map(|_| { x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); b"acdefgilmnoprstuvy"[((x >> 33) % 18) as usize] as char }).collect::<String>() }).collect::<Vec<_>>().join(" ") };
        let (dir, db) = (root.join("notes"), root.join("i.sqlite"));
        for i in 0..1500 { std::fs::write(dir.join(format!("filler {i}.md")), words(i)).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        v.index.checkpoint().unwrap();
        let ballast = fill_disk(&root, (128 << 20) + 2 * std::fs::metadata(&db).unwrap().len() + (4 << 20));
        v.index.begin_bulk().expect("room for the bulk");
        for (k, w) in OLD.iter().enumerate() {
            v.save_note(&d.path, &format!("version {k} {w}"), &stat_hash(&d.path), None, false).unwrap();
            let fillers: Vec<PathBuf> = (k * 400..k * 400 + 400).map(|i| dir.join(format!("filler {}.md", i % 1500))).collect();
            for f in &fillers { std::fs::write(f, words(10_000 + i_of(f) + k as u64)).unwrap(); }
            v.apply_bulk_chunk(&fillers, None);
        }
        v.index.end_bulk().expect("the finish runs");
        v.lock_note(&d.path, &crypto::new_identity()).unwrap();
        drop(v);
        std::fs::remove_file(ballast).unwrap();
        assert!(!trigram_on_disk(&db, &OLD), "{:?}", trigram_hits(&db, &OLD));
    }
    /// Too little room for a bulk's WAL and rebuild: no bulk, so locks work as on main.
    #[test] #[ignore] fn real_full_disk_skips_the_bulk() {
        let root = ram_root("nobulk");
        let (dir, db) = (root.join("notes"), root.join("i.sqlite"));
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        let mut v = open(dir, &db, None).unwrap();
        let ballast = fill_disk(&root, 40 << 20);
        assert!(v.index.begin_bulk().is_err());
        let d = v.open_or_create("s", None, false).unwrap();
        for w in OLD { v.save_note(&d.path, &format!("s {w}"), &stat_hash(&d.path), None, false).unwrap(); }
        v.lock_note(&d.path, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD));
        std::fs::remove_file(ballast).unwrap();
    }
    /// Another connection (`velo --mcp` direct mode) holds the write lock for `ms`.
    fn hold_write(db: &Path, ms: u64) -> std::thread::JoinHandle<()> {
        let c = rusqlite::Connection::open(db).unwrap();
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(ms)); c.execute_batch("ROLLBACK").unwrap(); })
    }
    fn secret_note(v: &mut Vault) -> String {
        let d = v.open_or_create("s", None, false).unwrap();
        v.save_note(&d.path, &format!("s {}", OLD[0]), &stat_hash(&d.path), None, false).unwrap();
        d.path
    }
    /// As on main, a lock waits out another writer (busy_timeout) instead of failing with its plaintext row live.
    #[test] fn lock_under_another_writer() {
        let (dir, db) = setup();
        let mut v = open(dir, &db, None).unwrap();
        let p = secret_note(&mut v);
        let h = hold_write(&db, 1000);
        let r = v.lock_note(&p, &crypto::new_identity());
        h.join().unwrap();
        assert!(r.is_ok(), "{r:?}");
        assert!(v.search(OLD[0], Sort::Title, 0, &[]).unwrap().hits.iter().all(|h| h.path != p), "the plain row is still live");
    }
    #[test] fn synced_lock_under_another_writer() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let p = secret_note(&mut v);
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        let h = hold_write(&db, 1000);
        v.apply_fs_changes(&[PathBuf::from(&p)], None);
        h.join().unwrap();
        assert!(v.search(OLD[0], Sort::Title, 0, &[]).unwrap().hits.is_empty(), "the locked note's plaintext row is still live");
    }
    /// A crash mid-bulk, a note locked elsewhere meanwhile, a low disk: open still works (no rebuild inside its batch).
    #[test] #[ignore] fn real_full_disk_open_with_a_synced_lock() {
        let root = ram_root("opensynced");
        let (v, dir, db, p) = big_mid_bulk(&root);
        std::mem::forget(v);
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        for free in [3u64, 12] {
            let ballast = fill_disk(&root, free << 20);
            let r = open(dir.clone(), &db, None).map(drop);
            std::fs::remove_file(&ballast).unwrap();
            assert!(r.is_ok(), "{free} MB free: {r:?}");
        }
        drop(open(dir, &db, None).unwrap());
        assert!(!trigram_on_disk(&db, &OLD), "{:?}", trigram_hits(&db, &OLD));
    }


    fn nick_vault() -> (Vault, PathBuf) {
        let (dir, db) = setup();
        std::fs::write(dir.join("Nick.md"), "---\naliases: [Nicholas]\n---\n").unwrap();
        std::fs::write(dir.join("L.md.age"), b"x").unwrap();
        (open(dir.clone(), &db, None).unwrap(), dir)
    }
    #[test] fn create_from_selection_writes_text_and_indexes() {
        let (mut v, dir) = nick_vault();
        let p = v.create_from_selection(" New ", "some\ntext", false).unwrap();
        assert_eq!(p, dir.join("New.md").to_string_lossy());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "some\ntext");
        assert_eq!(v.find_note("New").unwrap(), Some(p));
    }
    #[test] fn create_from_selection_stamps_front_matter() {
        let (mut v, _) = nick_vault();
        let p = v.create_from_selection("New", "body", true).unwrap();
        let t = std::fs::read_to_string(p).unwrap();
        let fm = frontmatter::parse(&t).unwrap();
        assert!(fm.created.is_some());
        assert_eq!(&t[fm.end..], "body");
    }
    #[test] fn create_from_selection_keeps_a_leading_rule_block_as_body() {
        let sel = "---\nfoo\n---\nbar";
        for (title, wfm) in [("A", true), ("B", false)] {
            let (mut v, _) = nick_vault();
            let t = std::fs::read_to_string(v.create_from_selection(title, sel, wfm).unwrap()).unwrap();
            let body = frontmatter::parse(&t).map_or(t.as_str(), |fm| &t[fm.end..]);
            assert_eq!(body, format!("\n{sel}"), "write_fm={wfm}");
            assert!(frontmatter::parse(body).is_none(), "write_fm={wfm}");
        }
    }
    #[test] fn create_from_selection_refuses_existing_title_alias_and_locked() {
        let (mut v, dir) = nick_vault();
        let list = |d: &PathBuf| { let mut n: Vec<_> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name()).collect(); n.sort(); n };
        let before = list(&dir);
        for t in ["Nick", "nicholas", "L"] { assert_eq!(v.create_from_selection(t, "x", true).unwrap_err().to_string(), "already-exists", "{t}"); }
        assert_eq!(list(&dir), before);
        assert_eq!(std::fs::read(dir.join("L.md.age")).unwrap(), b"x");
    }
    #[test] fn create_from_selection_refuses_invalid_title() {
        let (mut v, _) = nick_vault();
        assert_eq!(v.create_from_selection("a/b", "x", false).unwrap_err().to_string(), "invalid-title");
    }

    #[test] fn merged_text_appends_under_heading_and_unions_front_matter() {
        let t = merged_text("---\ntags: [a]\naliases: [T2]\n---\nbody T\n", "Target", "---\ntags: [A, b]\naliases: [S2]\n---\nbody S\n", "Source").unwrap();
        assert_eq!(t, "---\ntags: [a, b]\naliases: [T2, S2, Source]\n---\nbody T\n\n## Source\n\nbody S\n");
        assert_eq!(merged_text("x", "Target", "---\ntags: []\n---\n\n\n", "Source").unwrap(), "---\naliases: [Source]\n---\nx\n\n## Source\n", "empty source body: the heading only");
    }
    #[test] fn merged_text_creates_block_and_keeps_crlf() {
        let t = merged_text("body T\r\nline2\r\n", "Target", "\nbody S\nmore\n", "Source").unwrap();
        assert_eq!(t, "---\r\naliases: [Source]\r\n---\r\nbody T\r\nline2\r\n\r\n## Source\r\n\r\nbody S\r\nmore\r\n");
    }
    #[test] fn merged_text_empty_target_body() {
        assert_eq!(merged_text("", "Target", "body S\n", "Source").unwrap(), "---\naliases: [Source]\n---\n## Source\n\nbody S\n");
    }
    #[test] fn merged_text_skips_alias_equal_to_target_title() {
        let t = merged_text("x\n", "Target", "---\naliases: [TARGET, y]\n---\nz\n", "Source").unwrap();
        assert_eq!(frontmatter::parse(&t).unwrap().aliases, vec!["y", "Source"]);
    }
    /// Source.md, Target.md, C.md linking Source twice, and a locked L.md.age linking Source.
    fn merge_vault(target: &str) -> (Vault, PathBuf, String, String) {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Source.md"), "---\ntags: [b]\n---\nbody S\n").unwrap();
        std::fs::write(dir.join("Target.md"), target).unwrap();
        std::fs::write(dir.join("C.md"), "[[Source]] and [[source]]").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let d = v.open_or_create("L", Some(&id), false).unwrap();
        v.save_note(&d.path, "see [[Source]]", &d.hash, Some(&id), false).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        (v, dir.clone(), s(&dir.join("Source.md")), s(&dir.join("Target.md")))
    }
    fn rm(p: &Path) -> std::io::Result<()> { std::fs::remove_file(p) }
    #[test] fn merge_rewrites_links_and_trashes_source() {
        let (mut v, dir, src, dst) = merge_vault("body T\n");
        let locked = std::fs::read(dir.join("L.md.age")).unwrap();
        let r = v.merge_notes_with(&src, &dst, false, rm).unwrap();
        assert_eq!((r.path.as_str(), r.rewritten, r.trash_error), (dst.as_str(), 2, None));
        assert_eq!(std::fs::read_to_string(dir.join("C.md")).unwrap(), "[[Target]] and [[Target]]");
        assert!(!Path::new(&src).exists());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "---\ntags: [b]\naliases: [Source]\n---\nbody T\n\n## Source\n\nbody S\n");
        assert_eq!(v.find_note("Source").unwrap(), Some(dst));
        assert_eq!(std::fs::read(dir.join("L.md.age")).unwrap(), locked);
    }
    #[test] fn merge_snapshots_target_first() {
        let (mut v, _, src, dst) = merge_vault("pre-merge\n");
        v.merge_notes_with(&src, &dst, false, rm).unwrap();
        let r = v.list_revisions(&dst).unwrap();
        assert_eq!(v.read_revision(&dst, &r[0].id, None).unwrap(), "pre-merge\n");
    }
    #[test] fn merge_refuses_same_encrypted_and_twin() {
        let (mut v, dir, src, dst) = merge_vault("body T\n");
        let locked = s(&dir.join("L.md.age"));
        let twin = s(&dir.join("L.md"));
        std::fs::write(&twin, "stale [[Source]]").unwrap(); // a plain twin of the locked note
        let files = || ["Source.md", "Target.md", "C.md", "L.md", "L.md.age"].map(|f| std::fs::read(dir.join(f)).unwrap());
        let before = files();
        let err = |v: &mut Vault, a: &str, b: &str| v.merge_notes_with(a, b, false, rm).unwrap_err().to_string();
        assert_eq!(err(&mut v, &dst, &dst), "same-note");
        for (a, b) in [(&locked, &dst), (&src, &locked), (&twin, &dst), (&src, &twin)] {
            assert_eq!(err(&mut v, a, b), "locked", "{a} into {b}");
        }
        assert_eq!(files(), before);
    }
    #[test] fn merge_unsupported_layout_changes_nothing() {
        let (mut v, dir, src, dst) = merge_vault("---\ntags: [a] # c\n---\nbody T\n");
        let files = || ["Source.md", "Target.md", "C.md"].map(|f| std::fs::read(dir.join(f)).unwrap());
        let before = files();
        assert_eq!(v.merge_notes_with(&src, &dst, false, rm).unwrap_err().to_string(), "unsupported tags: layout");
        assert_eq!(files(), before);
        assert!(v.list_revisions(&dst).unwrap().is_empty());
    }
    #[test] fn merge_trash_failure_is_reported_not_rolled_back() {
        let (mut v, dir, src, dst) = merge_vault("body T\n");
        let r = v.merge_notes_with(&src, &dst, false, |_| Err(std::io::Error::other("trash full"))).unwrap();
        assert_eq!(r.trash_error.as_deref(), Some("trash full"));
        assert_eq!(r.rewritten, 2);
        assert!(std::fs::read_to_string(&dst).unwrap().ends_with("## Source\n\nbody S\n"));
        assert_eq!(std::fs::read_to_string(dir.join("C.md")).unwrap(), "[[Target]] and [[Target]]");
        assert!(Path::new(&src).exists());
    }

    fn shown(v: &Vault) -> Vec<String> { v.search_where("", Sort::Title, 0, &[], false, false).unwrap().hits.into_iter().map(|h| h.title).collect() }
    #[test] fn archive_hides_in_search_timeline_tasks_tags_and_counts_hidden() {
        let (dir, db) = setup();
        for (n, b) in [("Meeting", "agenda #w\n- [ ] ask"), ("Other", "agenda #w")] { std::fs::write(dir.join(format!("{n}.md")), b).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.set_archived(&s(&dir.join("Meeting.md")), true).unwrap();
        let p = v.search_where("agenda", Sort::Title, 0, &[], false, false).unwrap();
        assert_eq!((p.hits.len(), p.total, p.hidden), (1, 1, 1));
        let p = v.search_where("agenda", Sort::Title, 0, &[], false, true).unwrap();
        assert_eq!((p.total, p.hidden, p.hits.iter().filter(|h| h.archived).count()), (2, 0, 1));
        assert_eq!(v.timeline("", &[], false, false, TimelineBy::Updated, None).unwrap().len(), 1);
        assert!(v.timeline("", &[], false, true, TimelineBy::Updated, None).unwrap().iter().any(|r| r.archived));
        assert!(v.tasks("", &[], false, false).unwrap().no_date.is_empty());
        assert!(v.tasks("", &[], false, true).unwrap().no_date[0].archived);
        assert_eq!(v.tags(false).unwrap()[0].count, 1);
        assert!(v.open_note(&s(&dir.join("Meeting.md")), None).unwrap().archived);
    }
    #[test] fn search_without_a_list_file_hides_nothing() {
        let (dir, db) = setup(); std::fs::write(dir.join("A.md"), "agenda").unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert!(!dir.join(".velo/archived").exists());
        let p = v.search_where("agenda", Sort::Title, 0, &[], false, false).unwrap();
        assert_eq!((p.total, p.hidden), (1, 0));
    }
    #[test] fn rename_moves_the_entry() {
        let (dir, db) = setup(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); let p = s(&dir.join("Old.md"));
        v.set_archived(&p, true).unwrap(); v.rename_note(&p, "New", false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "New\n");
        assert!(shown(&v).is_empty());
    }
    #[test] fn case_only_rename_keeps_archived() {
        let (dir, db) = setup(); std::fs::write(dir.join("meeting notes.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); let p = s(&dir.join("meeting notes.md"));
        v.set_archived(&p, true).unwrap(); v.rename_note(&p, "Meeting Notes", false).unwrap();
        assert!(shown(&v).is_empty());
    }
    #[test] fn sanitized_create_clears_the_written_title() {
        let (dir, db) = setup(); std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "A-B\n").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert!(!v.open_or_create("A:B", None, false).unwrap().archived); // writes A-B.md
        assert_eq!(shown(&v), ["A-B"]);
    }
    #[test] fn lock_and_unlock_move_the_entry_when_the_title_is_sanitized() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo .md"), "x").unwrap();
        std::fs::write(dir.join("Bar .md.age"), crypto::encrypt(&id, b"y").unwrap()).unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        for n in ["Foo .md", "Bar .md.age"] { v.set_archived(&s(&dir.join(n)), true).unwrap(); }
        v.lock_note(&s(&dir.join("Foo .md")), &id).unwrap(); // -> Foo.md.age
        v.unlock_note(&s(&dir.join("Bar .md.age")), &id).unwrap(); // -> Bar.md
        assert!(shown(&v).is_empty());
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "Foo\nBar\n");
    }
    /// Twin cases for a title-changing move ("Foo .md" -> "Foo.md": the stem loses its trailing space). The list is by
    /// title: a file already holding the target title keeps that title's state, whatever moves onto it.
    fn list_of(dir: &Path) -> String { std::fs::read_to_string(dir.join(".velo/archived")).unwrap_or_default() }
    fn archived_titles(v: &Vault) -> Vec<String> { let mut t: Vec<String> = v.timeline("", &[], false, true, TimelineBy::Updated, None).unwrap().into_iter().filter(|r| r.archived).map(|r| r.title).collect(); t.sort(); t }
    #[test] fn unlock_onto_an_archived_twins_title_keeps_the_twin_archived() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo .md.age"), crypto::encrypt(&id, b"y").unwrap()).unwrap(); std::fs::write(dir.join("Foo.txt"), "t").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo.txt")), true).unwrap();
        v.unlock_note(&s(&dir.join("Foo .md.age")), &id).unwrap(); // -> Foo.md
        assert_eq!(list_of(&dir), "Foo\n");
        assert_eq!(archived_titles(&v), ["Foo", "Foo"]);
    }
    #[test] fn unlock_of_an_archived_note_onto_a_plain_twins_title_leaves_the_twin_alone() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo .md.age"), crypto::encrypt(&id, b"y").unwrap()).unwrap(); std::fs::write(dir.join("Foo.txt"), "t").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo .md.age")), true).unwrap();
        v.unlock_note(&s(&dir.join("Foo .md.age")), &id).unwrap();
        assert_eq!(list_of(&dir), ""); // the title the twin holds decides; the twin is not archived by the move
        assert!(archived_titles(&v).is_empty());
    }
    #[test] fn lock_onto_an_archived_twins_title_keeps_the_twin_archived() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo .md"), "y").unwrap(); std::fs::write(dir.join("Foo.txt"), "t").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo.txt")), true).unwrap();
        v.lock_note(&s(&dir.join("Foo .md")), &id).unwrap(); // -> Foo.md.age
        assert_eq!(list_of(&dir), "Foo\n");
        assert_eq!(archived_titles(&v), ["Foo", "Foo"]);
    }
    #[test] fn lock_of_an_archived_note_onto_a_plain_twins_title_leaves_the_twin_alone() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo .md"), "y").unwrap(); std::fs::write(dir.join("Foo.txt"), "t").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo .md")), true).unwrap();
        v.lock_note(&s(&dir.join("Foo .md")), &id).unwrap();
        assert_eq!(list_of(&dir), "");
        assert!(archived_titles(&v).is_empty());
    }
    #[test] fn unlock_onto_a_locked_archived_twins_title_keeps_it_archived() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        for n in ["Foo .md.age", "Foo.md.age"] { std::fs::write(dir.join(n), crypto::encrypt(&id, b"y").unwrap()).unwrap(); }
        std::fs::create_dir_all(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "Foo\n").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.unlock_note(&s(&dir.join("Foo .md.age")), &id).unwrap();
        assert_eq!(list_of(&dir), "Foo\n");
    }
    #[test] fn lock_then_unlock_of_an_archived_note_leaves_the_list_unchanged() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo.md"), "y").unwrap(); std::fs::write(dir.join("Bar.md"), "z").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo.md")), true).unwrap(); v.set_archived(&s(&dir.join("Bar.md")), true).unwrap();
        let before = list_of(&dir);
        let l = v.lock_note(&s(&dir.join("Foo.md")), &id).unwrap();
        assert_eq!(list_of(&dir), before);
        v.unlock_note(&l, &id).unwrap();
        assert_eq!(list_of(&dir), before);
        assert!(v.open_note(&s(&dir.join("Foo.md")), None).unwrap().archived);
    }
    #[test] fn unlock_onto_an_existing_plain_file_is_refused_and_changes_nothing() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo.md"), "plain").unwrap(); std::fs::write(dir.join("Foo.md.age"), crypto::encrypt(&id, b"y").unwrap()).unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo.md")), true).unwrap();
        let e = v.unlock_note(&s(&dir.join("Foo.md.age")), &id).unwrap_err();
        assert_eq!(e.downcast_ref::<std::io::Error>().unwrap().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(list_of(&dir), "Foo\n");
        assert_eq!(std::fs::read_to_string(dir.join("Foo.md")).unwrap(), "plain");
        assert!(dir.join("Foo.md.age").exists());
    }
    // One file, two spellings (NFC `to`, NFD from read_dir): it is not its own twin. macOS only: elsewhere NFC and NFD
    // names are two files, and so twins.
    #[cfg(target_os = "macos")] #[test] fn a_file_is_not_its_own_twin_across_unicode_spellings() {
        let (dir, db) = setup();
        let (nfc, nfd) = ("Caf\u{e9}.md", "Cafe\u{301}.md");
        std::fs::write(dir.join(nfd), "x").unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        assert!(!v.title_on_disk("Café", &dir.join(nfc)));
        assert!(!v.title_on_disk("Café", &dir.join(nfd)));
        assert!(v.title_on_disk("Café", &dir.join("Other.md")));
    }
    #[cfg(target_os = "macos")] #[test] fn retitle_to_an_accented_title_keeps_the_note_archived_when_the_volume_lists_nfd() {
        let (dir, db) = setup();
        std::fs::write(dir.join("Cafe\u{301}.md"), "x").unwrap(); // as listed after the rename: decomposed
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::create_dir_all(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "Bar\n").unwrap();
        v.archive_retitle("Bar", "Caf\u{e9}", &dir.join("Caf\u{e9}.md"));
        assert_eq!(list_of(&dir), "Caf\u{e9}\n");
    }
    #[test] fn fold_treats_nfc_and_nfd_titles_as_one() { assert_eq!(fold("Caf\u{e9}"), fold("Cafe\u{301}")); }
    #[test] fn unlock_with_a_trailing_dot_title_change_keeps_an_archived_twin_archived() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("Foo..md.age"), crypto::encrypt(&id, b"y").unwrap()).unwrap(); std::fs::write(dir.join("Foo.txt"), "t").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("Foo.txt")), true).unwrap();
        v.unlock_note(&s(&dir.join("Foo..md.age")), &id).unwrap(); // title "Foo." -> "Foo"
        assert_eq!(list_of(&dir), "Foo\n");
    }
    #[test] fn a_case_only_retitle_beside_a_twin_keeps_one_entry() {
        let (dir, db) = setup();
        std::fs::write(dir.join("FOO.md"), "x").unwrap(); std::fs::write(dir.join("Foo.txt"), "t").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.set_archived(&s(&dir.join("Foo.txt")), true).unwrap();
        v.archive_retitle("Foo", "FOO", &dir.join("FOO.md"));
        assert_eq!(list_of(&dir), "FOO\n");
        assert_eq!(archived_titles(&v), ["FOO", "Foo"]);
    }
    #[test] fn rename_onto_a_stale_entry_is_not_archived() {
        let (dir, db) = setup(); std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join("Foo.md"), "").unwrap();
        std::fs::write(dir.join(".velo/archived"), "Bar\n").unwrap(); // Bar archived, then deleted in Finder
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.rename_note(&s(&dir.join("Foo.md")), "Bar", false).unwrap();
        assert_eq!(shown(&v), ["Bar"]);
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "");
    }
    #[test] fn conflict_copy_of_an_archived_note_is_not_archived() {
        let (dir, db) = setup(); let f = dir.join("A.md"); std::fs::write(&f, "a").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); v.set_archived(&s(&f), true).unwrap();
        let now = chrono::Local::now(); // stale entries for the copy's possible names (this minute and the next)
        let names: Vec<String> = [now, now + chrono::Duration::minutes(1)].iter().map(|t| format!("A (conflict {})", t.format("%Y-%m-%d %H%M"))).collect();
        std::fs::write(dir.join(".velo/archived"), format!("A\n{}\n", names.join("\n"))).unwrap();
        assert!(matches!(v.save_note(&s(&f), "b", "stale-hash", None, false).unwrap(), SaveResult::Conflict { .. }));
        let t = shown(&v); assert!(t.len() == 1 && t[0].starts_with("A (conflict "), "{t:?}");
    }
    #[cfg(unix)] #[test] fn rename_succeeds_and_reports_when_the_list_is_unwritable() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); let p = s(&dir.join("Old.md"));
        v.set_archived(&p, true).unwrap();
        std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let r = v.rename_note(&p, "New", false);
        std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(r.is_ok() && dir.join("New.md").exists());
        assert!(v.archive_error.take().is_some());
    }
    #[test] fn open_note_reads_archived_from_the_list_for_a_file_not_indexed_yet() {
        let (dir, db) = setup();
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::write(dir.join("Late.md"), "x").unwrap(); // created outside, no rescan yet
        std::fs::create_dir_all(dir.join(".velo")).unwrap();
        std::fs::write(dir.join(".velo/archived"), "Late\n").unwrap();
        assert!(v.open_note(&s(&dir.join("Late.md")), None).unwrap().archived);
    }
    #[cfg(unix)] #[test] fn delete_merge_and_create_succeed_and_report_when_the_list_is_unwritable() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); for n in ["A", "B", "T"] { std::fs::write(dir.join(format!("{n}.md")), n).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        for n in ["A", "B"] { v.set_archived(&s(&dir.join(format!("{n}.md"))), true).unwrap(); }
        std::fs::write(dir.join(".velo/archived"), "A\nB\nNew\n").unwrap(); // New: stale, so create must write
        let lock = |m| std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(m)).unwrap();
        lock(0o555);
        v.delete_note_with(&s(&dir.join("A.md")), rm).unwrap();
        assert!(v.archive_error.take().is_some());
        v.merge_notes_with(&s(&dir.join("B.md")), &s(&dir.join("T.md")), false, rm).unwrap();
        assert!(v.archive_error.take().is_some());
        v.create_from_selection("New", "x", false).unwrap();
        assert!(v.archive_error.take().is_some());
        lock(0o755);
    }
    #[cfg(unix)] #[test] fn titles_with_line_breaks_cannot_be_archived() { // Windows rejects the file name
        let (dir, db) = setup(); std::fs::write(dir.join("A\nB.md"), "").unwrap(); // a valid file name on disk
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert!(v.set_archived(&s(&dir.join("A\nB.md")), true).is_err());
        assert!(!dir.join(".velo/archived").exists());
    }
    #[test] fn rename_of_one_twin_keeps_the_other_archived() {
        let (dir, db) = setup(); std::fs::write(dir.join("Foo.md"), "").unwrap(); std::fs::write(dir.join("Foo.txt"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.set_archived(&s(&dir.join("Foo.md")), true).unwrap();
        assert!(shown(&v).is_empty()); // one entry, both files
        v.rename_note(&s(&dir.join("Foo.txt")), "Bar", false).unwrap();
        assert!(shown(&v).is_empty()); // Foo.md still archived, Bar archived too
    }
    #[test] fn delete_and_merge_drop_the_entry() {
        let (dir, db) = setup(); for n in ["A", "B", "T"] { std::fs::write(dir.join(format!("{n}.md")), n).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        for n in ["A", "B", "T"] { v.set_archived(&s(&dir.join(format!("{n}.md"))), true).unwrap(); }
        v.delete_note_with(&s(&dir.join("A.md")), rm).unwrap();
        v.merge_notes_with(&s(&dir.join("B.md")), &s(&dir.join("T.md")), false, rm).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "T\n");
        std::fs::write(dir.join("A.md"), "back from the Trash").unwrap(); v.rescan(None);
        assert_eq!(shown(&v), ["A"]);
    }
    #[test] fn stale_entry_is_kept_and_ignored_and_creation_clears_it() {
        let (dir, db) = setup(); std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join("O.md"), "").unwrap();
        std::fs::write(dir.join(".velo/archived"), "Standup\nDaily\n").unwrap(); // left by a Finder delete
        let mut v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(shown(&v), ["O"]); // matches nothing, hides nothing
        v.set_archived(&s(&dir.join("O.md")), true).unwrap(); v.set_archived(&s(&dir.join("O.md")), false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "Standup\nDaily\n"); // kept: no pruning
        v.create_from_selection("standup", "x", false).unwrap();
        assert!(!v.open_or_create("Daily", None, false).unwrap().archived);
        assert_eq!(shown(&v), ["Daily", "O", "standup"]);
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "");
    }
    #[test] fn archived_survives_lock_unlock_and_relaunch_without_key() {
        let (dir, db) = setup(); let id = crypto::new_identity(); std::fs::write(dir.join("L.md"), "x").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.set_archived(&s(&dir.join("L.md")), true).unwrap();
        let locked = v.lock_note(&s(&dir.join("L.md")), &id).unwrap(); drop(v);
        let mut v = open(dir.clone(), &db, None).unwrap(); // relaunch, no key: nothing can be decrypted
        assert!(shown(&v).is_empty());
        v.set_archived(&locked, false).unwrap(); v.set_archived(&locked, true).unwrap(); // works without the key
        drop(v); let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.unlock_note(&locked, &id).unwrap();
        assert!(shown(&v).is_empty());
    }
    #[test] fn save_keeps_archived() {
        let (dir, db) = setup(); let f = dir.join("A.md"); std::fs::write(&f, "a").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); v.set_archived(&s(&f), true).unwrap();
        let d = v.open_note(&s(&f), None).unwrap(); v.save_note(&d.path, "b", &d.hash, None, true).unwrap();
        assert!(shown(&v).is_empty());
    }
    #[test] fn archiving_leaves_the_file_untouched() {
        let (dir, db) = setup(); let f = dir.join("A.md"); std::fs::write(&f, "a").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let before = (std::fs::read(&f).unwrap(), std::fs::metadata(&f).unwrap().modified().unwrap());
        v.set_archived(&s(&f), true).unwrap(); v.set_archived(&s(&f), false).unwrap(); v.set_archived(&s(&f), true).unwrap();
        assert_eq!((std::fs::read(&f).unwrap(), std::fs::metadata(&f).unwrap().modified().unwrap()), before);
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "A\n");
    }
    #[test] fn hand_edit_and_delete_of_list_seen_at_next_query() {
        let (dir, db) = setup(); std::fs::write(dir.join("A.md"), "").unwrap(); std::fs::write(dir.join("B.md"), "").unwrap();
        let v = open(dir.clone(), &db, None).unwrap();
        std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "a\nb\n").unwrap();
        assert_eq!(v.search_where("", Sort::Title, 0, &[], false, false).unwrap().total, 0);
        std::fs::remove_file(dir.join(".velo/archived")).unwrap();
        assert_eq!(v.search_where("", Sort::Title, 0, &[], false, false).unwrap().total, 2);
    }
    #[test] fn equal_length_rewrite_is_seen_at_the_next_query() { // fails under an (mtime, size) stamp
        let (dir, db) = setup(); for n in ["Foo", "Bar"] { std::fs::write(dir.join(format!("{n}.md")), "").unwrap(); }
        let v = open(dir.clone(), &db, None).unwrap();
        std::fs::create_dir(dir.join(".velo")).unwrap();
        std::fs::write(dir.join(".velo/archived"), "Foo\n").unwrap();
        assert_eq!(shown(&v), ["Bar"]);
        std::fs::write(dir.join(".velo/archived"), "Bar\n").unwrap(); // same size, same tick
        assert_eq!(shown(&v), ["Foo"]);
    }
    #[cfg(unix)] #[test] fn unreadable_list_keeps_the_loaded_set_and_only_logs() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); for n in ["A", "B"] { std::fs::write(dir.join(format!("{n}.md")), "").unwrap(); }
        std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "A\n").unwrap();
        let f = dir.join(".velo/archived");
        let chmod = |m| std::fs::set_permissions(&f, std::fs::Permissions::from_mode(m)).unwrap();
        chmod(0o000); // cold start, unreadable: nothing loaded, everything shows
        let v = open(dir.clone(), &db, None).unwrap();
        assert_eq!(shown(&v), ["A", "B"]);
        assert!(v.archive_error.take().is_none()); // log only, no UI event
        chmod(0o644); assert_eq!(shown(&v), ["B"]); // readable again: loaded
        chmod(0o000); assert_eq!(shown(&v), ["B"]); // unreadable later: the loaded set stays
        chmod(0o644);
    }
    #[cfg(unix)] #[test] fn unreadable_list_makes_note_operations_log_not_report() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, db) = setup(); std::fs::write(dir.join("Old.md"), "").unwrap();
        std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "Old\n").unwrap();
        let f = dir.join(".velo/archived");
        let mut v = open(dir.clone(), &db, None).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o000)).unwrap();
        v.rename_note(&s(&dir.join("Old.md")), "New", false).unwrap();
        v.create_from_selection("Fresh", "x", false).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(v.archive_error.take().is_none()); // a read failure is log only
        assert!(v.archive_read_logged.get());
    }
    #[test] fn archive_edit_skips_the_reload_when_nothing_changed() {
        let (dir, db) = setup(); std::fs::write(dir.join("A.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); v.set_archived(&s(&dir.join("A.md")), true).unwrap();
        v.index.set_archived(&[]).unwrap(); // marker: a reload would put "a" back
        v.archive_edit(|_| {}).unwrap();
        assert!(v.index.archived_titles().unwrap().is_empty());
    }
    #[test] fn rename_and_delete_without_a_list_leave_no_list_file() { // behaviour only: the skipped folder listing is not observable
        let (dir, db) = setup(); std::fs::write(dir.join("A.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let to = v.rename_note(&s(&dir.join("A.md")), "B", false).unwrap().path;
        v.delete_note_with(&to, rm).unwrap();
        assert!(!dir.join(".velo/archived").exists());
    }
    #[test] fn rename_keeps_a_twins_entry_another_process_just_added() {
        let (dir, db) = setup(); for n in ["Foo.md", "Foo.txt"] { std::fs::write(dir.join(n), "").unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.search_where("", Sort::Title, 0, &[], false, false).unwrap(); // loads the (empty) list
        std::fs::create_dir_all(dir.join(".velo")).unwrap();
        std::fs::write(dir.join(".velo/archived"), "Foo\n").unwrap(); // another process archives Foo
        v.rename_note(&s(&dir.join("Foo.md")), "Bar", false).unwrap();
        assert_eq!(crate::archive::read(&dir).unwrap(), ["Foo", "Bar"]);
        assert!(v.search_where("", Sort::Title, 0, &[], false, false).unwrap().hits.is_empty());
    }
    #[test] fn title_on_disk_keeps_the_entry_when_the_listing_fails() {
        let (dir, db) = setup();
        let v = open(dir.clone(), &db, None).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(v.title_on_disk("Anything", Path::new("x")));
    }
    #[test] fn open_or_create_on_an_existing_archived_note_leaves_it_archived() {
        let (dir, db) = setup(); std::fs::write(dir.join("A.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap(); v.set_archived(&s(&dir.join("A.md")), true).unwrap();
        assert!(v.open_or_create("a", None, false).unwrap().archived);
        assert!(shown(&v).is_empty());
        assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "A\n");
    }
    #[test] fn unlocked_archived_note_follows_the_flag() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        std::fs::write(dir.join("S.md"), "secretword\n- [ ] hush").unwrap();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        let p = v.lock_note(&s(&dir.join("S.md")), &id).unwrap(); // stays unlocked in memory
        v.set_archived(&p, true).unwrap();
        assert!(v.search_where("secretword", Sort::Title, 0, &[], false, false).unwrap().hits.is_empty());
        assert!(v.search_where("secretword", Sort::Title, 0, &[], false, true).unwrap().hits[0].archived);
        assert!(v.tasks("", &[], false, false).unwrap().no_date.is_empty());
        assert!(v.tasks("", &[], false, true).unwrap().no_date[0].archived);
    }
    #[test] fn each_folder_has_its_own_list() { // Settings > notes folder changed: the new vault reads the new folder's list
        let (a, db) = setup(); let (b, db2) = setup();
        for d in [&a, &b] { std::fs::write(d.join("N.md"), "").unwrap(); }
        open(a.clone(), &db, None).unwrap().set_archived(&s(&a.join("N.md")), true).unwrap();
        assert_eq!(open(b, &db2, None).unwrap().search_where("", Sort::Title, 0, &[], false, false).unwrap().total, 1);
    }
}
