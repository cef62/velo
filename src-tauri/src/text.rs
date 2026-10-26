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
}
