use crate::crypto;
use crate::frontmatter;
use crate::index::{Index, Meta, Page, Sort, TagCount, TaskRow, all_tags, effective_dates};
use crate::tasks::{TaskView, group_tasks, local_today, parse_tasks, toggle_line};

const PAGE: usize = 200;
use crate::revisions::{RevisionInfo, Revisions, fnv64};
use crate::names::{NoteFile, note_path, parse_note_file};
use crate::store::{SaveResult, Store, hash, meta_of};
use crate::text::{fold, rewrite_links};
use anyhow::{Context, anyhow};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

/// Lines in `text`'s front-matter block (0 without one).
pub fn fm_lines(t: &str) -> usize {
    frontmatter::parse(t).map_or(0, |f| t[..f.end].matches('\n').count())
}

/// Where a toggled task is in the text as saved (after front-matter stamping): what undo sends back.
#[derive(Serialize, Debug, PartialEq)]
pub struct Toggled {
    pub line: usize,
    pub line_text: String,
}

#[derive(Serialize)]
pub struct NoteDoc {
    pub path: String,
    pub title: String,
    pub text: String,
    /// hash of the on-disk bytes (ciphertext for encrypted notes)
    pub hash: String,
    pub encrypted: bool,
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

pub struct Vault {
    pub store: Store,
    pub index: Index,
    /// plaintext of unlocked encrypted notes, memory only
    unlocked: HashMap<String, String>,
    revisions: Revisions,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
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

/// A plain note whose locked twin is on disk: its text must be erased from the index, not just deleted.
fn lost_plain(dir: &Path, p: &Path) -> bool {
    parse_note_file(p).is_some_and(|nf| !nf.encrypted && note_path(dir, &nf.title, true).exists())
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

/// Notes per index transaction in bulk paths (10k-note cold build: 500 writes 544 MB, 2000 writes 270 MB, one transaction 155 MB).
const CHUNK: usize = 2000;

impl Vault {
    /// `progress(done, total)` counts files needing (re)indexing; every 250 files and at the end, never when none.
    pub fn open_with_progress(dir: PathBuf, db_path: &Path, identity: Option<&str>, progress: &mut dyn FnMut(usize, usize)) -> anyhow::Result<Vault> {
        // revisions live next to the index db (the app data dir), keyed by vault dir
        let root = db_path.parent().unwrap_or(Path::new(".")).join("revisions").join(fnv64(&s(&dir)));
        let mut v = Vault { store: Store::new(dir), index: Index::open(db_path)?, unlocked: HashMap::new(), revisions: Revisions::new(root) };
        v.revisions.maybe_prune(now_ms());
        let files = v.store.list()?;
        let (stale, gone) = v.diff(&files)?;
        let total = stale.len();
        // A locked note new to the index: its plain twin's text may have been deleted earlier (a watcher batch, an
        // earlier session) but not erased. A plain twin deleted now marks in its own delete (`remove_note`).
        let lost = stale.iter().any(|(p, nf, _)| nf.encrypted && v.index.title_modified(&s(p)).ok().flatten().is_none());
        // One transaction per chunk: a crash loses at most a chunk, which isn't in `known()`, so the next open redoes it.
        v.index.begin()?;
        if lost {
            v.index.need_purge()?;
        }
        for (i, (path, nf, meta)) in stale.into_iter().enumerate() {
            if let Ok(bytes) = v.store.read(path) {
                let body = (!nf.encrypted).then(|| lossy(&bytes));
                v.index.upsert(&s(path), nf, meta, body.as_deref())?;
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
        v.index.commit()?;
        v.purge_pending(true); // also one a crash or a failure left from an earlier session
        if total > 0 {
            v.index.checkpoint()?; // don't keep a bulk build's WAL for the whole session
        }
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
    fn diff<'a>(&self, files: &'a [(PathBuf, NoteFile, Meta)]) -> anyhow::Result<(Vec<&'a (PathBuf, NoteFile, Meta)>, Vec<String>)> {
        let known = self.index.known()?;
        let stale = files.iter().filter(|(path, _, meta)| !known.get(&s(path)).is_some_and(|k| k.mtime == meta.mtime && k.size == meta.size)).collect();
        let present: std::collections::HashSet<String> = files.iter().map(|(p, ..)| s(p)).collect();
        let gone = known.into_keys().filter(|k| !present.contains(k)).collect();
        Ok((stale, gone))
    }

    /// Re-check the whole folder against the index (the watcher missed events, or they came before it started).
    pub fn rescan(&mut self, identity: Option<&str>) -> Vec<String> {
        self.try_rescan(identity).unwrap_or_default()
    }

    /// `rescan`, failing when the folder or the index can't be read.
    pub fn try_rescan(&mut self, identity: Option<&str>) -> anyhow::Result<Vec<String>> {
        let paths = self.stale_paths()?;
        Ok(self.apply_fs_changes(&paths, identity))
    }

    /// Paths a rescan would apply: files that differ from the index, and indexed notes no longer on disk.
    pub fn stale_paths(&self) -> anyhow::Result<Vec<PathBuf>> {
        let files = self.store.list()?;
        let (stale, gone) = self.diff(&files)?;
        Ok(stale.into_iter().map(|(p, ..)| p.clone()).chain(gone.into_iter().map(PathBuf::from)).collect())
    }

    /// A note file directly inside the notes folder; anything else is refused (paths come from the webview).
    fn note(&self, p: &Path) -> anyhow::Result<NoteFile> {
        if p.parent() != Some(self.store.dir.as_path()) {
            return Err(anyhow!("not a note in the notes folder"));
        }
        parse(p)
    }

    fn try_unlock(&mut self, path: &Path, identity: &str) {
        if let Ok(plain) = self.store.read(path).and_then(|b| crypto::decrypt(identity, &b).map_err(std::io::Error::other)) {
            self.unlocked.insert(s(path), lossy(&plain));
        }
    }

    /// Index a file already on disk; plaintext `body` is dropped for encrypted notes.
    fn reindex(&mut self, path: &Path, body: Option<&str>) -> anyhow::Result<()> {
        let nf = self.note(path)?;
        self.index.upsert(&s(path), &nf, &stat(path)?, body)
    }

    pub fn search(&self, query: &str, sort: Sort, offset: usize, tags: &[String]) -> anyhow::Result<Page> {
        self.index.search_page(query, sort, offset, PAGE, tags, &self.unlocked)
    }

    /// Open and recent tasks; unlocked notes' tasks come from memory, so they never reach SQLite.
    pub fn tasks(&self, query: &str, tags: &[String], show_done: bool) -> anyhow::Result<TaskView> {
        let mut rows = self.index.task_rows(tags)?;
        let wanted: Vec<String> = tags.iter().map(|t| fold(t)).collect();
        for (path, plain) in &self.unlocked {
            let Some((title, modified)) = self.index.title_modified(path)? else { continue };
            let have = all_tags(frontmatter::body(plain), frontmatter::parse(plain).as_ref());
            if !wanted.iter().all(|w| have.iter().any(|(h, _)| h == w)) {
                continue;
            }
            rows.extend(parse_tasks(plain).into_iter().map(|t| TaskRow { path: path.clone(), title: title.clone(), modified, line: t.line, text: t.text, done: t.done, due: t.due, done_on: t.done_on, line_text: t.line_text }));
        }
        Ok(group_tasks(rows, query, show_done, &local_today()))
    }

    /// Tags of plain notes only: unlocked notes' tags stay in memory and out of this list.
    pub fn tags(&self) -> anyhow::Result<Vec<TagCount>> {
        self.index.tags()
    }

    pub fn titles(&self) -> anyhow::Result<Vec<String>> {
        self.index.titles()
    }

    pub fn open_note(&mut self, path: &str, identity: Option<&str>) -> anyhow::Result<NoteDoc> {
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
        let meta = note_meta(&text, &stat(p)?);
        Ok(NoteDoc { path: path.into(), title: nf.title, text, hash: hash(&bytes), encrypted: nf.encrypted, meta })
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
            SaveResult::Saved { front_matter, .. } => Ok(Toggled { line: line - fm_lines(&text) + front_matter.as_deref().map_or(fm_lines(&text), fm_lines), line_text }),
            SaveResult::Conflict { .. } => Err(anyhow!("task-moved")), // disk changed since we read it
        }
    }

    /// Append `- [ ] text` to the note titled `title` (created if missing); returns its path.
    pub fn capture_task(&mut self, title: &str, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<String> {
        if text.trim().is_empty() { return Err(anyhow!("empty")); }
        let path = self.open_or_create(title, identity, write_fm)?.path;
        self.append_task(&path, text, identity, write_fm)
    }

    /// Append `- [ ] text` to the note at `path`; returns the path.
    pub fn append_task(&mut self, path: &str, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<String> {
        let text = text.trim().replace(['\r', '\n'], " ");
        if text.is_empty() { return Err(anyhow!("empty")); }
        let doc = self.open_note(path, identity)?;
        self.append_in(doc, &text, identity, write_fm)
    }

    fn append_in(&mut self, doc: NoteDoc, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<String> {
        let eol = if doc.text.contains("\r\n") { "\r\n" } else { "\n" };
        let sep = if doc.text.is_empty() || doc.text.ends_with('\n') { "" } else { eol };
        match self.save_note(&doc.path, &format!("{}{sep}- [ ] {text}{eol}", doc.text), &doc.hash, identity, write_fm)? {
            SaveResult::Saved { .. } => Ok(doc.path),
            SaveResult::Conflict { .. } => Err(anyhow!("conflict")),
        }
    }

    pub fn save_note(&mut self, path: &str, text: &str, base_hash: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<SaveResult> {
        let p = Path::new(path);
        let nf = self.note(p)?;
        let encrypted = nf.encrypted;
        // A stale editor bound to the pre-lock path must not resurrect the plaintext next to Title.md.age.
        if !encrypted && note_path(&self.store.dir, &nf.title, true).exists() {
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
        let before = std::fs::read(p).ok(); // the version this save replaces, for the revision snapshot
        let mut res = self.store.save(p, &bytes, base_hash)?;
        let target = match &res {
            SaveResult::Saved { .. } => p.to_path_buf(),
            SaveResult::Conflict { conflict_path, .. } => PathBuf::from(conflict_path),
        };
        self.reindex(&target, (!encrypted).then_some(text))?;
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
            *meta = note_meta(text, &stat(&target)?);
            *front_matter = stamped.as_deref().filter(|t| *t != orig).and_then(|t| frontmatter::parse(t).map(|f| t[..f.end].to_string()));
        }
        Ok(res)
    }

    pub fn rename_note(&mut self, path: &str, new_title: &str, rewrite_links_too: bool) -> anyhow::Result<RenameResult> {
        let from = Path::new(path);
        let old = self.note(from)?;
        let to = self.store.rename(from, new_title)?; // keeps io::ErrorKind::AlreadyExists
        // The file has moved: from here on nothing may fail the rename, or the UI keeps the old path and its next
        // save recreates the old file. Index errors heal on the next change; an unreadable link source is skipped.
        let (from_s, to_s) = (path.to_string(), s(&to));
        if to_s != from_s {
            self.index.remove(&from_s).ok();
            if let Some(plain) = self.unlocked.remove(&from_s) {
                self.unlocked.insert(to_s.clone(), plain);
            }
        }
        let nf = parse(&to)?; // same extension as `from`, which parsed: cannot fail
        self.revisions.rename(&old.title, &nf.title);
        let body = (!nf.encrypted).then(|| lossy(&self.store.read(&to).unwrap_or_default()));
        self.reindex(&to, body.as_deref()).ok();

        let mut rewritten = 0;
        if rewrite_links_too {
            let batched = self.index.begin().is_ok();
            let mut done = Vec::new();
            for src in self.index.backlinks(&old.title).unwrap_or_default() {
                let sp = Path::new(&src);
                if !self.rewritable(sp) {
                    continue;
                }
                let Ok(bytes) = self.store.read(sp) else { continue };
                let (new_text, n) = rewrite_links(&lossy(&bytes), &old.title, &nf.title);
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
            }
        }
        Ok(RenameResult { path: to_s, rewritten })
    }

    /// Notes whose links a rename of `title` would rewrite (the "Update N links?" count).
    pub fn backlink_count(&self, title: &str) -> anyhow::Result<usize> {
        Ok(self.index.backlinks(title)?.iter().filter(|p| self.rewritable(Path::new(p))).count())
    }

    /// A link source a rename may rewrite: a plain note on disk. A plain twin of a locked note is locked too
    /// (save_note refuses it the same way); a source the index still lists after it was deleted, or one that can't be
    /// read, is skipped.
    pub fn rewritable(&self, src: &Path) -> bool {
        parse_note_file(src).is_some_and(|n| !n.encrypted && !note_path(&self.store.dir, &n.title, true).exists()) && src.is_file() && std::fs::File::open(src).is_ok()
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
        // Mark the erase before anything changes: a failure here fails the lock cleanly, and a crash or a failed purge
        // later leaves the mark set, so it is retried.
        self.index.need_purge()?;
        // first: on failure nothing else has changed, and no plaintext snapshot survives a lock
        self.revisions.encrypt_all(&nf.title, |b| crypto::encrypt(identity, b))?;
        let plain = self.store.read(from)?;
        self.store.write_atomic(&to, &crypto::encrypt(identity, &plain)?)?;
        std::fs::remove_file(from).context("removing plaintext note")?;
        self.index.remove_erasing(path)?; // marks again with the delete: another process may have cleared the early mark
        self.reindex(&to, None)?;
        // The note is locked whatever happens next; a failed erase stays marked and is retried (watcher, lock, open).
        self.purge_pending(true);
        self.unlocked.insert(s(&to), lossy(&plain));
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
        std::fs::remove_file(from).context("removing encrypted note")?;
        self.index.remove(path)?;
        self.unlocked.remove(path);
        self.reindex(&to, Some(&lossy(&plain)))?;
        Ok(s(&to))
    }

    /// Move a note to the OS Trash and drop it from the index and the unlocked cache.
    pub fn delete_note(&mut self, path: &str) -> anyhow::Result<()> {
        self.delete_note_with(path, move_to_trash)
    }

    /// `remove` does the actual file removal (Trash in the app, plain remove in tests).
    pub fn delete_note_with(&mut self, path: &str, remove: impl FnOnce(&Path) -> std::io::Result<()>) -> anyhow::Result<()> {
        let p = Path::new(path);
        self.note(p)?;
        remove(p)?;
        self.remove_note(path)?;
        self.unlocked.remove(path);
        Ok(())
    }

    pub fn list_revisions(&self, path: &str) -> anyhow::Result<Vec<RevisionInfo>> {
        Ok(self.revisions.list(&self.note(Path::new(path))?.title))
    }

    pub fn read_revision(&self, path: &str, id: &str, identity: Option<&str>) -> anyhow::Result<String> {
        let (bytes, enc) = self.revisions.read(&self.note(Path::new(path))?.title, id)?;
        if !enc {
            return Ok(lossy(&bytes));
        }
        Ok(lossy(&crypto::decrypt(identity.ok_or_else(|| anyhow!("locked"))?, &bytes)?))
    }

    /// Not throttled. Locked notes get ciphertext; their identical-content check decrypts the newest snapshot.
    pub fn snapshot_text(&mut self, path: &str, text: &str, identity: Option<&str>) -> anyhow::Result<()> {
        let nf = self.note(Path::new(path))?;
        // a stale pre-lock path still means a locked note: never write its text as plaintext
        if !nf.encrypted && !note_path(&self.store.dir, &nf.title, true).exists() {
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
        if nf.encrypted || note_path(&self.store.dir, &nf.title, true).exists() {
            return Err(anyhow!("locked"));
        }
        let bytes = std::fs::read(path)?;
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
        if nf.encrypted || note_path(&self.store.dir, &nf.title, true).exists() {
            return Err(anyhow!("locked"));
        }
        self.revisions.snapshot_agent(&nf.title, text.as_bytes(), false, now_ms(), summary)?;
        Ok(())
    }

    pub fn lock_all(&mut self) {
        self.unlocked.clear();
    }

    pub fn apply_fs_changes(&mut self, paths: &[PathBuf], identity: Option<&str>) -> Vec<String> {
        self.apply_fs_changes_then(paths, identity, true)
    }

    /// `apply_fs_changes`; `purge` false defers a marked purge to the caller's last chunk (a rescan purges once).
    pub fn apply_fs_changes_then(&mut self, paths: &[PathBuf], identity: Option<&str>, purge: bool) -> Vec<String> {
        let mut changed = Vec::new();
        for chunk in paths.chunks(CHUNK) {
            let mark = changed.len();
            // If `begin` fails, each upsert/remove commits on its own, as before.
            let batched = self.index.begin().is_ok();
            let ok = self.apply_chunk(chunk, identity, batched, &mut changed);
            if batched && !(ok && self.index.commit().is_ok()) {
                // Disk full or I/O error: the whole batch is gone, so redo it note by note, else `changed` would list
                // notes that aren't indexed.
                changed.truncate(mark);
                self.apply_chunk(chunk, identity, false, &mut changed);
            }
        }
        if purge {
            self.purge_pending(false);
        }
        changed
    }

    /// Drop a note from the index; a plain note whose locked twin exists (on disk, or still indexed: a sync may be
    /// rewriting it) marks a purge in the same transaction.
    fn remove_note(&mut self, path: &str) -> anyhow::Result<()> {
        let p = Path::new(path);
        let twin_indexed = || parse_note_file(p).is_some_and(|nf| !nf.encrypted && self.index.title_modified(&s(&note_path(&self.store.dir, &nf.title, true))).ok().flatten().is_some());
        if lost_plain(&self.store.dir, p) || twin_indexed() { self.index.remove_erasing(path) } else { self.index.remove(path) }
    }

    /// Retry a failed purge whose backoff has ended; the wait until the next retry while it still fails.
    pub fn retry_purge(&self) -> Option<std::time::Duration> {
        self.purge_pending(false);
        self.index.purge_retry_in()
    }

    /// Run a marked purge; on failure log it and keep the mark for the next trigger. `force` skips the backoff.
    fn purge_pending(&self, force: bool) {
        if let Err(e) = self.index.purge_pending(force) {
            let msg = format!("erasing deleted note text from the index failed, will retry: {e}");
            crate::log::line(&msg);
            // `velo --mcp` direct mode has no velo.log (its rotation lock is per process); stderr is its client's log.
            eprintln!("velo: {msg}");
        }
    }

    /// `apply_fs_changes` for one chunk; false (and stop) when an error aborted the `batched` transaction.
    fn apply_chunk(&mut self, paths: &[PathBuf], identity: Option<&str>, batched: bool, changed: &mut Vec<String>) -> bool {
        for p in paths {
            let Some(nf) = parse_note_file(p) else { continue };
            let key = s(p);
            match self.store.read(p) {
                Ok(bytes) => {
                    if self.store.take_self_write(p, &bytes) {
                        continue;
                    }
                    let body = (!nf.encrypted).then(|| lossy(&bytes));
                    // locked elsewhere: its plain twin's text may have been deleted from the index in an earlier batch
                    let new = nf.encrypted && self.index.title_modified(&key).ok().flatten().is_none();
                    if (new && self.index.need_purge().is_err()) || self.reindex(p, body.as_deref()).is_err() {
                        if batched && !self.index.in_batch() {
                            return false;
                        }
                        continue;
                    }
                    if nf.encrypted {
                        self.secure_revisions(&nf.title, identity);
                        if let Some(id) = identity {
                            self.try_unlock(p, id);
                        }
                    }
                }
                // Only a missing file is a deletion: iCloud-evicted, unreadable or sync-locked files stay listed.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // locked on another machine: its plaintext must be erased, not just deleted
                    if self.remove_note(&key).is_err() {
                        if batched && !self.index.in_batch() {
                            return false;
                        }
                        continue;
                    }
                    self.unlocked.remove(&key);
                }
                Err(_) => continue,
            }
            changed.push(key);
        }
        true
    }

    /// A note locked elsewhere (synced in as .md.age) must leave no plaintext revisions here: encrypt them,
    /// or delete them when this machine has no key.
    fn secure_revisions(&self, title: &str, identity: Option<&str>) {
        match identity {
            Some(id) => self.revisions.encrypt_all(title, |b| crypto::encrypt(id, b)).ok(),
            None => self.revisions.remove_plain(title).ok(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            if let Ok(b) = std::fs::read(&f) { assert!(!b.windows(11).any(|w| w == b"uniqueplain"), "{f}");
                // FTS trigram index keeps overlapping 3-byte terms; none may survive
                let word = b"zqxjvkplmwqbyfh";
                assert!(!word.windows(3).any(|g| b.windows(3).any(|w| w == g)), "trigram leak in {f}"); }
        }
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap(); assert_eq!(v.search("uniqueplain", Sort::Modified, 0, &[]).unwrap().hits.len(), 1);
        v.lock_all(); assert!(v.search("uniqueplain", Sort::Modified, 0, &[]).unwrap().hits.is_empty());
        assert!(v.open_note(&p, None).is_err()); assert_eq!(v.open_note(&p, Some(&id)).unwrap().text, "uniqueplain zqxjvkplmwqbyfh");
    }
    #[test] fn locked_tasks_never_in_sqlite_but_listed_while_unlocked() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "- [ ] secretzebra", &d.hash, None, false).unwrap();
        assert_eq!(v.tasks("", &[], false).unwrap().no_date.len(), 1);
        v.lock_note(&d.path, &id).unwrap();
        assert!(v.index.task_rows(&[]).unwrap().iter().all(|r| !r.text.contains("secretzebra")));
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            if let Ok(b) = std::fs::read(format!("{}{suffix}", db.display())) { assert!(!b.windows(11).any(|w| w == b"secretzebra"), "{suffix}"); }
        }
        let mut v = open(dir, &db, Some(&id)).unwrap();
        let t = v.tasks("", &[], false).unwrap();
        assert_eq!(t.no_date.len(), 1); assert_eq!(t.no_date[0].text, "secretzebra");
        v.lock_all();
        assert!(v.tasks("", &[], false).unwrap().no_date.is_empty());
    }
    #[test] fn locked_note_tags_stay_out_of_sqlite() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, None).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        let _r = v.save_note(&d.path, "#zqxjvkplmwqbyfh text", &d.hash, None, false).unwrap();
        assert_eq!(v.tags().unwrap().len(), 1); v.lock_note(&d.path, &id).unwrap();
        assert!(v.tags().unwrap().is_empty());
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            let f = format!("{}{suffix}", db.display());
            if let Ok(b) = std::fs::read(&f) {
                let word = b"zqxjvkplmwqbyfh";
                assert!(!word.windows(3).any(|g| b.windows(3).any(|w| w == g)), "trigram leak in {f}"); }
        }
        let v = open(dir, &db, Some(&id)).unwrap();
        assert!(v.tags().unwrap().is_empty());
        assert_eq!(v.search("", Sort::Title, 0, &["zqxjvkplmwqbyfh".to_string()]).unwrap().hits.len(), 1);
    }
    #[test] fn save_to_plain_path_refused_when_locked_sibling_exists() {
        let (dir, db) = setup(); let id = crypto::new_identity();
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap(); let d = v.open_or_create("s", None, false).unwrap();
        v.lock_note(&d.path, &id).unwrap();
        let e = v.save_note(&d.path, "stale zqxjvkplmwqbyfh", &d.hash, Some(&id), false).err().unwrap();
        assert_eq!(e.to_string(), "locked-sibling");
        assert!(!Path::new(&d.path).exists());
        drop(v);
        for suffix in ["", "-wal", "-shm"] {
            if let Ok(b) = std::fs::read(format!("{}{suffix}", db.display())) {
                let word = b"zqxjvkplmwqbyfh";
                assert!(!word.windows(3).any(|g| b.windows(3).any(|w| w == g)), "trigram leak");
            }
        }
    }
    #[test] fn rename_rewrites_backlinks() {
        let (dir, db) = setup();
        std::fs::write(dir.join("a.md"), "see [[Old]]").unwrap(); std::fs::write(dir.join("Old.md"), "").unwrap();
        let mut v = open(dir.clone(), &db, None).unwrap();
        let old = dir.join("Old.md").to_string_lossy().into_owned();
        let r = v.rename_note(&old, "New", true).unwrap();
        assert_eq!(r.rewritten, 1); assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "see [[New]]");
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
        assert_eq!(std::fs::read_to_string(&p).unwrap(), format!("- [x] a ✅ {}\n", local_today()));
    }
    #[test] fn toggle_task_reports_line_after_stamping() {
        let mut v = open_empty(); let p = note_with(&mut v, "t", "x\n- [ ] a\n");
        let t = v.toggle_task(&p, 1, "- [ ] a", None, true).unwrap();
        let saved = std::fs::read_to_string(&p).unwrap();
        assert!(saved.starts_with("---\n"), "stamped front matter: {saved}");
        assert!(t.line > 1);
        assert_eq!(saved.split('\n').nth(t.line).unwrap(), t.line_text);
        assert_eq!(t.line_text, format!("- [x] a ✅ {}", local_today()));
        let back = v.toggle_task(&p, t.line, &t.line_text, None, true).unwrap();
        assert_eq!(back, Toggled { line: t.line, line_text: "- [ ] a".into() });
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
        assert_eq!(std::fs::read_to_string(&p).unwrap(), format!("x\r\n- [x] a ✅ {}\r\n", local_today()));
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
        assert_eq!(plain, format!("- [x] secret ✅ {}\n", local_today()));
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

    /// Some 3-byte FTS trigram of any of `words` in the index files (the vault may still be open). Note paths are
    /// blanked first: the random temp dir name can contain a trigram.
    fn trigram_on_disk(db: &Path, words: &[&str]) -> bool {
        let tmp = s(&std::env::temp_dir());
        let p = tmp.as_bytes();
        ["", "-wal", "-shm"].iter().filter_map(|x| std::fs::read(format!("{}{x}", db.display())).ok()).any(|mut b| {
            // blank the temp prefix and the random dir name that follows it
            let mut i = 0;
            while let Some(k) = b[i..].windows(p.len()).position(|w| w == p) {
                let end = (i + k + p.len() + 12).min(b.len());
                b[i + k..end].fill(0);
                i = end;
            }
            words.iter().any(|w| w.as_bytes().windows(3).any(|g| b.windows(3).any(|x| x == g)))
        })
    }
    // Letters absent from the other strings the index holds ("file", "frontmatter", filler text), so a trigram can't
    // be faked by two integer bytes followed by one of them.
    const OLD: [&str; 3] = ["qxzjkwbhzqjx", "jzwqhkxbjwzq", "kbzxqjhwkzxb"];
    /// A plain note edited a few times (each edit leaves its old trigrams in FTS segments) among other notes.
    fn edited_note() -> (Vault, PathBuf, PathBuf, String) {
        let (dir, db) = setup();
        for i in 0..300 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} lorem ipsum dolor")).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        for (k, w) in OLD.iter().enumerate() {
            v.save_note(&d.path, &format!("version {k} {w}"), &stat_hash(&d.path), None, false).unwrap();
            let fillers: Vec<PathBuf> = (k * 50..k * 50 + 50).map(|i| dir.join(format!("filler {i}.md"))).collect();
            for f in &fillers { std::fs::write(f, format!("edited {k} lorem")).unwrap(); }
            v.apply_fs_changes(&fillers, None);
        }
        assert!(trigram_on_disk(&db, &OLD[..2]), "old versions linger until purged: the test would prove nothing");
        (v, dir, db, d.path)
    }
    #[test] fn lock_erases_every_version_of_the_note_from_the_index_files() {
        let (mut v, _dir, db, p) = edited_note();
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        assert!(!trigram_on_disk(&db, &OLD), "while open");
        drop(v);
        assert!(!trigram_on_disk(&db, &OLD), "after close");
    }
    #[test] fn locked_elsewhere_in_a_later_batch_still_erases_the_plaintext() {
        let (mut v, dir, db, p) = edited_note();
        std::fs::remove_file(&p).unwrap();
        v.apply_fs_changes(&[PathBuf::from(&p)], None); // the delete arrives first, with no locked twin yet
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        v.apply_fs_changes(&[dir.join("s.md.age")], None);
        assert!(!trigram_on_disk(&db, &OLD));
    }
    #[test] fn locked_elsewhere_while_closed_is_erased_on_open() {
        // velo saw: neither change, only the delete, or only the locked twin, before it closed
        for seen in ["none", "delete", "twin"] {
            let (mut v, dir, db, p) = edited_note();
            let age = dir.join("s.md.age");
            let twin = || std::fs::write(&age, crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
            match seen {
                "delete" => { std::fs::remove_file(&p).unwrap(); v.apply_fs_changes(&[PathBuf::from(&p)], None); }
                "twin" => { twin(); v.apply_fs_changes(&[age.clone()], None); }
                _ => {}
            }
            drop(v);
            if seen != "twin" { twin(); }
            if seen != "delete" { std::fs::remove_file(&p).unwrap(); }
            let _v = open(dir, &db, None).unwrap();
            assert!(!trigram_on_disk(&db, &OLD), "seen {seen}");
        }
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

    #[test] fn r1_crash_before_purge_leaves_plaintext() {
        let (mut v, dir, db, p) = edited_note();
        let id = crypto::new_identity();
        let to = dir.join("s.md.age");
        let plain = std::fs::read(&p).unwrap();
        std::fs::write(&to, crypto::encrypt(&id, &plain).unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        v.index.need_purge().unwrap(); // lock_note's index steps, then a crash before the purge
        v.index.remove(&p).unwrap();
        v.reindex(&to, None).unwrap();
        drop(v);
        let mut v2 = open(dir.clone(), &db, Some(&id)).unwrap();
        let also = v2.rescan(Some(&id));
        drop(v2);
        assert!(!trigram_on_disk(&db, &OLD), "plaintext survives reopen+rescan (rescan changed {also:?})");
    }
    fn purge_marked(v: &Vault) -> bool {
        v.index.raw().query_row("SELECT EXISTS(SELECT 1 FROM purge_mark WHERE gen > 0)", [], |x| x.get(0)).unwrap()
    }
    /// Makes the next purge fail: a reader pins the old pages, so the TRUNCATE checkpoint reports busy.
    fn block_purge(v: &Vault, db: &Path) -> rusqlite::Connection {
        v.index.raw().busy_timeout(std::time::Duration::ZERO).unwrap();
        let r = rusqlite::Connection::open(db).unwrap();
        r.execute_batch("BEGIN").unwrap();
        let _: i64 = r.query_row("SELECT count(*) FROM notes_fts_data", [], |x| x.get(0)).unwrap();
        r
    }
    #[test] fn r1_purge_failure_in_lock_is_retried_at_open() {
        let (mut v, dir, db, p) = edited_note();
        let id = crypto::new_identity();
        nearly_full(&v, 0); // a nearly full disk doesn't fail the lock either
        let r = block_purge(&v, &db);
        assert!(v.lock_note(&p, &id).is_ok(), "the lock happened: only the erase failed, and it is retried");
        nearly_full(&v, 1_000_000);
        assert!(purge_marked(&v));
        drop(r);
        drop(v);
        let v = open(dir.clone(), &db, Some(&id)).unwrap();
        assert!(!purge_marked(&v));
        assert!(!trigram_on_disk(&db, &OLD), "plaintext survives after failed purge + reopen");
    }
    #[test] fn r1_purge_failure_in_watcher_is_retried_at_open() {
        let (mut v, dir, db, p) = edited_note();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        let r = block_purge(&v, &db);
        let ch = v.apply_fs_changes(&[PathBuf::from(&p), dir.join("s.md.age")], None);
        assert_eq!(ch.len(), 2);
        assert!(purge_marked(&v));
        drop(r);
        drop(v);
        let v = open(dir.clone(), &db, None).unwrap();
        assert!(!purge_marked(&v));
        assert!(!trigram_on_disk(&db, &OLD), "plaintext survives after watcher purge failure + reopen");
    }
    #[test] fn r1_reader_blocks_purge_checkpoint() {
        let (mut v, dir, db, p) = edited_note();
        let r = rusqlite::Connection::open(&db).unwrap();
        r.execute_batch("BEGIN").unwrap();
        let _: i64 = r.query_row("SELECT count(*) FROM notes_fts_data", [], |x| x.get(0)).unwrap();
        // The reader pins the old pages, so the erase can't finish yet: the mark stays and the next trigger retries.
        v.index.raw().busy_timeout(std::time::Duration::ZERO).unwrap(); // fail at once instead of waiting 5 s
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        r.execute_batch("COMMIT").unwrap();
        drop(r);
        assert!(purge_marked(&v));
        drop(v);
        let v = open(dir, &db, None).unwrap(); // retried at open
        assert!(!purge_marked(&v));
        assert!(!trigram_on_disk(&db, &OLD), "plaintext on disk after the retry");
    }
    #[test] fn failed_purge_waits_out_the_backoff_in_watcher_batches() {
        let (mut v, _dir, db, p) = edited_note();
        let r = block_purge(&v, &db);
        v.lock_note(&p, &crypto::new_identity()).unwrap(); // its purge fails
        drop(r);
        v.apply_fs_changes(&[], None);
        assert!(purge_marked(&v), "a watcher batch retried within the backoff");
        v.index.purge_pending(true).unwrap(); // open and a new lock still retry
        assert!(!purge_marked(&v));
    }

    fn r1_dump(v: &Vault) -> Vec<String> {
        let mut out = vec![];
        for q in ["SELECT path,title,mtime,size,encrypted,preview,created,modified FROM notes ORDER BY path",
                  "SELECT src,dst_folded FROM links ORDER BY 1,2", "SELECT path,tag_folded,tag_display FROM tags ORDER BY 1,2,3",
                  "SELECT path,alias_folded FROM aliases ORDER BY 1,2", "SELECT path,line,text,done,due FROM tasks ORDER BY 1,2",
                  "SELECT n.path, f.body FROM notes_fts f JOIN notes n ON n.rowid=f.rowid ORDER BY 1"] {
            let mut st = v.index.raw().prepare(q).unwrap();
            let n = st.column_count();
            let rows: Vec<String> = st.query_map([], |r| Ok((0..n).map(|k| format!("{:?}", r.get_ref(k).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(Result::unwrap).collect();
            out.extend(rows);
        }
        for w in ["alpha", "beta", "gam", "task", "zz"] {
            out.push(format!("{w}: {:?}", v.search(w, Sort::Title, 0, &[]).unwrap().hits.iter().map(|h| h.path.clone()).collect::<Vec<_>>()));
        }
        out
    }
    #[test] fn r1_reindex_matches_cold_build_and_fts_integrity() {
        let (dir, db) = setup();
        for i in 0..250 { std::fs::write(dir.join(format!("n{i}.md")), format!("---\naliases: [al{i}]\ntags: [t{}]\n---\n# n{i}\nalpha beta {i} #tag{} [[n{}]]\n- [ ] task {i} due:2026-01-0{}\n", i%7, i%5, (i+1)%250, i%9+1)).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        for i in 0..250 { std::fs::write(dir.join(format!("n{i}.md")), format!("---\ntags: [u{}]\n---\ngamma {i} #tg{} [[n{}]] zz\n- [x] task done {i}\n", i%3, i%4, (i+2)%250)).unwrap(); }
        for i in 240..250 { std::fs::remove_file(dir.join(format!("n{i}.md"))).unwrap(); }
        let t = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        for e in std::fs::read_dir(&dir).unwrap() { std::fs::File::options().append(true).open(e.unwrap().path()).unwrap().set_modified(t).unwrap(); }
        let paths = v.stale_paths().unwrap();
        assert_eq!(paths.len(), 250);
        for c in paths.chunks(100) { v.apply_fs_changes(c, None); }
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").unwrap();
        let a = r1_dump(&v);
        // downgrade emulation: 0.8.2 turns secure-delete back on and edits/deletes notes
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1)").unwrap();
        for i in 0..20 { std::fs::write(dir.join(format!("n{i}.md")), format!("gamma {i} again")).unwrap(); }
        let ps: Vec<PathBuf> = (0..20).map(|i| dir.join(format!("n{i}.md"))).collect();
        v.apply_fs_changes(&ps, None);
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").unwrap();
        let db2 = tempfile::tempdir().unwrap().keep().join("cold.sqlite");
        let cold = open(dir.clone(), &db2, None).unwrap();
        let _ = a;
        assert_eq!(r1_dump(&v), r1_dump(&cold));
    }

    /// Secret text from 4 CJK chars (3 UTF-8 bytes each): their byte patterns essentially never occur in SQLite binary data.
    const CJK: [&str; 4] = ["龍", "鷹", "鬱", "齋"];
    fn secret(seed: usize, n: usize) -> String {
        let mut x = seed as u64 * 2654435761 + 7;
        (0..n).map(|_| { x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); CJK[(x >> 33) as usize % 4] }).collect()
    }
    fn cjk_hits(db: &Path) -> Vec<(String, usize)> {
        ["", "-wal", "-shm"].iter().map(|x| {
            let b = std::fs::read(format!("{}{x}", db.display())).unwrap_or_default();
            (x.to_string(), CJK.iter().map(|c| b.windows(3).filter(|w| *w == c.as_bytes()).count()).sum())
        }).collect()
    }
    fn total(h: &[(String, usize)]) -> usize { h.iter().map(|x| x.1).sum() }

    /// Q2: long realistic history (FTS secure-delete off, big bodies with overflow pages, deletes, re-creates), then a lock.
    #[test] fn r2_long_history_then_lock_leaves_no_bytes() {
        let (dir, db) = setup();
        let filler = "lorem ipsum dolor sit amet ".repeat(120);
        for i in 0..400 { std::fs::write(dir.join(format!("filler {i}.md")), format!("filler {i} {filler}")).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        let d = v.open_or_create("s", None, false).unwrap();
        for k in 0..40 {
            let body = format!("version {k}\n- [ ] task {}\n{}\n{filler}", secret(k, 12), secret(k + 1000, 3000));
            v.save_note(&d.path, &body, &stat_hash(&d.path), None, false).unwrap();
            let fillers: Vec<PathBuf> = (0..60).map(|j| dir.join(format!("filler {}.md", (k * 60 + j) % 400))).collect();
            for f in &fillers { std::fs::write(f, format!("edited {k} {filler}")).unwrap(); }
            if k % 5 == 0 { for f in &fillers[..10] { std::fs::remove_file(f).unwrap(); } }
            v.apply_fs_changes(&fillers, None);
            if k % 5 == 0 { for f in &fillers[..10] { std::fs::write(f, format!("back {k}")).unwrap(); } v.apply_fs_changes(&fillers[..10], None); }
        }
        let before = cjk_hits(&db);
        assert!(total(&before) > 0, "control: {before:?}");
        let id = crypto::new_identity();
        v.lock_note(&d.path, &id).unwrap();
        let after = cjk_hits(&db);
        drop(v);
        let reopened = cjk_hits(&db);
        eprintln!("before {before:?} after lock {after:?} after close {reopened:?}");
        assert_eq!(total(&after), 0, "plaintext bytes after lock: {after:?}");
        assert_eq!(total(&reopened), 0);
    }
    /// Q1: a mark cleared by connection A after its rebuild hides a delete that connection B committed after that rebuild.
    #[test] fn r2_mark_clear_hides_newer_delete() {
        let (mut v, dir, db, p) = edited_note();
        let t = v.open_or_create("t", None, false).unwrap();
        v.save_note(&t.path, &format!("t {}", secret(5, 200)), &stat_hash(&t.path), None, false).unwrap();
        v.index.checkpoint().unwrap();
        let id = crypto::new_identity();
        // B: a second process (`velo --mcp` direct mode) on the same index
        assert!(total(&cjk_hits(&db)) > 0, "control");
        let mut b = open(dir.clone(), &db, None).unwrap();
        // A locks s: lock_note's steps, then purge_pending's steps one by one
        let to = dir.join("s.md.age");
        std::fs::write(&to, crypto::encrypt(&id, &std::fs::read(&p).unwrap()).unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        v.index.need_purge().unwrap();
        v.index.remove(&p).unwrap();
        v.reindex(&to, None).unwrap();
        let generation: i64 = v.index.raw().query_row("SELECT gen FROM purge_mark", [], |r| r.get(0)).unwrap();
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        // B: t was locked on another machine and synced in; B's rescan marks (no-op: already set) and deletes
        std::fs::write(dir.join("t.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        std::fs::remove_file(&t.path).unwrap();
        b.index.begin().unwrap(); // apply_chunk's steps for [t.md, t.md.age]
        b.index.need_purge().unwrap();
        b.index.remove(&t.path).unwrap();
        b.reindex(&dir.join("t.md.age"), None).unwrap();
        b.index.commit().unwrap();
        // A: checkpoint + clear
        assert_eq!(v.index.raw().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        v.index.raw().execute(crate::index::CLEAR_PURGE, [generation]).unwrap(); // a no-op: B bumped the mark
        // B: its own retry still finds the mark
        b.index.purge_pending(true).unwrap();
        drop(b);
        drop(v);
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.rescan(Some(&id));
        drop(v);
        let h = cjk_hits(&db);
        assert_eq!(total(&h), 0, "t's plaintext survives: {h:?}");
    }
    /// Q4: downgrade to 0.8.2 (FTS secure-delete on, no purge_pending), lock there, upgrade again.
    #[test] fn r2_lock_in_082_after_pr_edits_is_never_erased() {
        let (mut v, dir, db, p) = edited_note();
        drop(v);
        // 0.8.2's Index::open: secure-delete 1, ignores purge_pending; its lock_note: write .age, rm .md, remove, reindex, checkpoint
        v = open(dir.clone(), &db, None).unwrap();
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts, rank) VALUES('secure-delete', 1)").unwrap();
        let id = crypto::new_identity();
        let to = dir.join("s.md.age");
        std::fs::write(&to, crypto::encrypt(&id, &std::fs::read(&p).unwrap()).unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        v.index.remove(&p).unwrap();
        v.reindex(&to, None).unwrap();
        v.index.checkpoint().unwrap();
        drop(v);
        // upgrade back to this PR
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.rescan(Some(&id));
        let leaked = trigram_on_disk(&db, &OLD);
        v.index.need_purge().unwrap(); // control: a forced purge erases them, so the hits are real FTS remnants
        v.apply_fs_changes(&[], None);
        eprintln!("leaked after upgrade: {leaked}; after forced purge: {}", trigram_on_disk(&db, &OLD));
        drop(v);
        assert!(!leaked, "older versions of the locked note survive downgrade-lock-upgrade");
    }
    /// Q5: after a purge (FTS rebuild), the index answers exactly like a cold build.
    #[test] fn r2_rebuild_matches_cold_build() {
        let (dir, db) = setup();
        for i in 0..250 { std::fs::write(dir.join(format!("n{i}.md")), format!("---\naliases: [al{i}]\ntags: [t{}]\n---\n# n{i}\nalpha beta {i} #tag{} [[n{}]]\n- [ ] task {i} due:2026-01-0{}\n", i%7, i%5, (i+1)%250, i%9+1)).unwrap(); }
        let mut v = open(dir.clone(), &db, None).unwrap();
        for i in 0..250 { std::fs::write(dir.join(format!("n{i}.md")), format!("---\ntags: [u{}]\n---\ngamma {i} #tg{} [[n{}]] zz\n- [x] task done {i}\n", i%3, i%4, (i+2)%250)).unwrap(); }
        let ps: Vec<PathBuf> = (0..250).map(|i| dir.join(format!("n{i}.md"))).collect();
        v.apply_fs_changes(&ps, None);
        v.index.need_purge().unwrap();
        v.apply_fs_changes(&[], None);
        assert!(!purge_marked(&v));
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").unwrap();
        let db2 = tempfile::tempdir().unwrap().keep().join("cold.sqlite");
        let cold = open(dir.clone(), &db2, None).unwrap();
        assert_eq!(r1_dump(&v), r1_dump(&cold));
    }

#[test] fn r3_early_lock_mark_cleared_by_other_process() {
        let (mut v, dir, db, p) = edited_note();
        let b = open(dir.clone(), &db, None).unwrap(); // second process (`velo --mcp` direct mode)
        let now = now_ms();
        for i in 0..300 { v.revisions.snapshot_bytes("s", format!("rev {i}").as_bytes(), false, now - 100_000 + i as i64 * 10, false).unwrap(); }
        let id = crypto::new_identity();
        let (id2, p2) = (id.clone(), p.clone());
        let a = std::thread::spawn(move || { let t = std::time::Instant::now(); v.lock_note(&p2, &id2).unwrap(); eprintln!("lock_note took {:?}", t.elapsed()); v });
        // B: any watcher batch / MCP try_rescan ends with purge_pending(false); it sees A's fresh mark
        while !b.index.raw().query_row("SELECT EXISTS(SELECT 1 FROM purge_mark WHERE gen > 0)", [], |r| r.get::<_, bool>(0)).unwrap() { std::thread::yield_now(); }
        b.index.purge_pending(false).unwrap();
        let early = !purge_marked(&b) && dir.join("s.md").exists();
        let v = a.join().unwrap();
        eprintln!("B cleared A's mark while s.md still existed: {early}; mark left after lock_note: {}", purge_marked(&v));
        drop(v);
        drop(b);
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.rescan(Some(&id));
        drop(v);
        assert!(!trigram_on_disk(&db, &OLD), "locked note's plaintext survives lock + reopen + rescan");
    }
#[test] fn r3_backoff_hides_external_lock() {
        let (mut v, dir, db, p) = edited_note();
        let t = v.open_or_create("t", None, false).unwrap();
        v.save_note(&t.path, &format!("t {}", secret(9, 300)), &stat_hash(&t.path), None, false).unwrap();
        v.index.checkpoint().unwrap();
        assert!(total(&cjk_hits(&db)) > 0, "control");
        let r = block_purge(&v, &db);
        v.lock_note(&p, &crypto::new_identity()).unwrap(); // its purge fails: backoff starts
        drop(r); // the reader is gone at once
        std::fs::write(dir.join("t.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(&t.path).unwrap();
        let ch = v.apply_fs_changes(&[PathBuf::from(&t.path), dir.join("t.md.age")], None);
        let h = cjk_hits(&db);
        eprintln!("changed {ch:?}; t's plaintext after its lock was applied: {h:?}; marked {}", purge_marked(&v));
        assert_eq!(total(&h), 0, "t's plaintext stays until an event after the window, a lock, or the next open");
    }
    /// The retry timer is one per process (a static flag): tests that spawn it run one at a time.
    static TIMER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test] fn failed_purge_is_retried_when_the_backoff_ends_without_events() {
        let _t = TIMER.lock().unwrap_or_else(|e| e.into_inner());
        while crate::commands::PURGE_RETRY.load(std::sync::atomic::Ordering::SeqCst) { std::thread::yield_now(); } // the last test's thread exiting
        let (mut v, _dir, db, p) = edited_note();
        v.index.purge_backoff = std::time::Duration::from_millis(200);
        let r = block_purge(&v, &db);
        v.lock_note(&p, &crypto::new_identity()).unwrap(); // its purge fails
        drop(r);
        let wait = v.index.purge_retry_in().expect("a failed purge schedules a retry");
        assert!(wait <= std::time::Duration::from_millis(200));
        let v = std::sync::Arc::new(std::sync::Mutex::new(v));
        let v2 = v.clone();
        crate::commands::spawn_purge_retry(wait, move || v2.lock().unwrap().retry_purge()); // as the app does
        let t = std::time::Instant::now();
        while purge_marked(&v.lock().unwrap()) && t.elapsed() < std::time::Duration::from_secs(5) { std::thread::sleep(std::time::Duration::from_millis(20)); }
        assert!(!purge_marked(&v.lock().unwrap()), "no retry after the window");
        assert!(!trigram_on_disk(&db, &OLD));
    }

    fn gen_of(v: &Vault) -> Option<i64> {
        v.index.raw().query_row("SELECT gen FROM purge_mark", [], |r| r.get(0)).ok()
    }
    /// R4-1: the mark row is deleted on clear, so `gen` restarts at 1: a stale CLEAR from an older purge matches a newer mark.
    #[test] fn r4_gen_reuse_lets_old_purge_clear_newer_mark() {
        let (mut v, dir, db, p) = edited_note();
        let t = v.open_or_create("t", None, false).unwrap();
        v.save_note(&t.path, &format!("t {}", secret(7, 200)), &stat_hash(&t.path), None, false).unwrap();
        v.index.checkpoint().unwrap();
        assert!(total(&cjk_hits(&db)) > 0, "control");
        assert!(!purge_marked(&v));
        let mut b = open(dir.clone(), &db, None).unwrap(); // second process
        let id = crypto::new_identity();
        // A: lock_note's index steps (early mark, then remove_erasing), then purge's read + rebuild
        let to = dir.join("s.md.age");
        std::fs::write(&to, crypto::encrypt(&id, &std::fs::read(&p).unwrap()).unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        v.index.need_purge().unwrap();
        v.index.remove_erasing(&p).unwrap();
        v.reindex(&to, None).unwrap();
        let g = gen_of(&v).unwrap();
        v.index.raw().execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").unwrap();
        // B: a full purge completes meanwhile and deletes the row
        b.index.purge_pending(true).unwrap();
        assert!(!purge_marked(&b));
        // B: t, locked on another machine, arrives: apply_chunk's steps for [t.md, t.md.age]
        std::fs::write(dir.join("t.md.age"), crypto::encrypt(&id, b"x").unwrap()).unwrap();
        std::fs::remove_file(&t.path).unwrap();
        b.index.begin().unwrap();
        b.remove_note(&t.path).unwrap(); // remove_erasing: gen 1
        b.index.need_purge().unwrap(); // t.md.age new to the index: gen 2
        b.reindex(&dir.join("t.md.age"), None).unwrap();
        b.index.commit().unwrap();
        eprintln!("A read gen {g}; B's new mark gen {:?}", gen_of(&b));
        // A: checkpoint + CLEAR with its stale generation
        assert_eq!(v.index.raw().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let n = v.index.raw().execute(crate::index::CLEAR_PURGE, [g]).unwrap();
        eprintln!("A's stale CLEAR deleted {n} row(s); mark left: {}", purge_marked(&b));
        b.index.purge_pending(false).unwrap(); // B's batch-end purge: nothing marked
        drop(b);
        drop(v);
        let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
        v.rescan(Some(&id));
        drop(v);
        let h = cjk_hits(&db);
        assert_eq!(total(&h), 0, "t's plaintext survives lock + reopen + rescan: {h:?}");
    }
    /// R4-2: the backoff keyed on gen is fooled by the same restart: a new delete gets a failed purge's generation.
    #[test] fn r4_backoff_gen_reuse_skips_new_delete() {
        let (mut v, dir, db, p) = edited_note();
        let t = v.open_or_create("t", None, false).unwrap();
        v.save_note(&t.path, &format!("t {}", secret(9, 300)), &stat_hash(&t.path), None, false).unwrap();
        v.index.checkpoint().unwrap();
        assert!(total(&cjk_hits(&db)) > 0, "control");
        let b = open(dir.clone(), &db, None).unwrap();
        let r = block_purge(&v, &db);
        v.lock_note(&p, &crypto::new_identity()).unwrap(); // its purge fails
        let g = gen_of(&v);
        drop(r);
        b.index.purge_pending(true).unwrap(); // another process's purge succeeds and deletes the row
        std::fs::write(dir.join("t.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(&t.path).unwrap();
        v.apply_fs_changes(&[PathBuf::from(&t.path), dir.join("t.md.age")], None);
        let h = cjk_hits(&db);
        eprintln!("failed gen {g:?}, new gen {:?}; hits {h:?}; retry_in {:?}", gen_of(&v), v.index.purge_retry_in());
        assert_eq!(total(&h), 0, "t's plaintext kept for the rest of the 60 s window");
    }
    /// R4-3: with a reader that stays (default 5 s busy timeout), how long a failing purge holds the vault. Timing
    /// probe: `cargo test --lib r4_failing -- --ignored --nocapture`.
    #[test] #[ignore] fn r4_failing_purge_hold_times() {
        let (mut v, dir, db, p) = edited_note();
        let r = block_purge(&v, &db);
        v.index.raw().busy_timeout(std::time::Duration::from_secs(5)).unwrap(); // the real timeout
        let t0 = std::time::Instant::now();
        v.lock_note(&p, &crypto::new_identity()).unwrap();
        eprintln!("lock_note with a reader: {:?}", t0.elapsed());
        v.index.purge_backoff = std::time::Duration::ZERO;
        let t0 = std::time::Instant::now();
        let next = v.retry_purge();
        eprintln!("timer retry_purge with a reader: {:?}, next {next:?}", t0.elapsed());
        v.index.purge_backoff = std::time::Duration::from_secs(60);
        // three chunks, each bringing a note locked on another machine: each bumps the gen, so none is backed off
        let t0 = std::time::Instant::now();
        for k in 0..3 {
            let q = v.open_or_create(&format!("q{k}"), None, false).unwrap();
            std::fs::write(dir.join(format!("q{k}.md.age")), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
            std::fs::remove_file(&q.path).unwrap();
            let c = std::time::Instant::now();
            v.apply_fs_changes_then(&[PathBuf::from(&q.path), dir.join(format!("q{k}.md.age"))], None, k == 2); // as apply_watch
            eprintln!("chunk {k}: {:?}", c.elapsed());
        }
        eprintln!("3 chunks inside the backoff window: {:?}", t0.elapsed());
        drop(r);
    }
    /// R4-4: a retry scheduled while the timer thread is between its last retry and clearing its flag is dropped.
    #[test] fn r4_retry_scheduled_as_timer_exits_is_lost() {
        let _t = TIMER.lock().unwrap_or_else(|e| e.into_inner());
        while crate::commands::PURGE_RETRY.load(std::sync::atomic::Ordering::SeqCst) { std::thread::yield_now(); } // the last test's thread exiting
        use std::sync::atomic::{AtomicBool, Ordering};
        let ran = std::sync::Arc::new(AtomicBool::new(false));
        let r2 = ran.clone();
        crate::commands::spawn_purge_retry(std::time::Duration::ZERO, move || {
            // the last retry succeeded; a purge fails elsewhere and schedules before this thread clears PURGE_RETRY
            let r3 = r2.clone();
            crate::commands::spawn_purge_retry(std::time::Duration::ZERO, move || { r3.store(true, Ordering::SeqCst); None });
            None
        });
        std::thread::sleep(std::time::Duration::from_secs(1));
        assert!(ran.load(Ordering::SeqCst), "the second schedule never ran");
    }
    /// R4-5: both twins indexed (a sync conflict); the .age is briefly absent (rewritten by unlink + create, as git
    /// checkout does) when the plain twin's delete is checked; the .age then reappears with its row still indexed.
    #[test] fn r4_twin_gap_deletes_plain_without_mark() {
        let (mut v, dir, db, p) = edited_note();
        let age = dir.join("s.md.age");
        std::fs::write(&age, crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        v.apply_fs_changes(&[age.clone()], None); // new locked note: purges the old versions; s.md stays live
        assert!(!purge_marked(&v));
        assert!(trigram_on_disk(&db, &OLD[2..]), "control: s.md's current text is a live row");
        // one batch [s.md, s.md.age]: s.md deleted, s.md.age rewritten with a gap
        std::fs::remove_file(&age).unwrap();
        std::fs::remove_file(&p).unwrap();
        v.index.begin().unwrap();
        let mut changed = Vec::new();
        v.apply_chunk(&[PathBuf::from(&p)], None, true, &mut changed);
        std::fs::write(&age, crypto::encrypt(&crypto::new_identity(), b"y").unwrap()).unwrap();
        v.apply_chunk(&[age.clone()], None, true, &mut changed);
        v.index.commit().unwrap();
        v.purge_pending(false);
        eprintln!("marked after the batch: {}", purge_marked(&v));
        drop(v);
        let mut v = open(dir.clone(), &db, None).unwrap();
        v.rescan(None);
        drop(v);
        assert!(!trigram_on_disk(&db, &OLD[2..]), "the locked note's plaintext survives batch + reopen + rescan");
    }
    #[test] fn only_the_last_chunk_purges() {
        let (mut v, dir, _db, p) = edited_note();
        std::fs::write(dir.join("s.md.age"), crypto::encrypt(&crypto::new_identity(), b"x").unwrap()).unwrap();
        std::fs::remove_file(&p).unwrap();
        v.apply_fs_changes_then(&[PathBuf::from(&p), dir.join("s.md.age")], None, false);
        assert!(purge_marked(&v), "a chunk before the last purged");
        v.apply_fs_changes_then(&[], None, true);
        assert!(!purge_marked(&v));
    }
}
