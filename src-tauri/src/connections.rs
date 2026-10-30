use crate::frontmatter;
use crate::index::{Index, all_tags};
use crate::text::{context_line, extract_links, find_mentions, fold, link_spans, mention_max_words};
use anyhow::anyhow;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Tag groups with more notes than this carry only their count.
pub const TAG_MAX: usize = 15;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Node {
    pub path: String,
    pub title: String,
    pub created: i64,
    pub modified: i64,
    pub preview: String,
    pub locked: bool,
    /// For `links_in`: the line holding the link (trimmed, cut around it); "" elsewhere and for locked sources.
    pub context: String,
}

/// How much of a line a context keeps.
pub const CONTEXT_CHARS: usize = 120;

#[derive(Serialize, Debug)]
pub struct TagGroup {
    pub tag: String,
    /// Notes other than the centre carrying the tag; `notes` is empty above `TAG_MAX`.
    pub count: usize,
    pub notes: Vec<Node>,
    /// Unlocked encrypted notes included in `count`, so the MCP layer can take them out again.
    #[serde(skip)]
    pub unlocked: usize,
}

#[derive(Serialize, Debug)]
pub struct Mention {
    pub node: Node,
    /// The title or alias as first written in the centre's text.
    pub name: String,
    /// Unlinked occurrences of that name: Link it's `expected_count`.
    pub count: usize,
    /// The line holding the first occurrence; "" when the centre is locked.
    pub context: String,
}

#[derive(Serialize, Debug)]
pub struct Connections {
    pub centre: Node,
    pub links_out: Vec<Node>,
    pub links_in: Vec<Node>,
    pub tags: Vec<TagGroup>,
    pub mentions: Vec<Mention>,
    /// `[[targets]]` in the centre with no note: ⇧↩ in the Related panel creates them.
    pub missing: Vec<String>,
}

fn node(index: &Index, path: &str) -> anyhow::Result<Option<Node>> {
    Ok(index.node(path)?.map(|r| Node { path: path.into(), title: r.title, created: r.created, modified: r.modified, preview: r.preview, locked: r.encrypted, context: String::new() }))
}

/// Nodes for `paths` still in the index, most recently modified first.
pub(crate) fn nodes(index: &Index, paths: impl IntoIterator<Item = String>) -> anyhow::Result<Vec<Node>> {
    let mut out = vec![];
    for p in paths {
        out.extend(node(index, &p)?);
    }
    out.sort_by_key(|n| std::cmp::Reverse(n.modified));
    Ok(out)
}

/// Every note the wikilinks in `body` name (title or alias), and the link texts naming none.
fn targets(index: &Index, body: &str) -> anyhow::Result<(HashSet<String>, Vec<String>)> {
    let mut out = HashSet::new();
    let mut missing = vec![];
    for l in extract_links(body) {
        let found = index.find_titles(&l)?;
        if found.is_empty() { missing.push(l) } else { out.extend(found) }
    }
    Ok((out, missing))
}

/// The line of the first `[[link]]` in a plain source that names the centre; "" when none is found.
fn link_context(body: &str, names: &[String]) -> String {
    link_spans(body)
        .into_iter()
        .find(|&(a, b)| names.iter().any(|n| *n == fold(body[a..b].trim())))
        .map_or_else(String::new, |(a, b)| context_line(body, a.saturating_sub(2), (b + 2).min(body.len()), CONTEXT_CHARS))
}

