use std::collections::HashMap;
use std::time::Instant;
use velo_lib::index::{Index, Meta, Sort};
use velo_lib::names::parse_note_file;
use velo_lib::tasks::group_tasks;

const QUERIES: [&str; 24] = [
    "a", "x", "xy", "al", "zu", "alp", "cha", "the", "golf", "tango", "résumé", "resume", "kubernetes",
    "release bug", "garden budget", "rust tauri", "#work", "meeting project", "nomatchzz", "qqq", "de", "café",
    "server deploy kubernetes", "9999",
];

#[test]
#[ignore]
fn search_p95_under_50ms() {
    let dir = std::env::var("VELO_FIXTURE").unwrap_or_else(|_| "../fixtures/notes".into());
    let tmp = tempfile::tempdir().unwrap();
    let mut idx = Index::open(&tmp.path().join("index.db")).unwrap();
    let build = Instant::now();
    let mut n = 0;
    idx.begin().unwrap();
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_none_or(|x| x != "md") {
            continue;
        }
        let nf = parse_note_file(&p).unwrap();
        let body = std::fs::read_to_string(&p).unwrap();
        let meta = Meta { mtime: n, size: body.len() as u64, birth: 0 };
        idx.upsert(p.file_name().unwrap().to_str().unwrap(), &nf, &meta, Some(&body)).unwrap();
        n += 1;
    }
    idx.commit().unwrap();
    println!("cold build of {n} notes: {:.1} s", build.elapsed().as_secs_f64());
    assert!(n > 0, "no fixture notes in {dir}");
    let none = HashMap::new();
    for sort in [Sort::Modified, Sort::Title] {
        // (label, offset override: None = page 0; Some(f) = deep offset for the query)
        for (label, deep) in [("page 0", false), ("deep", true)] {
            let mut times = Vec::new();
            for q in QUERIES.into_iter().chain([""]) {
                let off = match (deep, q) {
                    (false, _) => 0,
                    (true, "") => 5000,
                    (true, "the") => 1000,
                    (true, _) => continue,
                };
                for _ in 0..10 {
                    let t = Instant::now();
                    idx.search_page(q, sort, off, 200, &[], &none).unwrap(); // offset 0 includes the total count
                    times.push(t.elapsed().as_secs_f64() * 1000.0);
                }
            }
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let (p50, p95) = (times[times.len() / 2], times[times.len() * 95 / 100]);
            println!("{n} notes {sort:?} {label}: p50 {p50:.2} ms, p95 {p95:.2} ms, max {:.2} ms", times[times.len() - 1]);
            assert!(p95 < 50.0, "{sort:?} {label} p95 {p95:.2} ms");
        }
    }
    // Tag filters: wide single tag on an empty query, and two tags with a text query.
    for (sort, q, tags) in [(Sort::Title, "", vec!["work"]), (Sort::Modified, "garden", vec!["work", "ideas"]), (Sort::Title, "", vec!["work", "ideas"])] {
        let tags: Vec<String> = tags.into_iter().map(String::from).collect();
        let mut times = Vec::new();
        for _ in 0..30 {
            let t = Instant::now();
            idx.search_page(q, sort, 0, 200, &tags, &none).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = times[times.len() * 95 / 100];
        println!("{n} notes {sort:?} q={q:?} tags={tags:?}: p50 {:.2} ms, p95 {p95:.2} ms", times[times.len() / 2]);
        assert!(p95 < 50.0, "tag filter {tags:?} p95 {p95:.2} ms");
    }
    // Tasks view: read every row, then group, as Vault::tasks does.
    let mut times = Vec::new();
    for _ in 0..30 {
        let t = Instant::now();
        let v = group_tasks(idx.task_rows(&[]).unwrap(), "", true, "2026-10-27");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(v.no_date.len() + v.upcoming.len() + v.today.len() + v.overdue.len() > 0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = times[times.len() * 95 / 100];
    println!("{n} notes tasks view: p50 {:.2} ms, p95 {p95:.2} ms", times[times.len() / 2]);
    assert!(p95 < 50.0, "tasks view p95 {p95:.2} ms");
}

/// Bytes this process has written to disk so far (macOS `proc_pid_rusage`).
#[cfg(target_os = "macos")]
fn bytes_written() -> u64 {
    let mut ri: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, &mut ri as *mut _ as *mut libc::rusage_info_t) };
    assert_eq!(rc, 0, "proc_pid_rusage failed");
    ri.ri_diskio_byteswritten
}

