use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

pub fn fold(s: &str) -> String {
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .flat_map(char::to_lowercase)
        .collect()
}

/// Byte ranges of the inner text of each `[[...]]` (no `]` or newline inside) outside fenced code.
fn link_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for (at, line, _) in lines(body).filter(|l| l.2) {
        let mut i = 0;
        while let Some(p) = line[i..].find("[[") {
            let start = i + p + 2;
            let len = line[start..].find(']').unwrap_or(line.len() - start);
            if line[start + len..].starts_with("]]") {
                spans.push((at + start, at + start + len));
                i = start + len + 2;
            } else {
                i = start - 1;
            }
        }
    }
    spans
}

pub fn extract_links(body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    link_spans(body)
        .into_iter()
        .map(|(a, b)| body[a..b].trim())
        .filter(|t| !t.is_empty() && seen.insert(fold(t)))
        .map(String::from)
        .collect()
}

/// Chars a `#tag` runs over after the `#`.
fn tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// `(folded, display)` for each `#tag` outside fenced code, first spelling kept, in order of appearance.
pub fn extract_tags(body: &str) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, line, _) in lines(body).filter(|l| l.2) {
        let mut prev = None;
        for (i, c) in line.char_indices() {
            if c == '#' && prev.is_none_or(|p: char| p.is_whitespace() || p == '(') {
                let tag: String = line[i + 1..].chars().take_while(|&c| tag_char(c)).collect();
                if tag.chars().any(char::is_alphabetic) && seen.insert(fold(&tag)) {
                    out.push((fold(&tag), tag));
                }
            }
            prev = Some(c);
        }
    }
    out
}

pub fn rewrite_links(body: &str, old: &str, new: &str) -> (String, usize) {
    let old = fold(old.trim());
    let (mut out, mut last, mut n) = (String::new(), 0, 0);
    for (a, b) in link_spans(body) {
        if fold(body[a..b].trim()) == old {
            out.push_str(&body[last..a]);
            out.push_str(new);
            last = b;
            n += 1;
        }
    }
    out.push_str(&body[last..]);
    (out, n)
}

/// A list item or task with nothing after its marker (`-`, `1.`, `- [ ]`).
fn bare_marker(t: &str) -> bool {
    let m = ["[ ]", "[x]", "[X]"].iter().find_map(|b| t.strip_suffix(b)).map_or(t, str::trim_end);
    matches!(m, "-" | "*" | "+") || m.strip_suffix(['.', ')']).is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// Another backtick in `rest` before the paragraph ends (a blank line).
fn span_closes(rest: &str) -> bool {
    rest.split_inclusive('\n').enumerate().take_while(|(i, l)| *i == 0 || !l.trim().is_empty()).any(|(_, l)| l.contains('`'))
}

/// A code-fence line: its char, its length, and the text after it (a backtick fence's info has no backtick).
pub(crate) fn fence(line: &str) -> Option<(char, usize, &str)> {
    let t = line.trim_start();
    let c = t.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let rest = t.trim_start_matches(c);
    let n = t.len() - rest.len();
    (n >= 3 && !(c == '`' && rest.contains('`'))).then_some((c, n, rest))
}

/// One line of `body` for the prose scanner; `skip` marks fenced code and blank lines.
struct Line<'a> { start: usize, raw: &'a str, line: &'a str, skip: bool }

/// Each line of `body` as `(byte start, text without its line ending, prose)`; prose is false in fenced
/// code and on blank lines. The one code rule for tags, tag removal, links and tasks: only fenced blocks are code, as an
/// indented line may be a loose list's paragraph.
pub(crate) fn lines(body: &str) -> impl Iterator<Item = (usize, &str, bool)> {
    let mut sc = Scanner::new(body);
    std::iter::from_fn(move || sc.next_line().map(|l| (l.start, l.line, !l.skip)))
}

/// The scanner rules shared by `remove_inline_tag` and `find_mentions`: fenced code skips whole lines,
/// `step` tracks inline code spans (which may run over the lines of one paragraph) and `[...]` / `[[...]]` depth.
struct Scanner<'a> {
    body: &'a str,
    pos: usize,
    /// the fence we are inside: its char and length
    open: Option<(char, usize)>,
    code: bool,
    depth: usize,
    after_close: bool,
    /// the last `step` char was part of a `(...)` link target
    target: bool,
}

impl<'a> Scanner<'a> {
    fn new(body: &'a str) -> Self {
        Scanner { body, pos: 0, open: None, code: false, depth: 0, after_close: false, target: false }
    }