/// The one-hop graph around `path`, whose text is `text`. Locked notes' own links and tags come only from `unlocked`.
/// Names of notes whose path `hide` accepts are left out of mention matching, so they cannot shadow a shorter name.
pub fn build(index: &Index, unlocked: &HashMap<String, String>, path: &str, text: &str, hide: &dyn Fn(&str) -> bool) -> anyhow::Result<Connections> {
    let centre = node(index, path)?.ok_or_else(|| anyhow!("not found"))?;
    let fm = frontmatter::parse(text);
    let body = frontmatter::body(text);
    // unlocked notes other than the centre: (path, body, folded tags)
    let others: Vec<(&String, &str, HashSet<String>)> = unlocked
        .iter()
        .filter(|(p, _)| *p != path)
        .map(|(p, t)| (p, frontmatter::body(t), all_tags(frontmatter::body(t), frontmatter::parse(t).as_ref()).into_iter().map(|(f, _)| f).collect()))
        .collect();

    let (mut out, missing) = targets(index, body)?;
    out.remove(path);

    let mut sources: HashSet<String> = index.linked_from(path)?.into_iter().collect();
    for (p, b, _) in &others {
        if targets(index, b)?.0.contains(path) {
            sources.insert(p.to_string());
        }
    }
    // the sentence that links here, from plain sources only: a locked source shows its title and nothing else, unlocked or not
    let centre_names = index.names_of(path)?;
    let mut links_in = nodes(index, sources)?;
    for n in &mut links_in {
        if !n.locked {
            if let Some(b) = index.body(&n.path)? { n.context = link_context(&b, &centre_names); }
        }
    }

    let indexed: HashSet<String> = index.tags_of(path)?.iter().map(|t| fold(t)).collect();
    let mut tags = vec![];
    for (tag, display) in all_tags(body, fm.as_ref()) {
        let (count, mut paths) = index.tag_notes(&tag, TAG_MAX + 1)?;
        // the index counts the centre too when it carries the tag there
        let mut count = count.saturating_sub(indexed.contains(&tag) as usize);
        paths.retain(|p| p != path);
        let mut unlocked = 0;
        for (p, _, t) in &others {
            if t.contains(&tag) {
                unlocked += 1;
                paths.push(p.to_string());
            }
        }
        count += unlocked;
        let notes = if count > TAG_MAX { vec![] } else { nodes(index, paths)? };
        tags.push(TagGroup { tag: display, count, notes, unlocked });
    }

    let mut named: HashMap<String, Vec<String>> = HashMap::new();
    for (name, p) in index.names()?.into_iter().filter(|(_, p)| !hide(p)) {
        named.entry(name).or_default().push(p);
    }
    let names: HashSet<String> = named.keys().cloned().collect();
    let max_words = mention_max_words(&names);
    // per target note, in order of first hit: (path, folded name, as written, hits of that name, first hit's span)
    let mut found: Vec<(&String, String, String, usize, (usize, usize))> = vec![];
    for h in find_mentions(body, &names, max_words) {
        // a name two notes share mentions both
        for p in named[&h.name_folded].iter().filter(|p| *p != path && !out.contains(*p)) {
            match found.iter_mut().find(|f| f.0 == p) {
                Some(f) if f.1 == h.name_folded => f.3 += 1,
                Some(_) => {}
                None => found.push((p, h.name_folded.clone(), h.as_written.clone(), 1, (h.start, h.end))),
            }
        }
    }
    let mut mentions = vec![];
    for (p, _, name, count, (a, b)) in found {
        // the centre's own text: never shown for a locked centre, unlocked or not
        let context = if centre.locked { String::new() } else { context_line(body, a, b, CONTEXT_CHARS) };
        mentions.extend(node(index, p)?.map(|node| Mention { node, name, count, context }));
    }
    mentions.sort_by_key(|m| std::cmp::Reverse(m.node.modified));

    Ok(Connections { centre, links_out: nodes(index, out)?, links_in, tags, mentions, missing })
}

#[cfg(test)]
mod tests {
    use crate::crypto;
    use crate::vault::Vault;
    use std::path::PathBuf;

