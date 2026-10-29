use crate::frontmatter;
use crate::index::{Index, all_tags};
use crate::text::{extract_links, find_mentions, fold};
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
}

#[derive(Serialize, Debug)]
pub struct TagGroup {
    pub tag: String,
    /// Notes other than the centre carrying the tag; `notes` is empty above `TAG_MAX`.
    pub count: usize,
    pub notes: Vec<Node>,
}

#[derive(Serialize, Debug)]
pub struct Mention {
    pub node: Node,
    /// The title or alias as first written in the centre's text.
    pub name: String,
    /// Unlinked occurrences of that name: Link it's `expected_count`.
    pub count: usize,
}

#[derive(Serialize, Debug)]
pub struct Connections {
    pub centre: Node,
    pub links_out: Vec<Node>,
    pub links_in: Vec<Node>,
    pub tags: Vec<TagGroup>,
    pub mentions: Vec<Mention>,
}

/// Longest name the mention matcher tries, in words.
const MAX_WORDS: usize = 8;

fn node(index: &Index, path: &str) -> anyhow::Result<Option<Node>> {
    Ok(index.node(path)?.map(|r| Node { path: path.into(), title: r.title, created: r.created, modified: r.modified, preview: r.preview, locked: r.encrypted }))
}

/// Nodes for `paths` still in the index, most recently modified first.
fn nodes(index: &Index, paths: impl IntoIterator<Item = String>) -> anyhow::Result<Vec<Node>> {
    let mut out = vec![];
    for p in paths {
        out.extend(node(index, &p)?);
    }
    out.sort_by_key(|n| std::cmp::Reverse(n.modified));
    Ok(out)
}

/// Every note the wikilinks in `body` name (title or alias).
fn targets(index: &Index, body: &str) -> anyhow::Result<HashSet<String>> {
    let mut out = HashSet::new();
    for l in extract_links(body) {
        out.extend(index.find_titles(&l)?);
    }
    Ok(out)
}

