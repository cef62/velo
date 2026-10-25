use std::collections::HashMap;
use std::time::Instant;
use velo_lib::index::{Index, Meta};
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
    assert!(n > 0, "no fixture notes in {dir}");
    let none = HashMap::new();
    let mut times = Vec::new();
    for q in QUERIES {
        for _ in 0..10 {
            let t = Instant::now();
            idx.search(q, 50, &none).unwrap();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let (p50, p95) = (times[times.len() / 2], times[times.len() * 95 / 100]);
    println!("{n} notes: p50 {p50:.2} ms, p95 {p95:.2} ms");
    assert!(p95 < 50.0, "p95 {p95:.2} ms");
}
