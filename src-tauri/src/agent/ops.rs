//! Note operations the MCP tools run on. `DirectOps` works on the notes folder itself (velo closed); Task 7 adds the
//! forwarding implementation. Locked notes (`*.md.age`) never come out of here, and no identity is ever passed.
use crate::index::{Page, Sort, TagCount};
use crate::names::{note_path, parse_note_file};
use crate::settings::{self, Settings};
use crate::store::SaveResult;
use crate::tasks::TaskView;
use crate::vault::{NoteDoc, Toggled, Vault};
use anyhow::anyhow;
use std::path::{Path, PathBuf};

/// Search results per page.
pub const PAGE: usize = 50;

pub trait NoteOps {
    /// Path of the plain note `title` names (title or alias, case-folded).
    fn find(&self, title: &str) -> anyhow::Result<Option<String>>;
    fn read(&mut self, path: &str) -> anyhow::Result<NoteDoc>;
    /// Saves `new_text` if the file still hashes to `base_hash`; returns the new hash.
    fn write(&mut self, path: &str, new_text: &str, base_hash: &str, summary: &str) -> anyhow::Result<String>;
    fn create(&mut self, title: &str, text: &str, summary: &str) -> anyhow::Result<NoteDoc>;
    /// Up to `PAGE` plain hits starting at plain hit `offset`.
    fn search(&self, query: &str, tags: &[String], offset: usize) -> anyhow::Result<Page>;
    fn tags(&self) -> anyhow::Result<Vec<TagCount>>;
    fn tasks(&self, query: &str, tags: &[String], show_done: bool) -> anyhow::Result<TaskView>;
    /// Returns the new path.
    fn rename(&mut self, path: &str, new_title: &str, rewrite_links: bool, summary: &str) -> anyhow::Result<String>;
    fn trash(&mut self, path: &str, summary: &str) -> anyhow::Result<()>;
    /// Flips the task at `line` (checked against `expected`); snapshots first.
    fn toggle_task(&mut self, path: &str, line: usize, expected: &str, summary: &str) -> anyhow::Result<Toggled>;
    /// Appends `- [ ] text` to the plain note `title` (created if missing); returns its path.
    fn capture_task(&mut self, title: &str, text: &str, summary: &str) -> anyhow::Result<String>;
    /// The plain note `title`; a missing one is created from no template (only the stamped front matter).
    fn open_or_create(&mut self, title: &str) -> anyhow::Result<NoteDoc>;
    /// Agent snapshot of the note's current text (for a note just created).
    fn snapshot(&mut self, path: &str, summary: &str) -> anyhow::Result<()>;
    fn settings(&self) -> Settings;
    /// Tags of one plain note (for search results).
    fn note_tags(&self, path: &str) -> anyhow::Result<Vec<String>>;
    /// Titles of plain notes linking to `title`.
    fn backlinks(&self, title: &str) -> anyhow::Result<Vec<String>>;
}

pub fn locked(path: &str) -> bool {
    path.ends_with(".md.age")
}

fn title_of(path: &str) -> String {
    parse_note_file(Path::new(path)).map(|n| n.title).unwrap_or_else(|| path.to_string())
}

/// Refuses a locked path with the same error as a missing note, so the lock is not revealed.
fn plain(path: &str) -> anyhow::Result<&str> {
    if locked(path) { Err(anyhow!("not found")) } else { Ok(path) }
}

pub struct DirectOps {
    pub(crate) vault: Vault,
    settings_path: PathBuf,
    /// Real OS Trash; tests swap it for a plain remove.
    pub(crate) remove: fn(&Path) -> std::io::Result<()>,
}

impl DirectOps {
    pub fn open(dir: PathBuf, db_path: &Path, settings_path: PathBuf) -> anyhow::Result<DirectOps> {
        Ok(DirectOps { vault: Vault::open_with_progress(dir, db_path, None, &mut |_, _| {})?, settings_path, remove: crate::vault::move_to_trash })
    }

    /// Catch up with outside changes since the last call (mtime/size diff, as the app does after missed events).
    pub fn rescan(&mut self) {
        self.vault.rescan(None);
    }

