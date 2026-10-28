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

/// Search p50 / p95 / max (ms) over every query, 10 runs each, as the app searches.
#[cfg(target_os = "macos")]
fn search_times(v: &velo_lib::vault::Vault) -> (f64, f64, f64) {
    let mut times = Vec::new();
    for q in QUERIES {
        for _ in 0..10 {
            let t = Instant::now();
            v.search(q, Sort::Modified, 0, &[]).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (times[times.len() / 2], times[times.len() * 95 / 100], times[times.len() - 1])
}

/// Rescan after every note changed on disk (a `git checkout` or sync): re-indexes notes already in the index, which
/// replaces their rows. Runs it as the app does (stale paths, a bulk re-index in chunks of 700 with the vault mutex
/// released between them), printing the longest hold, then search times and the cost of locking one note.
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
    let (p50, p95, max) = search_times(&v);
    println!("search after cold build: p50 {p50:.1} ms, p95 {p95:.1} ms, max {max:.1} ms");
    let mut paths = vec![];
    // round 4: a note is locked before chunk 2 (its rebuild ends the bulk; the next chunk starts it again)
    for round in 1..=4 {
        let t = std::time::SystemTime::now() + std::time::Duration::from_secs(60 * round);
        for e in std::fs::read_dir(&dir).unwrap() {
            std::fs::File::options().append(true).open(e.unwrap().path()).unwrap().set_modified(t).unwrap();
        }
        let (before, t) = (bytes_written(), Instant::now());
        let replaced;
        (paths, replaced) = v.stale_paths().unwrap();
        assert!(replaced >= velo_lib::vault::BULK, "no fixture notes in {src}");
        v.index.begin_bulk().unwrap();
        let (mut longest, mut peak_wal, mut lock_ms) = (t.elapsed().as_secs_f64(), 0, 0.0);
        let wal_size = || std::fs::metadata(format!("{}-wal", db.display())).map_or(0, |m| m.len());
        for (i, chunk) in paths.chunks(700).enumerate() {
            if round == 4 && i == 2 {
                let c = Instant::now();
                v.lock_note(&paths[0].to_string_lossy(), &velo_lib::crypto::new_identity()).unwrap();
                lock_ms = c.elapsed().as_secs_f64() * 1000.0;
            }
            let c = Instant::now();
            v.apply_bulk_chunk(chunk, None);
            longest = longest.max(c.elapsed().as_secs_f64());
            peak_wal = peak_wal.max(wal_size());
        }
        let c = Instant::now();
        v.index.end_bulk().unwrap();
        let end = c.elapsed().as_secs_f64();
        let mb = (bytes_written() - before) as f64 / 1e6;
        let wal = std::fs::metadata(format!("{}-wal", db.display())).map_or(0, |m| m.len());
        println!(
            "round {round}: rescan of {} notes in chunks of 700: {:.1} s, {mb:.0} MB written, longest chunk {:.0} ms, end_bulk {:.0} ms, lock mid-bulk {lock_ms:.0} ms, peak WAL {:.0} MB, WAL after {:.1} MB, index {:.0} MB",
            paths.len(), t.elapsed().as_secs_f64(), longest * 1000.0, end * 1000.0, peak_wal as f64 / 1e6, wal as f64 / 1e6, std::fs::metadata(&db).unwrap().len() as f64 / 1e6
        );
        let (p50, p95, max) = search_times(&v);
        println!("round {round}: search after re-index: p50 {p50:.1} ms, p95 {p95:.1} ms, max {max:.1} ms");
    }
    let (before, t) = (bytes_written(), Instant::now());
    v.lock_note(&paths[1].to_string_lossy(), &velo_lib::crypto::new_identity()).unwrap();
    println!("lock one note: {:.0} ms, {:.1} MB written", t.elapsed().as_secs_f64() * 1000.0, (bytes_written() - before) as f64 / 1e6);
}