    /// A vault over `files` (name, text); names ending `.md.age` are encrypted with `id`.
    fn vault(files: &[(&str, &str)], id: &str, unlock: bool) -> (Vault, PathBuf) {
        let dir = tempfile::tempdir().unwrap().keep();
        for (name, text) in files {
            let bytes = if name.ends_with(".age") { crypto::encrypt(id, text.as_bytes()).unwrap() } else { text.as_bytes().to_vec() };
            std::fs::write(dir.join(name), bytes).unwrap();
        }
        let db = tempfile::tempdir().unwrap().keep().join("i.sqlite");
        (Vault::open_with_progress(dir.clone(), &db, unlock.then_some(id), &mut |_, _| {}).unwrap(), dir)
    }

    fn p(dir: &std::path::Path, name: &str) -> String {
        dir.join(name).to_string_lossy().into_owned()
    }

    fn paths(nodes: &[super::Node]) -> Vec<String> {
        nodes.iter().map(|n| n.path.clone()).collect()
    }

    #[test] fn one_hop_groups() {
        let (v, d) = vault(&[("C.md", "see [[A]] #t and Delta"), ("A.md", ""), ("B.md", "[[C]]"), ("D.md", "#t"), ("Delta.md", "")], "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(c.centre.title, "C");
        assert_eq!(paths(&c.links_out), [p(&d, "A.md")]);
        assert_eq!(paths(&c.links_in), [p(&d, "B.md")]);
        assert_eq!(c.tags.len(), 1);
        assert_eq!((c.tags[0].tag.as_str(), c.tags[0].count), ("t", 1));
        assert_eq!(paths(&c.tags[0].notes), [p(&d, "D.md")]);
        assert_eq!(c.mentions.len(), 1);
        assert_eq!((c.mentions[0].node.path.clone(), c.mentions[0].name.as_str(), c.mentions[0].count), (p(&d, "Delta.md"), "Delta", 1));
    }

