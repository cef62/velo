use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

pub fn fold(s: &str) -> String {
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .flat_map(char::to_lowercase)
        .collect()
}

/// Byte ranges of the inner text of each `[[...]]` (no `]` or newline inside).
fn link_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut i = 0;
    while let Some(p) = body[i..].find("[[") {
        let start = i + p + 2;
        let len = body[start..].find([']', '\n']).unwrap_or(body.len() - start);
        if body[start + len..].starts_with("]]") {
            spans.push((start, start + len));
            i = start + len + 2;
        } else {
            i = start - 1;
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

/// `(folded, display)` for each `#tag` outside fenced code, first spelling kept, in order of appearance.
pub fn extract_tags(body: &str) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut fenced = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let mut prev = None;
        for (i, c) in line.char_indices() {
            if c == '#' && prev.is_none_or(|p: char| p.is_whitespace() || p == '(') {
                let tag: String = line[i + 1..].chars().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/')).collect();
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

/// Removes each exact `#tag` word (same scanner rules as `extract_tags`) outside fenced code, inline code spans and
/// `](#...)` link targets; returns the new text and the count. A line left empty is dropped.
pub fn remove_inline_tag(body: &str, tag_folded: &str) -> (String, usize) {
    let (mut out, mut n, mut fenced) = (String::new(), 0, false);
    for raw in body.split_inclusive('\n') {
        let line = raw.trim_end_matches(['\n', '\r']);
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") { fenced = !fenced; }
        if fenced || t.starts_with("```") || t.starts_with("~~~") { out.push_str(raw); continue; }
        let (mut cuts, mut code, mut prev, mut prev2) = (vec![], false, None, None::<char>);
        for (i, c) in line.char_indices() {
            if c == '`' {
                code = !code;
            } else if c == '#' && !code && prev.is_none_or(|p: char| p.is_whitespace() || p == '(') && !(prev == Some('(') && prev2 == Some(']')) {
                let tag: String = line[i + 1..].chars().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/')).collect();
                if tag.chars().any(char::is_alphabetic) && fold(&tag) == tag_folded { cuts.push((i, i + 1 + tag.len())); }
            }
            prev2 = prev;
            prev = Some(c);
        }
        if cuts.is_empty() { out.push_str(raw); continue; }
        n += cuts.len();
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
        if !l.trim().is_empty() { out.push_str(&l); out.push_str(&raw[line.len()..]); }
    }
    (out, n)
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
    #[test] fn rewrite_case_insensitive() {
        assert_eq!(rewrite_links("x [[Old]] y [[old]] z [[Older]]", "OLD", "New"), ("x [[New]] y [[New]] z [[Older]]".into(), 2));
    }
    #[test] fn remove_inline_tag_exact_only() {
        let b = "keep #tagging and `#tag` and [x](#tag)\nfoo #Tag bar #tag\n```\n#tag\n```\n#tag #other\n#tag\nend";
        let (out, n) = remove_inline_tag(b, "tag");
        assert_eq!(out, "keep #tagging and `#tag` and [x](#tag)\nfoo bar\n```\n#tag\n```\n#other\nend");
        assert_eq!(n, 4);
    }
}