    fn save(&mut self, path: &str, text: &str, base_hash: &str) -> anyhow::Result<String> {
        let wfm = self.settings().write_front_matter;
        match self.vault.save_note(path, text, base_hash, None, wfm)? {
            SaveResult::Saved { hash, .. } => Ok(hash),
            SaveResult::Conflict { conflict_path, .. } => Err(anyhow!("conflict: saved to {}", title_of(&conflict_path))),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.vault.store.dir
    }
}

impl NoteOps for DirectOps {
    fn find(&self, title: &str) -> anyhow::Result<Option<String>> {
        Ok(self.vault.find_note(title)?.filter(|p| !locked(p)))
    }

    fn read(&mut self, path: &str) -> anyhow::Result<NoteDoc> {
        self.vault.open_note(plain(path)?, None)
    }

    fn write(&mut self, path: &str, new_text: &str, base_hash: &str, summary: &str) -> anyhow::Result<String> {
        let path = plain(path)?;
        // a conflicting save leaves one extra identical snapshot: harmless
        self.vault.agent_snapshot(path, summary)?;
        self.save(path, new_text, base_hash)
    }

    fn create(&mut self, title: &str, text: &str, summary: &str) -> anyhow::Result<NoteDoc> {
        if title.trim().is_empty() {
            return Err(anyhow!("title is empty"));
        }
        let dir = self.dir().to_path_buf();
        // any match (a locked one too, or a file the index has not seen) would otherwise be overwritten or shadowed
        if self.vault.find_note(title)?.is_some() || note_path(&dir, title, false).exists() || note_path(&dir, title, true).exists() {
            return Err(anyhow!("a note with that title already exists"));
        }
        let doc = self.vault.open_or_create(title, None, self.settings().write_front_matter)?;
        self.save(&doc.path, text, &doc.hash)?; // the new stub is not snapshotted: the created text is the first revision
        let doc = self.read(&doc.path)?;
        self.vault.agent_snapshot_text(&doc.path, &doc.text, summary)?;
        Ok(doc)
    }

    fn search(&self, query: &str, tags: &[String], offset: usize) -> anyhow::Result<Page> {
        let sort = if self.settings().sort == "title" { Sort::Title } else { Sort::Modified };
        let (mut hits, mut skip, mut at) = (Vec::new(), offset, 0);
        // `offset` counts plain hits, so walk the vault's pages from the start, dropping locked ones
        loop {
            let p = self.vault.search(query, sort, at, tags)?;
            let (more, n) = (p.has_more, p.hits.len());
            at += n;
            for h in p.hits.into_iter().filter(|h| !locked(&h.path)) {
                if skip > 0 { skip -= 1 } else { hits.push(h) }
            }
            if hits.len() > PAGE || !more || n == 0 {
                break;
            }
        }
        let has_more = hits.len() > PAGE;
        hits.truncate(PAGE);
        Ok(Page { hits, has_more, total: 0 })
    }

    fn tags(&self) -> anyhow::Result<Vec<TagCount>> {
        // already plain-only: locked notes' bodies (and so their tags) never reach the index
        self.vault.tags()
    }

    fn tasks(&self, query: &str, tags: &[String], show_done: bool) -> anyhow::Result<TaskView> {
        let mut v = self.vault.tasks(query, tags, show_done)?;
        for g in [&mut v.overdue, &mut v.today, &mut v.upcoming, &mut v.no_date, &mut v.done] {
            g.retain(|t| !locked(&t.path));
        }
        v.due_count = v.overdue.len() + v.today.len();
        Ok(v)
    }

    fn rename(&mut self, path: &str, new_title: &str, rewrite_links: bool, summary: &str) -> anyhow::Result<String> {
        let path = plain(path)?;
        self.vault.agent_snapshot(path, summary)?;
        Ok(self.vault.rename_note(path, new_title, rewrite_links)?.path)
    }

    fn trash(&mut self, path: &str, summary: &str) -> anyhow::Result<()> {
        let path = plain(path)?;
        self.vault.agent_snapshot(path, summary)?;
        self.vault.delete_note_with(path, self.remove)
    }

    fn toggle_task(&mut self, path: &str, line: usize, expected: &str, summary: &str) -> anyhow::Result<Toggled> {
        let path = plain(path)?;
        self.vault.agent_snapshot(path, summary)?;
        let wfm = self.settings().write_front_matter;
        self.vault.toggle_task(path, line, expected, None, wfm)
    }

