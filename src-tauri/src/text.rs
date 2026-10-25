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
    #[test] fn rewrite_case_insensitive() {
        assert_eq!(rewrite_links("x [[Old]] y [[old]] z [[Older]]", "OLD", "New"), ("x [[New]] y [[New]] z [[Older]]".into(), 2));
    }
}