/// Counts the whole process: run alone (`--test-threads=1` or by name) so other tests don't add to it.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn cold_build_disk_writes() {
    let dir = std::env::var("VELO_FIXTURE").unwrap_or_else(|_| "../fixtures/notes".into());
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("index.db");
    let (before, t) = (bytes_written(), Instant::now());
    let v = velo_lib::vault::Vault::open_with_progress(dir.into(), &db, None, &mut |_, _| {}).unwrap();
    let secs = t.elapsed().as_secs_f64();
    drop(v); // closing the last connection checkpoints the WAL into the main file
    let mb = (bytes_written() - before) as f64 / 1e6;
    let file = std::fs::metadata(&db).unwrap().len() as f64 / 1e6;
    println!("cold build: {mb:.0} MB written in {secs:.1} s, index {file:.0} MB");
}

/// Rescan after every note changed on disk (a `git checkout` or sync): re-indexes notes already in the index, which
/// replaces their rows. Runs it as one call (`velo --mcp`) and as the app does (stale paths, then chunks of 100 with
/// the vault mutex released between them), printing the longest hold.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn reindex_existing_notes() {
    let src = std::env::var("VELO_FIXTURE").unwrap_or_else(|_| "../fixtures/notes".into());
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("notes");
    std::fs::create_dir(&dir).unwrap();
    for e in std::fs::read_dir(&src).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_some_and(|x| x == "md") {
            std::fs::copy(&p, dir.join(p.file_name().unwrap())).unwrap();
        }
    }
    let db = tmp.path().join("index.db");
    let mut v = velo_lib::vault::Vault::open_with_progress(dir.clone(), &db, None, &mut |_, _| {}).unwrap();
    let touch = |secs| {
        let t = std::time::SystemTime::now() + std::time::Duration::from_secs(secs);
        for e in std::fs::read_dir(&dir).unwrap() {
            std::fs::File::options().append(true).open(e.unwrap().path()).unwrap().set_modified(t).unwrap();
        }
    };
    touch(60);
    let (before, t) = (bytes_written(), Instant::now());
    let n = v.rescan(None).len();
    let mb = (bytes_written() - before) as f64 / 1e6;
    println!("rescan of {n} existing notes, one call: {:.1} s, {mb:.0} MB written", t.elapsed().as_secs_f64());
    assert!(n > 0, "no fixture notes in {src}");
    touch(120);
    let (before, t) = (bytes_written(), Instant::now());
    let paths = v.stale_paths().unwrap();
    let mut longest = t.elapsed().as_secs_f64();
    for chunk in paths.chunks(100) {
        let c = Instant::now();
        v.apply_fs_changes(chunk, None);
        longest = longest.max(c.elapsed().as_secs_f64());
    }
    let mb = (bytes_written() - before) as f64 / 1e6;
    println!("rescan of {} notes in chunks of 100: {:.1} s, {mb:.0} MB written, longest hold {:.0} ms", paths.len(), t.elapsed().as_secs_f64(), longest * 1000.0);
    let wal = std::fs::metadata(format!("{}-wal", db.display())).map_or(0, |m| m.len());
    println!("WAL after: {:.1} MB, index {:.0} MB", wal as f64 / 1e6, std::fs::metadata(&db).unwrap().len() as f64 / 1e6);
    // Deleted entries stay in the FTS index until merged: search must stay fast after re-indexing.
    let mut times = Vec::new();
    for q in QUERIES {
        let t = Instant::now();
        v.search(q, Sort::Modified, 0, &[]).unwrap();
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("search after re-index: p50 {:.2} ms, max {:.2} ms", times[times.len() / 2], times[times.len() - 1]);
    // Locking erases the deleted text from the whole FTS index (`Index::purge`): its cost grows with the vault.
    let (before, t) = (bytes_written(), Instant::now());
    v.lock_note(&paths[0].to_string_lossy(), &velo_lib::crypto::new_identity()).unwrap();
    println!("lock one note: {:.0} ms, {:.0} MB written", t.elapsed().as_secs_f64() * 1000.0, (bytes_written() - before) as f64 / 1e6);
}
