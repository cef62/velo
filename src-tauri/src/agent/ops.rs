//! Note operations the MCP tools run on. `DirectOps` works on the notes folder itself (velo closed); Task 7 adds the
//! forwarding implementation. Locked notes (`*.md.age`) never come out of here, and no identity is ever passed.
use crate::index::{Page, Sort, TagCount};
use crate::names::{note_path, parse_note_file};
use crate::settings::{self, Settings};
use crate::store::SaveResult;
use crate::tasks::TaskView;
use crate::vault::{NoteDoc, Vault};
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
    vault: Vault,
    settings_path: PathBuf,
}

impl DirectOps {
    pub fn open(dir: PathBuf, db_path: &Path, settings_path: PathBuf) -> anyhow::Result<DirectOps> {
        Ok(DirectOps { vault: Vault::open_with_progress(dir, db_path, None, &mut |_, _| {})?, settings_path })
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

    fn write(&mut self, path: &str, new_text: &str, base_hash: &str, _summary: &str) -> anyhow::Result<String> {
        // Task 3 takes the agent snapshot (with `summary`) here, before the save.
        let wfm = self.settings().write_front_matter;
        match self.vault.save_note(plain(path)?, new_text, base_hash, None, wfm)? {
            SaveResult::Saved { hash, .. } => Ok(hash),
            SaveResult::Conflict { conflict_path, .. } => Err(anyhow!("conflict: saved to {}", title_of(&conflict_path))),
        }
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
        self.write(&doc.path, text, &doc.hash, summary)?;
        self.read(&doc.path)
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

    fn rename(&mut self, path: &str, new_title: &str, rewrite_links: bool, _summary: &str) -> anyhow::Result<String> {
        Ok(self.vault.rename_note(plain(path)?, new_title, rewrite_links)?.path)
    }

    fn trash(&mut self, path: &str, _summary: &str) -> anyhow::Result<()> {
        self.vault.delete_note(plain(path)?)
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
