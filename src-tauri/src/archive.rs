//! The archived-notes list: `<notes folder>/.velo/archived`, one title per line.
use crate::text::fold;
use std::io::{Error, ErrorKind, Result};
use std::path::Path;

pub const FILE: &str = ".velo/archived";

pub fn parse(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .map(|l| l.strip_prefix('\u{feff}').unwrap_or(l)) // also mid-file: two BOM files joined by a sync tool
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

/// Keeps the first of entries that fold the same.
fn dedupe(v: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|t| seen.insert(fold(t)));
}

pub fn read(dir: &Path) -> Result<Vec<String>> {
    let bytes = match std::fs::read(dir.join(FILE)) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut v = parse(&String::from_utf8_lossy(&bytes));
    dedupe(&mut v);
    Ok(v)
}

pub fn update(dir: &Path, change: impl FnOnce(&mut Vec<String>)) -> Result<Vec<String>> {
    let before = read(dir)?;
    let mut now = before.clone();
    change(&mut now);
    if let Some(bad) = now.iter().find(|t| !before.contains(t) && (t.is_empty() || t.contains('\n') || t.ends_with('\r') || t.starts_with('\u{feff}'))) {
        return Err(Error::new(ErrorKind::InvalidInput, format!("title cannot be archived: {bad:?}")));
    }
    dedupe(&mut now);
    if now == before {
        return Ok(now);
    }
    let path = dir.join(FILE);
    std::fs::create_dir_all(path.parent().expect("FILE has a parent"))?;
    let tmp = dir.join(format!("{FILE}.{}.tmp", std::process::id()));
    let put = std::fs::write(&tmp, now.iter().map(|t| format!("{t}\n")).collect::<String>()).and_then(|()| std::fs::rename(&tmp, path));
    if let Err(e) = put {
        std::fs::remove_file(&tmp).ok(); // no stray temp file after a failed write or rename
        return Err(e);
    }
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn read_missing_is_empty() { let d = tempfile::tempdir().unwrap(); assert_eq!(read(d.path()).unwrap(), Vec::<String>::new()); }
    #[test] fn read_parses_bom_crlf_and_keeps_spaces() {
        assert_eq!(parse("\u{feff}meeting notes\r\n\nFoo \n \nBar"), ["meeting notes", "Foo ", " ", "Bar"]);
        let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(FILE), b"A\n\xff\xfe\nB\n").unwrap(); // a bad byte: lossy, never an error
        assert_eq!(read(d.path()).unwrap(), ["A", "\u{fffd}\u{fffd}", "B"]);
    }
    #[test] fn update_creates_file_and_dir() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(update(d.path(), |e| e.push("A".into())).unwrap(), ["A"]);
        assert_eq!(std::fs::read_to_string(d.path().join(FILE)).unwrap(), "A\n");
        assert_eq!(std::fs::read_dir(d.path().join(".velo")).unwrap().count(), 1); // no temp file left
    }
    #[test] fn read_dedupes_by_fold() {
        let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(FILE), "Foo\nfoo\nFOO\nBar\n").unwrap();
        assert_eq!(read(d.path()).unwrap(), ["Foo", "Bar"]);
    }
    #[test] fn malformed_existing_entries_never_block_a_write() {
        let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(FILE), "Foo\r\r\n").unwrap(); // parsed as "Foo\r", normalised on the next write
        update(d.path(), |e| e.push("Bar".into())).unwrap(); // an unrelated archive
        update(d.path(), |e| { e.retain(|t| t != "Bar"); e.push("Baz".into()) }).unwrap(); // a rename
        assert_eq!(read(d.path()).unwrap(), ["Foo", "Baz"]);
    }
    #[test] fn a_bom_on_any_line_is_stripped() {
        assert_eq!(parse("\u{feff}A\n\u{feff}B\n"), ["A", "B"]);
        let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(FILE), "\u{feff}A\n\u{feff}B\n").unwrap();
        assert_eq!(update(d.path(), |e| e.retain(|t| t != "A")).unwrap(), ["B"]);
        assert_eq!(read(d.path()).unwrap(), ["B"]);
    }
    #[test] fn update_refuses_titles_with_line_breaks() {
        let d = tempfile::tempdir().unwrap();
        for bad in ["", "A\nB", "A\r", "\u{feff}A"] {
            let e = update(d.path(), |e| e.push(bad.into())).unwrap_err();
            assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
        }
        assert!(!d.path().join(".velo").exists());
    }
    #[test] fn update_keeps_unknown_and_drops_duplicate_entries() {
        let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
        std::fs::write(d.path().join(FILE), "Gone\nA\na\n").unwrap();
        assert_eq!(update(d.path(), |e| e.push("B".into())).unwrap(), ["Gone", "A", "B"]);
    }
    #[test] fn update_without_change_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        assert!(update(d.path(), |_| {}).unwrap().is_empty());
        assert!(!d.path().join(".velo").exists());
    }
    #[test] fn update_rereads_the_file() { // another process's entry, written after our last read, survives our write
        let d = tempfile::tempdir().unwrap();
        update(d.path(), |e| e.push("A".into())).unwrap();
        std::fs::write(d.path().join(FILE), "A\nB\n").unwrap();
        assert_eq!(update(d.path(), |e| e.retain(|t| t != "A")).unwrap(), ["B"]);
    }
}
