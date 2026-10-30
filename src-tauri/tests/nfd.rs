//! HFS+ and SMB store file names decomposed (NFD) while velo builds paths from the NFC title the webview sends.
//! macOS only: elsewhere the two spellings are two different files.
#![cfg(target_os = "macos")]
use std::path::Path;
use velo_lib::index::Sort;
use velo_lib::vault::Vault;

fn titles(v: &Vault) -> Vec<String> {
    v.search("", Sort::Title, 0, &[]).unwrap().hits.into_iter().map(|h| h.title).collect()
}

#[test]
fn nfd_file_name_is_one_note() {
    // a plain folder, and one whose own name is NFD (an HFS+ or SMB volume): the folder part must stay as given
    for folder in ["notes", "Universita\u{301}"] {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(folder);
        std::fs::create_dir(&dir).unwrap();
        let mut v = Vault::open_with_progress(dir.clone(), &tmp.path().join("index.db"), None, &mut |_, _| {}).unwrap();
        // velo creates the note under the NFC name...
        let nfc = v.create_from_selection("Caf\u{e9}", "hello", false).unwrap();
        // ...and the volume lists it decomposed, as HFS+ does
        let nfd = dir.join("Cafe\u{301}.md");
        std::fs::rename(dir.join("Caf\u{e9}.md"), &nfd).unwrap();
        v.rescan(None);
        // the editor still holds the path velo gave it and saves through it
        let doc = v.open_note(&nfc, None).unwrap();
        v.save_note(&nfc, "hello again", &doc.hash, None, false).unwrap();
        // the watcher reports the save under the NFD name: still velo's own write
        assert!(v.apply_fs_changes(&[nfd.clone()], None).is_empty(), "{folder}");
        v.rescan(None);
        assert_eq!(titles(&v).len(), 1, "{folder}: {:?}", titles(&v));
        // opening by either spelling finds the one note
        assert!(v.find_note("Caf\u{e9}").unwrap().is_some() && v.find_note("Cafe\u{301}").unwrap().is_some());
        assert!(!Path::new(&nfd).with_file_name("Caf\u{e9} 2.md").exists());
        assert_eq!(v.list_revisions(&nfc).unwrap().len(), 1, "{folder}");
    }
}