    fn next_line(&mut self) -> Option<Line<'a>> {
        let raw = self.body[self.pos..].split_inclusive('\n').next()?;
        let start = self.pos;
        self.pos += raw.len();
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        let fenced = match (self.open, fence(line)) {
            // CommonMark: only the same char, at least as long, with nothing after it, closes a fence
            (Some((c, n)), Some((c2, n2, rest))) if c == c2 && n2 >= n && rest.trim().is_empty() => { self.open = None; true }
            (Some(_), _) => true,
            (None, Some((c, n, _))) => { self.open = Some((c, n)); true }
            (None, None) => false,
        };
        let skip = fenced || line.trim().is_empty();
        if skip { self.code = false; }
        (self.depth, self.after_close, self.target) = (0, false, false);
        Some(Line { start, raw, line, skip })
    }

    /// Feeds the char at byte `at` of the body; true when it is prose: outside inline code and `[...]` text.
    /// `self.target` says whether it also sits in a `(...)` link target.
    fn step(&mut self, at: usize, c: char) -> bool {
        let closing = c == ']' && self.depth == 1;
        let prose = if c == '`' {
            // a backtick opens a span only if another one closes it within the paragraph; otherwise it is literal
            self.code = !self.code && span_closes(&self.body[at + 1..]);
            false
        } else if self.code {
            false
        } else if c == '[' {
            self.depth += 1;
            false
        } else if c == ']' {
            self.depth = self.depth.saturating_sub(1);
            false
        } else {
            self.depth == 0
        };
        self.target = if self.target { c != ')' || { self.after_close = false; false } } else { self.after_close && c == '(' && !self.code };
        if !self.target { self.after_close = closing && !self.code; }
        prose
    }
}

/// Removes each exact `#tag` word (same scanner rules as `extract_tags`) outside fenced code, inline code
/// spans, `[...]` link text, `[[...]]` links and `](#...)` link targets; returns the new text and the count. A line
/// left empty, or left as a bare list or task marker, is dropped.
pub fn remove_inline_tag(body: &str, tag_folded: &str) -> (String, usize) {
    let (mut out, mut n) = (String::new(), 0);
    let mut sc = Scanner::new(body);
    while let Some(Line { start, raw, line, skip }) = sc.next_line() {
        if skip { out.push_str(raw); continue; }
        let (mut cuts, mut prev, mut prev2) = (vec![], None, None::<char>);
        for (i, c) in line.char_indices() {
            if sc.step(start + i, c) && c == '#' && prev.is_none_or(|p: char| p.is_whitespace() || p == '(') && !(prev == Some('(') && prev2 == Some(']')) {
                let tag: String = line[i + 1..].chars().take_while(|&c| tag_char(c)).collect();
                if tag.chars().any(char::is_alphabetic) && fold(&tag) == tag_folded { cuts.push((i, i + 1 + tag.len())); }
            }
            prev2 = prev;
            prev = Some(c);
        }
        if cuts.is_empty() { out.push_str(raw); continue; }
        n += cuts.len();
        // a list item whose only content was the tag(s) goes; text that merely looks like a marker stays
        let marker = line[..cuts[0].0].trim();
        let item = bare_marker(marker);
        let (mut l, mut last) = (String::new(), 0);
        for (a, b) in cuts {
            let (mut pre, after) = (&line[last..a], &line[b..]);
            last = b;
            if after.is_empty() || after.starts_with(' ') {
                if let Some(p) = pre.strip_suffix(' ') { pre = p; } else if pre.is_empty() && l.is_empty() && !after.is_empty() { last = b + 1; }
            }
            l.push_str(pre);
        }
        l.push_str(&line[last..]);
        if !l.trim().is_empty() && !(item && l.trim() == marker) { out.push_str(&l); out.push_str(&raw[line.len()..]); }
    }
    (out, n)
}

/// Whether the word at `line[a..i]` sits in a `#tag` (the `extract_tags` rules) or in a URL or email token: a
/// whitespace-delimited run containing `://` or `@`, or starting with `?`.
fn in_tag_or_url(line: &str, a: usize, i: usize) -> bool {
    let ts = line[..a].char_indices().rev().find(|(_, c)| c.is_whitespace()).map_or(0, |(k, c)| k + c.len_utf8());
    let token = &line[ts..i + line[i..].find(char::is_whitespace).unwrap_or(line.len() - i)];
    token.contains("://") || token.contains('@') || token.starts_with('?')
        || line[ts..a].match_indices('#').any(|(h, _)| {
            let (h, prev) = (ts + h, line[..ts + h].chars().next_back());
            let tag: String = line[h + 1..].chars().take_while(|&c| tag_char(c)).collect();
            prev.is_none_or(|p| p.is_whitespace() || p == '(') && h + 1 + tag.len() >= i && tag.chars().any(char::is_alphabetic)
        })
}