/// The one-hop graph around `path`, whose text is `text`. Locked notes' own links and tags come only from `unlocked`.
pub fn build(index: &Index, unlocked: &HashMap<String, String>, path: &str, text: &str) -> anyhow::Result<Connections> {
    let centre = node(index, path)?.ok_or_else(|| anyhow!("not found"))?;
    let fm = frontmatter::parse(text);
    let body = frontmatter::body(text);
    // unlocked notes other than the centre: (path, body, folded tags)
    let others: Vec<(&String, &str, HashSet<String>)> = unlocked
        .iter()
        .filter(|(p, _)| *p != path)
        .map(|(p, t)| (p, frontmatter::body(t), all_tags(frontmatter::body(t), frontmatter::parse(t).as_ref()).into_iter().map(|(f, _)| f).collect()))
        .collect();

    let mut out = targets(index, body)?;
    out.remove(path);

    let mut sources: HashSet<String> = index.linked_from(path)?.into_iter().collect();
    for (p, b, _) in &others {
        if targets(index, b)?.contains(path) {
            sources.insert(p.to_string());
        }
    }

    let indexed: HashSet<String> = index.tags_of(path)?.iter().map(|t| fold(t)).collect();
    let mut tags = vec![];
    for (tag, display) in all_tags(body, fm.as_ref()) {
        let (count, mut paths) = index.tag_notes(&tag, TAG_MAX + 1)?;
        // the index counts the centre too when it carries the tag there
        let mut count = count.saturating_sub(indexed.contains(&tag) as usize);
        paths.retain(|p| p != path);
        for (p, _, t) in &others {
            if t.contains(&tag) {
                count += 1;
                paths.push(p.to_string());
            }
        }
        let notes = if count > TAG_MAX { vec![] } else { nodes(index, paths)? };
        tags.push(TagGroup { tag: display, count, notes });
    }

    let mut named: HashMap<String, Vec<String>> = HashMap::new();
    for (name, p) in index.names()? {
        named.entry(name).or_default().push(p);
    }
    let names: HashSet<String> = named.keys().cloned().collect();
    let max_words = names.iter().map(|n| n.split(' ').count()).max().unwrap_or(1).min(MAX_WORDS);
    // per target note, in order of first hit: (path, folded name, as written, hits of that name)
    let mut found: Vec<(&String, String, String, usize)> = vec![];
    for h in find_mentions(body, &names, max_words) {
        // a name two notes share mentions both
        for p in named[&h.name_folded].iter().filter(|p| *p != path && !out.contains(*p)) {
            match found.iter_mut().find(|f| f.0 == p) {
                Some(f) if f.1 == h.name_folded => f.3 += 1,
                Some(_) => {}
                None => found.push((p, h.name_folded.clone(), h.as_written.clone(), 1)),
            }
        }
    }
    let mut mentions = vec![];
    for (p, _, name, count) in found {
        mentions.extend(node(index, p)?.map(|node| Mention { node, name, count }));
    }
    mentions.sort_by_key(|m| std::cmp::Reverse(m.node.modified));

    Ok(Connections { centre, links_out: nodes(index, out)?, links_in: nodes(index, sources)?, tags, mentions })
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
        let c = v.connections(&p(&d, "C.md")).unwrap();
        assert_eq!(c.centre.title, "C");
        assert_eq!(paths(&c.links_out), [p(&d, "A.md")]);
        assert_eq!(paths(&c.links_in), [p(&d, "B.md")]);
        assert_eq!(c.tags.len(), 1);
        assert_eq!((c.tags[0].tag.as_str(), c.tags[0].count), ("t", 1));
        assert_eq!(paths(&c.tags[0].notes), [p(&d, "D.md")]);
        assert_eq!(c.mentions.len(), 1);
        assert_eq!((c.mentions[0].node.path.clone(), c.mentions[0].name.as_str(), c.mentions[0].count), (p(&d, "Delta.md"), "Delta", 1));
    }

    #[test] fn alias_link_is_a_backlink() {
        let (v, d) = vault(&[("Nicholas.md", "---\naliases: [Nick]\n---\n"), ("B.md", "[[Nick]]")], "", false);
        assert_eq!(paths(&v.connections(&p(&d, "Nicholas.md")).unwrap().links_in), [p(&d, "B.md")]);
    }

    #[test] fn big_tag_collapses() {
        let mut files = vec![("C.md".to_string(), "#big".to_string())];
        files.extend((0..17).map(|i| (format!("n{i}.md"), "#big".to_string())));
        let files: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (v, d) = vault(&files, "", false);
        let c = v.connections(&p(&d, "C.md")).unwrap();
        assert_eq!(c.tags[0].count, 17);
        assert!(c.tags[0].notes.is_empty());
    }

    #[test] fn linked_note_is_not_a_mention() {
        let (v, d) = vault(&[("C.md", "[[Alpha]] and Alpha again"), ("Alpha.md", "")], "", false);
        let c = v.connections(&p(&d, "C.md")).unwrap();
        assert_eq!(paths(&c.links_out), [p(&d, "Alpha.md")]);
        assert!(c.mentions.is_empty());
    }

    #[test] fn mention_counts_its_spelling_and_every_note_it_names() {
        let (v, d) = vault(&[("C.md", "velo roadmap, Velo Roadmap, plan"), ("Velo roadmap.md", ""), ("Other.md", "---\naliases: [Velo roadmap]\n---\n")], "", false);
        let c = v.connections(&p(&d, "C.md")).unwrap();
        let mut got: Vec<_> = c.mentions.iter().map(|m| (m.node.path.clone(), m.name.as_str(), m.count)).collect();
        got.sort();
        assert_eq!(got, [(p(&d, "Other.md"), "velo roadmap", 2), (p(&d, "Velo roadmap.md"), "velo roadmap", 2)]);
    }

    #[test] fn locked_centre_refused_until_unlocked() {
        let id = crypto::new_identity();
        let files = [("L.md.age", "[[Alpha]]"), ("Alpha.md", "")];
        let (v, d) = vault(&files, &id, false);
        assert_eq!(v.connections(&p(&d, "L.md.age")).unwrap_err().to_string(), "locked");
        let (v, d) = vault(&files, &id, true);
        let c = v.connections(&p(&d, "L.md.age")).unwrap();
        assert!(c.centre.locked);
        assert_eq!(paths(&c.links_out), [p(&d, "Alpha.md")]);
    }

    #[test] fn locked_neighbour_is_a_node_without_its_links() {
        let id = crypto::new_identity();
        let files = [("L.md.age", "[[C]] #t"), ("C.md", "[[L]] #t")];
        let (v, d) = vault(&files, &id, false);
        let c = v.connections(&p(&d, "C.md")).unwrap();
        assert_eq!(c.links_out.len(), 1);
        assert_eq!((c.links_out[0].title.as_str(), c.links_out[0].locked), ("L", true));
        assert!(c.links_in.is_empty());
        assert_eq!((c.tags[0].count, c.tags[0].notes.len()), (0, 0));
        // unlocked: its links and tags come from memory
        let (v, d) = vault(&files, &id, true);
        let c = v.connections(&p(&d, "C.md")).unwrap();
        assert_eq!(paths(&c.links_in), [p(&d, "L.md.age")]);
        assert_eq!(paths(&c.tags[0].notes), [p(&d, "L.md.age")]);
    }
}
