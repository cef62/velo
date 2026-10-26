use std::collections::HashMap;
use std::time::Instant;
use velo_lib::index::{Index, Meta, Sort};
use velo_lib::names::parse_note_file;

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
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_none_or(|x| x != "md") {
            continue;
        }
        let nf = parse_note_file(&p).unwrap();
        let body = std::fs::read_to_string(&p).unwrap();
        let meta = Meta { mtime: n, size: body.len() as u64 };
        idx.upsert(p.file_name().unwrap().to_str().unwrap(), &nf, &meta, Some(&body)).unwrap();
        n += 1;
    }
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
                    idx.search_page(q, sort, off, 200, &[], &none).unwrap();
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
}