/// A title or alias found in prose: `name_folded` as given in the set, `as_written` and byte offsets in the text scanned.
#[derive(Debug, PartialEq)]
pub struct MentionHit { pub name_folded: String, pub as_written: String, pub start: usize, pub end: usize }

/// Whole-word, folded occurrences of `names` (each a folded string of words joined by single spaces) in prose, with the
/// scanner rules of `remove_inline_tag`; also outside `(...)` link targets. At each word the longest run of up to
/// `max_words` words wins and hits never overlap. Names under 3 characters are ignored. Words in a `#tag`, URL or
/// email are skipped; in prose a hyphen splits words, so `velo-roadmap` can mention both `velo` and `roadmap`.
/// shortcut: a word is a run of alphanumerics, so names with punctuation ("C++", "Dr. Smith") never match.
pub fn find_mentions(body: &str, names: &HashSet<String>, max_words: usize) -> Vec<MentionHit> {
    // prose words as (start, end, folded), in order
    let mut words: Vec<(usize, usize, String)> = vec![];
    let mut sc = Scanner::new(body);
    while let Some(Line { start, line, skip, .. }) = sc.next_line() {
        if skip { continue; }
        let mut cur: Option<usize> = None;
        for (i, c) in line.char_indices().chain([(line.len(), ' ')]) {
            let word = i < line.len() && sc.step(start + i, c) && !sc.target && c.is_alphanumeric();
            match (word, cur) {
                (true, None) => cur = Some(i),
                (false, Some(a)) => {
                    // part of a tag, email, path or URL, not a mention
                    let rest = &line[i..];
                    let glued = line[..a].ends_with(['#', '@', '/', '.', ':'])
                        || rest.starts_with(['@', '/'])
                        || rest.strip_prefix('.').is_some_and(|r| r.starts_with(char::is_alphanumeric))
                        || in_tag_or_url(line, a, i);
                    if !glued { words.push((start + a, start + i, fold(&line[a..i]))); }
                    cur = None;
                }
                _ => {}
            }
        }
    }
    let mut hits = vec![];
    let mut i = 0;
    'word: while i < words.len() {
        for k in (1..=max_words.min(words.len() - i)).rev() {
            let run = &words[i..i + k];
            // words must be separated by whitespace on one line, so the hit stays a valid `[[...]]`
            if run.windows(2).any(|w| { let gap = &body[w[0].1..w[1].0]; !gap.trim().is_empty() || gap.contains(['\n', '\r']) }) { continue; }
            let name = run.iter().map(|w| w.2.as_str()).collect::<Vec<_>>().join(" ");
            if name.chars().count() >= 3 && names.contains(&name) {
                let (start, end) = (run[0].0, run[k - 1].1);
                hits.push(MentionHit { name_folded: name, as_written: body[start..end].into(), start, end });
                i += k;
                continue 'word;
            }
        }
        i += 1;
    }
    hits
}

/// The `max_words` both the graph and Link it give `find_mentions`: the longest name in words, at most 8.
pub fn mention_max_words(names: &HashSet<String>) -> usize {
    names.iter().map(|n| n.split(' ').count()).max().unwrap_or(1).min(8)
}

