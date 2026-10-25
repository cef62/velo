use std::path::{Path, PathBuf};

pub struct NoteFile {
    pub title: String,
    pub encrypted: bool,
}

pub fn title_to_stem(title: &str) -> String {
    let mut s: String = title
        .trim()
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let mut end = s.len().min(200);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    let s = s.trim_end_matches(['.', ' ']);
    if s.is_empty() { "Untitled".into() } else { s.into() }
}

pub fn note_path(dir: &Path, title: &str, encrypted: bool) -> PathBuf {
    let ext = if encrypted { "md.age" } else { "md" };
    dir.join(format!("{}.{ext}", title_to_stem(title)))
}

pub fn parse_note_file(path: &Path) -> Option<NoteFile> {
    let name = path.file_name()?.to_str()?;
    if name.starts_with('.') {
        return None;
    }
    let (title, encrypted) = [(".md.age", true), (".md", false), (".txt", false)]
        .iter()
        .find_map(|(ext, enc)| name.strip_suffix(ext).map(|t| (t, *enc)))?;
    Some(NoteFile { title: title.into(), encrypted })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn stem_replaces_illegal() { assert_eq!(title_to_stem("a/b:c*?\"<>|d"), "a-b-c------d"); }
    #[test] fn stem_trims_dots_spaces() { assert_eq!(title_to_stem("  notes. . "), "notes"); }
    #[test] fn stem_empty_is_untitled() { assert_eq!(title_to_stem(" / "), "-"); assert_eq!(title_to_stem("   "), "Untitled"); }
    #[test] fn stem_truncates_on_char_boundary() { let s = title_to_stem(&"é".repeat(150)); assert!(s.len() <= 200); assert!(s.chars().all(|c| c == 'é')); }
    #[test] fn parse_variants() {
        assert_eq!(parse_note_file(Path::new("/n/Foo.md")).map(|n| (n.title, n.encrypted)), Some(("Foo".into(), false)));
        assert_eq!(parse_note_file(Path::new("/n/Foo.md.age")).map(|n| (n.title, n.encrypted)), Some(("Foo".into(), true)));
        assert_eq!(parse_note_file(Path::new("/n/Foo.txt")).map(|n| n.title), Some("Foo".into()));
        assert!(parse_note_file(Path::new("/n/.hidden.md")).is_none());
        assert!(parse_note_file(Path::new("/n/img.png")).is_none());
    }
    #[test] fn note_path_ext() { assert_eq!(note_path(Path::new("/n"), "a/b", true), PathBuf::from("/n/a-b.md.age")); }
}