    #[test] fn backlink_and_mention_carry_their_line_but_never_a_locked_notes_text() {
        let id = crypto::new_identity();
        let (v, d) = vault(&[("C.md", "intro\nDelta came up in the Q4 planning\n"), ("B.md", "# B\nfirst line\nSee [[C]] for the header plan\n"), ("Delta.md", ""), ("L.md.age", "secret [[C]] text")], &id, true);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        let by_path: std::collections::HashMap<_, _> = c.links_in.iter().map(|n| (n.path.clone(), n.context.clone())).collect();
        assert_eq!(by_path[&p(&d, "B.md")], "See [[C]] for the header plan");
        assert_eq!(by_path[&p(&d, "L.md.age")], "", "an unlocked locked source shows no text");
        assert_eq!(c.mentions[0].context, "Delta came up in the Q4 planning");
        assert!(c.links_out.iter().all(|n| n.context.is_empty()));
        // a locked centre: mention lines come from its own text, so none
        let (v, d) = vault(&[("L.md.age", "Delta came up"), ("Delta.md", "")], &id, true);
        let c = v.connections(&p(&d, "L.md.age"), &|_| false).unwrap();
        assert_eq!(c.mentions.len(), 1);
        assert_eq!(c.mentions[0].context, "");
    }

    #[test] fn missing_link_targets_are_listed() {
        let (v, d) = vault(&[("C.md", "see [[A]] and [[Nowhere]] and [[ nowhere ]]"), ("A.md", "")], "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(c.missing, ["Nowhere"]);
    }

    #[test] fn alias_link_is_a_backlink() {
        let (v, d) = vault(&[("Nicholas.md", "---\naliases: [Nick]\n---\n"), ("B.md", "[[Nick]]")], "", false);
        assert_eq!(paths(&v.connections(&p(&d, "Nicholas.md"), &|_| false).unwrap().links_in), [p(&d, "B.md")]);
    }

    #[test] fn big_tag_collapses() {
        let mut files = vec![("C.md".to_string(), "#big".to_string())];
        files.extend((0..17).map(|i| (format!("n{i}.md"), "#big".to_string())));
        let files: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (v, d) = vault(&files, "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(c.tags[0].count, 17);
        assert!(c.tags[0].notes.is_empty());
    }

    #[test] fn linked_note_is_not_a_mention() {
        let (v, d) = vault(&[("C.md", "[[Alpha]] and Alpha again"), ("Alpha.md", "")], "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(paths(&c.links_out), [p(&d, "Alpha.md")]);
        assert!(c.mentions.is_empty());
    }

    #[test] fn mention_counts_its_spelling_and_every_note_it_names() {
        let (v, d) = vault(&[("C.md", "velo roadmap, Velo Roadmap, plan"), ("Velo roadmap.md", ""), ("Other.md", "---\naliases: [Velo roadmap]\n---\n")], "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        let mut got: Vec<_> = c.mentions.iter().map(|m| (m.node.path.clone(), m.name.as_str(), m.count)).collect();
        got.sort();
        assert_eq!(got, [(p(&d, "Other.md"), "velo roadmap", 2), (p(&d, "Velo roadmap.md"), "velo roadmap", 2)]);
    }

    #[test] fn alias_equal_to_title_counts_once_and_links() {
        let (mut v, d) = vault(&[("C.md", "see Résumé"), ("Resume.md", "---\naliases: [Résumé]\n---\n")], "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(c.mentions.iter().map(|m| (m.name.as_str(), m.count)).collect::<Vec<_>>(), [("Résumé", 1)]);
        v.link_mention(&p(&d, "C.md"), &c.mentions[0].name, c.mentions[0].count, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("C.md")).unwrap(), "see [[Résumé]]");
    }

    #[test] fn link_it_accepts_what_the_graph_shows_past_the_word_cap() {
        // the 9-word title is past the cap, so only "alpha" is a mention, in the graph and in Link it alike
        let (mut v, d) = vault(&[("C.md", "alpha b c d e f g h i"), ("alpha.md", ""), ("alpha b c d e f g h i.md", "")], "", false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(c.mentions.iter().map(|m| (m.name.as_str(), m.count)).collect::<Vec<_>>(), [("alpha", 1)]);
        v.link_mention(&p(&d, "C.md"), "alpha", 1, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("C.md")).unwrap(), "[[alpha]] b c d e f g h i");
    }

    #[test] fn locked_centre_refused_until_unlocked() {
        let id = crypto::new_identity();
        let files = [("L.md.age", "[[Alpha]]"), ("Alpha.md", "")];
        let (v, d) = vault(&files, &id, false);
        assert_eq!(v.connections(&p(&d, "L.md.age"), &|_| false).unwrap_err().to_string(), "locked");
        let (v, d) = vault(&files, &id, true);
        let c = v.connections(&p(&d, "L.md.age"), &|_| false).unwrap();
        assert!(c.centre.locked);
        assert_eq!(paths(&c.links_out), [p(&d, "Alpha.md")]);
    }

    #[test] fn locked_neighbour_is_a_node_without_its_links() {
        let id = crypto::new_identity();
        let files = [("L.md.age", "[[C]] #t"), ("C.md", "[[L]] #t")];
        let (v, d) = vault(&files, &id, false);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(c.links_out.len(), 1);
        assert_eq!((c.links_out[0].title.as_str(), c.links_out[0].locked), ("L", true));
        assert_eq!(c.links_out[0].preview, "");
        assert!(c.links_in.is_empty());
        assert_eq!((c.tags[0].count, c.tags[0].notes.len(), c.tags[0].unlocked), (0, 0, 0));
        // unlocked: its links and tags come from memory
        let (v, d) = vault(&files, &id, true);
        let c = v.connections(&p(&d, "C.md"), &|_| false).unwrap();
        assert_eq!(paths(&c.links_in), [p(&d, "L.md.age")]);
        assert_eq!(paths(&c.tags[0].notes), [p(&d, "L.md.age")]);
        assert_eq!((c.tags[0].count, c.tags[0].unlocked), (1, 1));
    }
}
