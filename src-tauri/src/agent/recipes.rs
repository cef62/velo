//! Fixture for the docs site's agent recipes (site/src/content/recipes/transcripts.json): every recipe's tool calls run
//! through `gate`, the dispatch `velo --mcp` serves, against a temp vault; each result is the tool-result text the MCP
//! server sends (`Value::to_string`). `VELO_UPDATE_DOCS=1 cargo test recipe_transcripts` rewrites the file.
//!
//! Determinism: seeded notes carry fixed `created`/`modified` front matter, so their dates do not depend on file
//! mtimes. Before comparing, every RFC 3339 timestamp is rewritten in UTC (results use the local zone) and any
//! timestamp from this run ("now": stamped by writes) becomes `NOW`; each `hash` value is replaced, in order of first
//! appearance, by a stable fake (the real ones cover the stamped "now"). Daily notes and tasks use explicit dates and
//! no due dates in `list_tasks`, so nothing depends on today's date.
use super::gate;
use serde_json::{Value, json};

const NOW: &str = "2026-10-30T16:00:00+00:00";

const SEED: &[(&str, &str)] = &[
    ("Project Atlas kickoff.md", "---\ncreated: 2026-10-26T09:15:00+00:00\nmodified: 2026-10-26T10:02:00+00:00\n---\nKickoff with Dana and Lee. #atlas #meeting\n\n- Scope: sync engine first, sharing later\n- Ship a beta by mid-December\n- Plan lives in [[Atlas roadmap]]\n\n- [ ] Send kickoff recap\n- [ ] Book the design review\n"),
    ("Atlas roadmap.md", "---\ncreated: 2026-10-20T08:00:00+00:00\nmodified: 2026-10-28T14:30:00+00:00\n---\n#atlas\n\n## Milestones\n- November: sync engine prototype\n- December: private beta\n- January: sharing\n\nRisk: conflict handling on flaky networks.\n"),
    ("Hiring loop notes.md", "---\ncreated: 2026-10-29T11:00:00+00:00\nmodified: 2026-10-29T11:40:00+00:00\n---\n#hiring\n\nTwo onsites this week; both strong on systems design.\nWe still need a frontend interviewer for the loop.\n\n- [ ] Write feedback for candidate B\n"),
    ("Reading - Shape Up.md", "---\ncreated: 2026-10-27T21:10:00+00:00\nmodified: 2026-10-27T21:25:00+00:00\n---\n#reading\n\nAppetite instead of estimates: fix the time, vary the scope.\nBreadboarding before wireframes.\n"),
    ("Grocery list.md", "---\ncreated: 2026-10-12T18:00:00+00:00\nmodified: 2026-10-14T18:05:00+00:00\n---\n- [ ] Coffee beans\n- [ ] Oat milk\n"),
    ("2026-10-29.md", "---\ncreated: 2026-10-29T08:30:00+00:00\nmodified: 2026-10-29T17:45:00+00:00\n---\n- Reviewed [[Atlas roadmap]] with Dana\n- Ran two hiring onsites\n"),
];

/// (recipe id, tool calls in order)
fn recipes() -> Vec<(&'static str, Vec<(&'static str, Value)>)> {
    vec![
        ("summarise-week", vec![
            ("search_notes", json!({})),
            ("read_note", json!({"title": "Project Atlas kickoff"})),
            ("read_note", json!({"title": "Atlas roadmap"})),
            ("read_note", json!({"title": "Hiring loop notes"})),
        ]),
        ("file-meeting-notes", vec![
            ("create_note", json!({"title": "Atlas design review", "text": "Design review for [[Project Atlas kickoff]].\n\n- Sync engine: go with operation log, not snapshots\n- Sharing waits until after the beta\n", "summary": "Filed design review notes"})),
            ("add_tags", json!({"titles": ["Atlas design review"], "tags": ["atlas", "meeting"], "summary": "Tagged the design review"})),
            ("add_task", json!({"title": "Atlas design review", "text": "Write the operation log RFC", "due": "2026-11-06", "summary": "Added follow-up task"})),
            ("add_task", json!({"title": "Atlas design review", "text": "Share the review notes with Lee", "summary": "Added follow-up task"})),
        ]),
        ("daily-standup", vec![
            ("daily_note", json!({"date": "2026-10-30"})),
            ("read_note", json!({"title": "2026-10-29"})),
            ("list_tasks", json!({})),
            ("append_to_note", json!({"title": "2026-10-30", "text": "## Standup\n- Yesterday: reviewed the Atlas roadmap, ran two hiring onsites\n- Today: send the kickoff recap, write feedback for candidate B\n- Blocked: need a frontend interviewer", "summary": "Added standup"})),
        ]),
    ]
}