    fn capture_task(&mut self, title: &str, text: &str, summary: &str) -> anyhow::Result<String> {
        let wfm = self.settings().write_front_matter;
        match self.vault.find_note(title)? {
            Some(p) if locked(&p) => return Err(anyhow!("not found")),
            Some(p) => self.vault.agent_snapshot(&p, summary)?,
            None => {}
        }
        let existed = self.vault.find_note(title)?.is_some();
        let path = self.vault.capture_task(title, text, None, wfm)?;
        if !existed {
            self.vault.agent_snapshot(&path, summary)?; // a created note's first revision is its created text
        }
        Ok(path)
    }

    fn open_or_create(&mut self, title: &str) -> anyhow::Result<NoteDoc> {
        if self.vault.find_note(title)?.is_some_and(|p| locked(&p)) {
            return Err(anyhow!("not found"));
        }
        let wfm = self.settings().write_front_matter;
        self.vault.open_or_create(title, None, wfm)
    }

    fn snapshot(&mut self, path: &str, summary: &str) -> anyhow::Result<()> {
        self.vault.agent_snapshot(plain(path)?, summary)
    }

    fn settings(&self) -> Settings {
        settings::load(&self.settings_path)
    }

    fn note_tags(&self, path: &str) -> anyhow::Result<Vec<String>> {
        self.vault.index.tags_of(plain(path)?)
    }

    fn backlinks(&self, title: &str) -> anyhow::Result<Vec<String>> {
        Ok(self.vault.index.backlinks(title)?.iter().filter(|p| !locked(p)).map(|p| title_of(p)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops() -> (DirectOps, PathBuf) {
        let t = tempfile::tempdir().unwrap().keep();
        let dir = t.join("notes");
        std::fs::create_dir_all(&dir).unwrap();
        (DirectOps::open(dir.clone(), &t.join("i.sqlite"), t.join("settings.json")).unwrap(), dir)
    }

    #[test] fn created_note_has_first_revision() {
        let (mut o, _) = ops();
        let d = o.create("Fresh", "hello", "made it").unwrap();
        let r = o.vault.list_revisions(&d.path).unwrap();
        // save_note's own throttled snapshot of the empty front-matter stub may sit below it
        assert_eq!((r[0].summary.as_deref(), r[0].agent), (Some("made it"), true));
        assert!(o.vault.read_revision(&d.path, &r[0].id, None).unwrap().contains("hello"));
    }
    #[test] fn agent_write_snapshots_previous_text_with_summary() {
        let (mut o, _) = ops();
        let d = o.create("W", "v1", "c").unwrap();
        let h = o.write(&d.path, "v2", &d.hash, "edit one").unwrap();
        o.write(&d.path, "v3", &h, "edit two").unwrap();
        let r = o.vault.list_revisions(&d.path).unwrap();
        assert_eq!(r.iter().filter_map(|x| x.summary.as_deref()).collect::<Vec<_>>(), ["edit two", "edit one", "c"]);
    }
    #[test] fn rename_snapshots_under_new_title() {
        let (mut o, _) = ops();
        let d = o.create("Before", "body", "c").unwrap();
        let np = o.rename(&d.path, "After", false, "renamed it").unwrap();
        let r = o.vault.list_revisions(&np).unwrap();
        assert!(r.iter().any(|x| x.summary.as_deref() == Some("renamed it")));
    }
    #[test] fn trash_keeps_revisions_with_summary() {
        let (mut o, dir) = ops();
        o.remove = |p| std::fs::remove_file(p); // real trash would hit the OS Trash
        let d = o.create("T", "bye", "c").unwrap();
        o.trash(&d.path, "trashed").unwrap();
        assert!(!dir.join("T.md").exists());
        let r = o.vault.list_revisions(&d.path).unwrap();
        assert_eq!(r[0].summary.as_deref(), Some("trashed"));
    }
    #[test] fn agent_snapshot_refuses_locked() {
        let (mut o, dir) = ops();
        let p = dir.join("L.md.age").to_string_lossy().into_owned();
        assert!(o.vault.agent_snapshot(&p, "x").is_err());
    }
}
