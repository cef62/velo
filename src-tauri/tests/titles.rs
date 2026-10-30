//! A `]` in a title would end every `[[link]]` to it early: titles from the user may not contain one.
use velo_lib::vault::Vault;

#[test]
fn closing_bracket_refused_on_create_and_rename() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("notes");
    std::fs::create_dir(&dir).unwrap();
    // an existing file with `]` keeps working
    std::fs::write(dir.join("Old]x.md"), "hi").unwrap();
    let mut v = Vault::open_with_progress(dir.clone(), &tmp.path().join("index.db"), None, &mut |_, _| {}).unwrap();
    assert_eq!(v.create_from_selection("Plan]v2", "x", false).unwrap_err().to_string(), "invalid-title");
    let p = v.create_from_selection("Plan", "x", false).unwrap();
    assert_eq!(v.rename_note(&p, "Plan]v2", true).err().unwrap().to_string(), "invalid-title");
    assert!(dir.join("Plan.md").exists());
    let old = v.find_note("Old]x").unwrap().unwrap();
    assert!(old.ends_with("Old]x.md"));
    assert_eq!(v.rename_note(&old, "Old y", false).unwrap().path, dir.join("Old y.md").to_string_lossy());
}