/// Every RFC 3339 timestamp in `s` in UTC; one at or after `start` becomes `NOW`.
fn times(s: &str, start: chrono::DateTime<chrono::Utc>) -> String {
    let (mut out, mut i) = (String::new(), 0);
    while i < s.len() {
        // longest form first: "2026-10-30T16:00:00.123+01:00", then without fractions, then "Z"
        let hit = [29, 25, 24, 20].iter().find_map(|&n| s.get(i..i + n).and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| (n, d))));
        match hit {
            Some((n, d)) => {
                let d = d.with_timezone(&chrono::Utc);
                out.push_str(&if d >= start { NOW.to_string() } else { d.format("%Y-%m-%dT%H:%M:%S+00:00").to_string() });
                i += n;
            }
            None => {
                let c = s[i..].chars().next().unwrap();
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    out
}

fn normalise(v: &mut Value, start: chrono::DateTime<chrono::Utc>, hashes: &mut Vec<String>) {
    match v {
        Value::String(s) => *s = times(s, start),
        Value::Array(a) => a.iter_mut().for_each(|x| normalise(x, start, hashes)),
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                if let (true, Some(h)) = (k == "hash", x.as_str()) {
                    let n = hashes.iter().position(|y| y == h).unwrap_or_else(|| { hashes.push(h.to_string()); hashes.len() - 1 });
                    *x = json!(format!("{:016x}", (n as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15)));
                } else {
                    normalise(x, start, hashes);
                }
            }
        }
        _ => {}
    }
}

#[test]
fn recipe_transcripts() {
    let start = chrono::Utc::now() - chrono::Duration::seconds(60);
    let mut out = vec![];
    for (recipe, calls) in recipes() {
        let tmp = tempfile::tempdir().unwrap();
        let notes = tmp.path().join("notes");
        std::fs::create_dir(&notes).unwrap();
        for (name, text) in SEED {
            std::fs::write(notes.join(name), text).unwrap();
        }
        let settings = tmp.path().join("settings.json");
        std::fs::write(&settings, json!({"agent_access": true, "notes_dir": notes}).to_string()).unwrap();
        let call = gate(settings, tmp.path().join("data"));
        let mut hashes = vec![];
        let steps: Vec<Value> = calls.into_iter().map(|(tool, args)| {
            let mut v = call(tool, args.clone()).unwrap_or_else(|e| panic!("{recipe}: {tool} failed: {e}"));
            normalise(&mut v, start, &mut hashes);
            json!({"tool": tool, "arguments": args, "result": v.to_string()})
        }).collect();
        out.push(json!({"recipe": recipe, "steps": steps}));
    }
    let got = serde_json::to_string_pretty(&out).unwrap() + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../site/src/content/recipes/transcripts.json");
    if std::env::var("VELO_UPDATE_DOCS").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n"); // a CRLF checkout (Windows) is the same file
    assert!(want == got, "{} is out of date: run `VELO_UPDATE_DOCS=1 cargo test recipe_transcripts` in src-tauri", path.display());
}

#[test]
fn timestamps_normalise() {
    let start = chrono::DateTime::parse_from_rfc3339("2026-10-31T00:00:00Z").unwrap().with_timezone(&chrono::Utc);
    assert_eq!(times("a 2026-10-26T10:02:00+01:00 b", start), "a 2026-10-26T09:02:00+00:00 b");
    assert_eq!(times("2026-10-26T10:02:00.123Z", start), "2026-10-26T10:02:00+00:00");
    assert_eq!(times("modified: 2026-11-02T08:00:00-05:00\n", start), format!("modified: {NOW}\n"));
    assert_eq!(times("2026-10-29 · ✓", start), "2026-10-29 · ✓");
}