/// Wraps the first mention of `name` (found among all `names`, as the graph finds them) in the text after front matter as `[[as written]]`, if there are exactly
/// `expected` of them; everything else, CRLF included, stays byte for byte.
pub fn link_mention_text(full_text: &str, name: &str, names: &HashSet<String>, expected: usize) -> Result<String, &'static str> {
    let body = crate::frontmatter::body(full_text);
    let offset = full_text.len() - body.len();
    let want = fold(name);
    // the full name set and the same word cap, so overlapping names resolve exactly as in the graph (longest wins)
    let hits: Vec<_> = find_mentions(body, names, mention_max_words(names)).into_iter().filter(|h| h.name_folded == want).collect();
    if hits.len() != expected || hits.is_empty() { return Err("mention-moved"); }
    let h = &hits[0];
    Ok(format!("{}[[{}]]{}", &full_text[..offset + h.start], h.as_written, &full_text[offset + h.end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn fold_strips_diacritics() { assert_eq!(fold("Résumé CAFÉ naïve"), "resume cafe naive"); }
    #[test] fn links_extracted_dedup() { assert_eq!(extract_links("see [[Foo]] and [[ foo ]] and [[Bar Baz]] [[]] [[a\nb]]"), vec!["Foo", "Bar Baz"]); }
    #[test] fn extract_tags_rules() {
        let b = "#Work and #idea, (#nested/path) C# x#y #1 #2024 http://h.com/#frag\n# Heading\n```\n#incode\n```\n#Café #work";
        let t: Vec<String> = extract_tags(b).into_iter().map(|(_, d)| d).collect();
        assert_eq!(t, vec!["Work", "idea", "nested/path", "Café"]);
        assert_eq!(extract_tags("#Café")[0].0, "cafe");
    }
    #[test] fn tags_skip_code_like_removal_and_ts() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../tests/fixtures/tags-code.json")).unwrap();
        for c in cases {
            let body = c["body"].as_str().unwrap();
            let want: Vec<&str> = c["tags"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
            let got: Vec<(String, String)> = extract_tags(body);
            assert_eq!(got.iter().map(|(_, d)| d.as_str()).collect::<Vec<_>>(), want, "{body:?}");
            // removal sees exactly the tags the index sees
            for (f, _) in &got {
                let (out, n) = remove_inline_tag(body, f);
                assert!(n > 0 && extract_tags(&out).iter().all(|(g, _)| g != f), "{body:?} {f}");
            }
        }
        assert_eq!(remove_inline_tag("````\n```\n#work\n```\n````\n#work\n", "work").1, 1);
    }
    #[test] fn links_in_code_are_not_links() {
        // only fenced blocks are code: an indented line may be a loose list's paragraph
        let b = "```\n[[Old]]\n```\n- item\n\n    see [[Old]]\n";
        assert_eq!(extract_links(b), vec!["Old"]);
        assert_eq!(rewrite_links(b, "Old", "New"), ("```\n[[Old]]\n```\n- item\n\n    see [[New]]\n".into(), 1));
        assert!(extract_links("```\n[[Old]]\n```").is_empty());
    }
    #[test] fn rewrite_case_insensitive() {
        assert_eq!(rewrite_links("x [[Old]] y [[old]] z [[Older]]", "OLD", "New"), ("x [[New]] y [[New]] z [[Older]]".into(), 2));
    }
    #[test] fn remove_inline_tag_exact_only() {
        let b = "keep #tagging and `#tag` and [x](#tag)\nfoo #Tag bar #tag\n```\n#tag\n```\n#tag #other\n#tag\nend";
        let (out, n) = remove_inline_tag(b, "tag");
        assert_eq!(out, "keep #tagging and `#tag` and [x](#tag)\nfoo bar\n```\n#tag\n```\n#other\nend");
        assert_eq!(n, 4);
    }
    #[test] fn remove_inline_tag_skips_link_text_not_indented_lines() {
        // only fenced blocks are code (the tag index sees indented lines too)
        let b = "read [the #work notes](http://x) and [[Plan #work]] #work\n\n    text #work here\n- a\n    - #work nested\n";
        assert_eq!(remove_inline_tag(b, "work"), ("read [the #work notes](http://x) and [[Plan #work]]\n\n    text here\n- a\n    - nested\n".into(), 3));
    }
    #[test] fn remove_inline_tag_handles_non_ascii_and_crlf() {
        for (b, want) in [
            ("#work città\n", "città\n"),
            ("#work 🎉\n", "🎉\n"),
            ("intro\n\n    perché #work\n", "intro\n\n    perché\n"),
            ("- 東京 #work\r\n- #work\r\n", "- 東京\r\n"),
            ("perché\n- [ ] #work\n1. #work 🎉\n", "perché\n1. 🎉\n"),
        ] {
            assert_eq!(remove_inline_tag(b, "work").0, want, "{b:?}");
        }
    }
    #[test] fn remove_inline_tag_keeps_marker_like_text() {
        assert_eq!(remove_inline_tag("Budget approved #work 2024.\n#work 3)\n#work 2024.\n#work -\n", "work").0, "Budget approved 2024.\n3)\n2024.\n-\n");
    }
    #[test] fn remove_inline_tag_skips_multi_line_code_spans() {
        // a code span may run over lines within a paragraph; a blank line ends it, and an unmatched backtick is literal
        let b = "see `code\n#work here` done\n\nit`s #work\n";
        assert_eq!(remove_inline_tag(b, "work"), ("see `code\n#work here` done\n\nit`s\n".into(), 1));
        assert_eq!(remove_inline_tag("a `x\n\n#work` b\n", "work").0, "a `x\n\n` b\n");
    }
    #[test] fn remove_inline_tag_drops_bare_markers() {
        let b = "Some paragraph\n- #work\n- [ ] #work\n1. #work\n- keep #work\n-\n";
        assert_eq!(remove_inline_tag(b, "work").0, "Some paragraph\n- keep\n-\n");
    }
    fn names(n: &[&str]) -> HashSet<String> { n.iter().map(|s| fold(s)).collect() }
    #[test] fn mentions_whole_words_folded() {
        let h = find_mentions("Read velo Roadmap; velociraptor.", &names(&["velo roadmap", "velo"]), 3);
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].as_written.as_str(), h[0].name_folded.as_str()), ("velo Roadmap", "velo roadmap"));
        assert_eq!((h[0].start, h[0].end), (5, 17));
    }
    #[test] fn mentions_skip_code_links_and_short_names() {
        let b = "`Velo` [[Velo]] [x](Velo)\n```\nVelo\n```\nab Velo";
        let h = find_mentions(b, &names(&["velo", "ab"]), 3);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].start, b.len() - 4);
    }
    #[test] fn mentions_non_ascii() {
        let h = find_mentions("Un Résumé è qui", &names(&["resume"]), 2);
        assert_eq!((h.len(), h[0].as_written.as_str()), (1, "Résumé"));
        assert_eq!(&"Un Résumé è qui"[h[0].start..h[0].end], "Résumé");
    }
    #[test] fn mentions_longest_wins_no_overlap() {
        let h = find_mentions("Velo roadmap and Velo", &names(&["velo", "velo roadmap"]), 3);
        let w: Vec<_> = h.iter().map(|m| m.as_written.as_str()).collect();
        assert_eq!(w, vec!["Velo roadmap", "Velo"]);
    }
    #[test] fn link_mention_wraps_first_and_checks_count() {
        let t = "---\ntags: [x]\n---\nsee Nick and nick\r\n";
        assert_eq!(link_mention_text(t, "Nick", &names(&["nick"]), 2).unwrap(), "---\ntags: [x]\n---\nsee [[Nick]] and nick\r\n");
        assert_eq!(link_mention_text(t, "Nick", &names(&["nick"]), 1), Err("mention-moved"));
    }
    #[test] fn link_mention_ignores_front_matter() {
        assert_eq!(link_mention_text("---\naliases: [Nick]\n---\nnothing\n", "Nick", &names(&["nick"]), 1), Err("mention-moved"));
    }
    #[test] fn link_mention_uses_full_name_set() {
        let n = names(&["velo", "velo roadmap"]);
        assert_eq!(link_mention_text("Velo roadmap and Velo", "Velo", &n, 1).unwrap(), "Velo roadmap and [[Velo]]");
    }
    #[test] fn mentions_do_not_span_line_breaks() {
        let n = names(&["velo roadmap"]);
        assert!(find_mentions("Velo\r\nroadmap", &n, 3).is_empty());
        assert_eq!(find_mentions("Velo  roadmap", &n, 3).len(), 1);
    }
    #[test] fn mentions_skip_tags_emails_and_urls() {
        let n = names(&["velo"]);
        for b in ["#velo", "a@velo.io", "http://velo.com/velo", "velo@x.io", "velo/notes", "velo.com"] {
            assert!(find_mentions(b, &n, 2).is_empty(), "{b}");
        }
        assert_eq!(find_mentions("I like velo. And (velo), velo!", &n, 2).len(), 3);
        let n = names(&["velo", "roadmap"]);
        for b in ["#proj-roadmap", "#my_velo", "(#a/velo-x)", "https://x/velo-roadmap", "?q=velo", "a@velo.io", "see https://x.com/?q=velo&r=roadmap"] {
            assert!(find_mentions(b, &n, 2).is_empty(), "{b}");
        }
        assert_eq!(link_mention_text("#proj-roadmap then roadmap", "roadmap", &n, 1).unwrap(), "#proj-roadmap then [[roadmap]]");
        // in prose a hyphen splits words, so each half is a mention of its own
        assert_eq!(find_mentions("the velo-roadmap", &n, 2).len(), 2);
    }
}
