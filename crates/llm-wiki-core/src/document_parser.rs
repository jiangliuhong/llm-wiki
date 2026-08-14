//! Document parser — Rust port of `packages/kb/src/document-parser.ts`.
//!
//! Parses markdown (and plain-text) files into a structured document: title,
//! slug, summary, tags, body, sections, and parsed relation references
//! (frontmatter, markdown links, wikilinks). All parsing is hand-rolled regex,
//! matching the TS implementation exactly — no external markdown/YAML library.

use regex::Regex;

/// A parsed relation reference found in the document.
#[derive(Debug, Clone)]
pub struct ParsedRelationReference {
    pub relation_type: String,
    pub target: String,
    pub source_kind: RelationSourceKind,
    pub start_line: u32,
    pub evidence_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationSourceKind {
    Frontmatter,
    MarkdownLink,
    Wikilink,
}

impl RelationSourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Frontmatter => "frontmatter",
            Self::MarkdownLink => "markdown_link",
            Self::Wikilink => "wikilink",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ParsedDocumentSection {
    pub heading: String,
    pub slug: String,
    pub level: u32,
    pub start_line: u32,
}

/// The fully parsed document, ready for indexing.
#[derive(Debug, Clone)]
pub struct ParsedDocument {
    pub title: String,
    pub slug: String,
    pub summary: Option<String>,
    pub tags: Vec<String>,
    pub body: String,
    pub body_start_line: u32,
    pub metadata: serde_json::Value,
    pub relations: Vec<ParsedRelationReference>,
    pub sections: Vec<ParsedDocumentSection>,
}

/// Normalizes a relation type: lowercase, non-alphanumeric → `_`, trimmed.
/// Mirrors `normalizeRelationType`.
pub fn normalize_relation_type(value: &str) -> String {
    lazy_static! {
        static ref NON_ALNUM: Regex = Regex::new(r"[^\p{L}\p{N}]+").unwrap();
        static ref LEAD_TRAIL_UNDER: Regex = Regex::new(r"^_+|_+$").unwrap();
    }
    let lower = value.trim().to_lowercase();
    let cleaned = NON_ALNUM.replace_all(&lower, "_");
    let trimmed = LEAD_TRAIL_UNDER.replace_all(&cleaned, "");
    if trimmed.is_empty() { "related_to".to_owned() } else { trimmed.into_owned() }
}

/// Slugifies a heading or title for use as an anchor. Mirrors `slugifyDocument`.
pub fn slugify_document(value: &str) -> String {
    lazy_static! {
        static ref NON_ALNUM: Regex = Regex::new(r"[^\p{L}\p{N}]+").unwrap();
        static ref LEAD_TRAIL_DASH: Regex = Regex::new(r"^-+|-+$").unwrap();
    }
    let lower = value.trim().to_lowercase();
    let cleaned = NON_ALNUM.replace_all(&lower, "-");
    let trimmed = LEAD_TRAIL_DASH.replace_all(&cleaned, "");
    if trimmed.is_empty() { "document".to_owned() } else { trimmed.into_owned() }
}

/// Parses a document's content. For markdown files, extracts frontmatter,
/// relations, sections, and metadata. For other files, treats content as-is.
/// Mirrors `parseDocument`.
pub fn parse_document(content: &str, path: &str) -> ParsedDocument {
    let is_markdown = is_markdown_path(path);

    let frontmatter = if is_markdown {
        parse_frontmatter(content)
    } else {
        FrontmatterResult::no_frontmatter(content)
    };

    let body = &frontmatter.body;
    let lines: Vec<&str> = body.split('\n').collect();

    let first_heading = if is_markdown {
        lines.iter().find(|line| is_h1_heading(line))
    } else {
        None
    };

    let fallback_title = file_basename(path);

    // Title: frontmatter title > first H1 > basename
    let title = string_value_from_meta(&frontmatter.metadata, "title")
        .or_else(|| first_heading.map(|h| strip_h1_prefix(h).trim().to_owned()))
        .unwrap_or_else(|| fallback_title.clone());

    let summary = string_value_from_meta(&frontmatter.metadata, "summary");
    let tags = parse_string_list(&frontmatter.metadata, "tags");

    let mut relations = if is_markdown {
        parse_frontmatter_relations(&frontmatter.raw_lines)
    } else {
        Vec::new()
    };

    // Scan body for markdown links and wikilinks.
    if is_markdown {
        lazy_static! {
            // Markdown link: [text](target) but NOT ![alt](src) (image)
            static ref MD_LINK: Regex = Regex::new(r#"\[[^\]]+\]\(([^)]+)\)"#).unwrap();
            static ref WIKILINK: Regex = Regex::new(r#"\[\[([^\]]+)\]\]"#).unwrap();
        }
        for (index, line) in lines.iter().enumerate() {
            let source_line = frontmatter.body_start_line + index as u32;
            // Markdown links (skip images by checking preceding char isn't '!')
            for caps in MD_LINK.captures_iter(line) {
                let target_raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let target = clean_link_target(target_raw);
                if is_local_target(&target) {
                    let start = caps.get(0).unwrap().start();
                    let is_image = start > 0 && line.as_bytes()[start - 1] == b'!';
                    if !is_image {
                        relations.push(ParsedRelationReference {
                            relation_type: "references".into(),
                            target,
                            source_kind: RelationSourceKind::MarkdownLink,
                            start_line: source_line,
                            evidence_text: line.trim().to_owned(),
                        });
                    }
                }
            }
            // Wikilinks
            for caps in WIKILINK.captures_iter(line) {
                let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let target_str = inner.split('|').next().unwrap_or("");
                let target = clean_link_target(target_str);
                if !target.is_empty() {
                    relations.push(ParsedRelationReference {
                        relation_type: "references".into(),
                        target,
                        source_kind: RelationSourceKind::Wikilink,
                        start_line: source_line,
                        evidence_text: line.trim().to_owned(),
                    });
                }
            }
        }
    }

    // Sections (markdown only).
    let sections = if is_markdown {
        lazy_static! {
            static ref HEADING: Regex = Regex::new(r"^(#{1,6})\s+(.+?)\s*$").unwrap();
        }
        lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                let caps = HEADING.captures(line)?;
                let hashes = caps.get(1)?;
                let heading = caps.get(2)?;
                Some(ParsedDocumentSection {
                    heading: heading.as_str().to_owned(),
                    slug: slugify_document(heading.as_str()),
                    level: hashes.as_str().len() as u32,
                    start_line: frontmatter.body_start_line + index as u32,
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    let slug = string_value_from_meta(&frontmatter.metadata, "slug")
        .map(|s| slugify_document(&s))
        .unwrap_or_else(|| slugify_document(&title));

    ParsedDocument {
        title,
        slug,
        summary,
        tags,
        body: frontmatter.body.clone(),
        body_start_line: frontmatter.body_start_line,
        metadata: serde_json::to_value(&frontmatter.metadata).unwrap_or_default(),
        relations,
        sections,
    }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

struct FrontmatterResult {
    body: String,
    body_start_line: u32,
    metadata: std::collections::BTreeMap<String, serde_json::Value>,
    raw_lines: Vec<String>,
}

impl FrontmatterResult {
    fn no_frontmatter(content: &str) -> Self {
        Self {
            body: content.to_owned(),
            body_start_line: 1,
            metadata: std::collections::BTreeMap::new(),
            raw_lines: Vec::new(),
        }
    }
}

fn parse_frontmatter(content: &str) -> FrontmatterResult {
    let lines: Vec<&str> = content.split('\n').collect();

    if lines.is_empty() || lines[0].trim() != "---" {
        return FrontmatterResult::no_frontmatter(content);
    }

    // Find the closing `---`
    let closing_idx = lines.iter().skip(1).position(|line| line.trim() == "---");
    let end = match closing_idx {
        Some(e) => e,
        None => return FrontmatterResult::no_frontmatter(content),
    };
    let closing_index = end + 1; // 1-based offset since we skipped lines[0]

    let raw_lines: Vec<String> = lines[1..closing_index].iter().map(|s: &&str| (*s).to_owned()).collect();
    let mut metadata: std::collections::BTreeMap<String, serde_json::Value> = std::collections::BTreeMap::new();

    lazy_static! {
        static ref KV_LINE: Regex = Regex::new(r"^([A-Za-z0-9_-]+):\s*(.*)$").unwrap();
    }
    for line in &raw_lines {
        if let Some(caps) = KV_LINE.captures(line) {
            let key = caps.get(1).unwrap().as_str();
            if key == "relations" {
                continue;
            }
            let value = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            metadata.insert(key.to_owned(), parse_scalar_or_list(value));
        }
    }

    let body = lines[closing_index + 1..].join("\n");
    let body_start_line = (closing_index + 2) as u32;

    FrontmatterResult { body, body_start_line, metadata, raw_lines }
}

/// Parses the `relations:` block in frontmatter into relation references.
/// Mirrors `parseFrontmatterRelations`.
fn parse_frontmatter_relations(lines: &[String]) -> Vec<ParsedRelationReference> {
    lazy_static! {
        static ref RELATIONS_HEADER: Regex = Regex::new(r"^relations:\s*$").unwrap();
        static ref TOP_LEVEL_KEY: Regex = Regex::new(r"^[A-Za-z0-9_-]+:").unwrap();
        static ref ITEM_LINE: Regex = Regex::new(r"^\s*-\s*(?:type:\s*)?(.+?)\s*$").unwrap();
        static ref FIELD_TYPE: Regex = Regex::new(r"^\s+type:\s*(.+?)\s*$").unwrap();
        static ref FIELD_TARGET: Regex = Regex::new(r"^\s+target:\s*(.+?)\s*$").unwrap();
    }

    let mut result = Vec::new();
    let mut in_relations = false;
    let mut current: Option<PendingRelation> = None;

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if RELATIONS_HEADER.is_match(trimmed) {
            in_relations = true;
            continue;
        }
        if in_relations && TOP_LEVEL_KEY.is_match(line) && !line.starts_with(' ') {
            // Flush current and exit relations block.
            if let Some(c) = current.take() {
                flush_pending(c, &mut result);
            }
            in_relations = false;
        }
        if !in_relations {
            continue;
        }

        if let Some(caps) = ITEM_LINE.captures(line) {
            // New list item.
            if let Some(c) = current.take() {
                flush_pending(c, &mut result);
            }
            let mut pending = PendingRelation {
                rel_type: None,
                target: None,
                line: (index + 2) as u32,
                evidence: vec![trimmed.to_owned()],
            };
            if line.contains("type:") {
                pending.rel_type = Some(unquote(caps.get(1).unwrap().as_str()));
            }
            current = Some(pending);
            continue;
        }

        let Some(ref mut cur) = current else { continue; };
        cur.evidence.push(trimmed.to_owned());

        if let Some(caps) = FIELD_TYPE.captures(line) {
            cur.rel_type = Some(unquote(caps.get(1).unwrap().as_str()));
        }
        if let Some(caps) = FIELD_TARGET.captures(line) {
            cur.target = Some(clean_link_target(&unquote(caps.get(1).unwrap().as_str())));
        }
    }
    if let Some(c) = current {
        flush_pending(c, &mut result);
    }
    result
}

struct PendingRelation {
    rel_type: Option<String>,
    target: Option<String>,
    line: u32,
    evidence: Vec<String>,
}

fn flush_pending(pending: PendingRelation, out: &mut Vec<ParsedRelationReference>) {
    if let Some(target) = pending.target {
        out.push(ParsedRelationReference {
            relation_type: normalize_relation_type(&pending.rel_type.unwrap_or_else(|| "related_to".into())),
            target,
            source_kind: RelationSourceKind::Frontmatter,
            start_line: pending.line,
            evidence_text: pending.evidence.join(" ").trim().to_owned(),
        });
    }
}

// ---------------------------------------------------------------------------
// Small helpers (mirrors the TS helper functions)
// ---------------------------------------------------------------------------

fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".mdx")
}

fn file_basename(path: &str) -> String {
    let p = std::path::Path::new(path);
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_owned())
}

fn is_h1_heading(line: &str) -> bool {
    line.starts_with("# ") || line.starts_with("#\t")
}

fn strip_h1_prefix(line: &str) -> String {
    line.trim_start_matches('#').trim_start().to_owned()
}

/// Returns a trimmed non-empty string value for a metadata key.
fn string_value_from_meta(
    meta: &std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    match meta.get(key)? {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) }
        }
        _ => None,
    }
}

/// Parses a metadata value that may be a string or a JSON-style array `[a, b, c]`.
fn parse_scalar_or_list(value: &str) -> serde_json::Value {
    let trimmed = value.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let items: Vec<serde_json::Value> = inner
            .split(',')
            .map(|item| unquote(item.trim()))
            .filter(|s| !s.is_empty())
            .map(serde_json::Value::String)
            .collect();
        serde_json::Value::Array(items)
    } else {
        serde_json::Value::String(unquote(trimmed))
    }
}

/// Parses a string list from metadata (dedupes, preserves order).
fn parse_string_list(
    meta: &std::collections::BTreeMap<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(serde_json::Value::Array(arr)) = meta.get(key) {
        for item in arr {
            if let serde_json::Value::String(s) = item {
                let trimmed = s.trim();
                if !trimmed.is_empty() && seen.insert(trimmed.to_owned()) {
                    out.push(trimmed.to_owned());
                }
            }
        }
    } else if let Some(serde_json::Value::String(s)) = meta.get(key) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_owned());
        }
    }
    out
}

/// Strips surrounding single or double quotes and trims.
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    let stripped = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| trimmed.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(trimmed);
    stripped.trim().to_owned()
}

/// Cleans a link target: strips `<>`, splits off `#` and `?` fragments.
fn clean_link_target(value: &str) -> String {
    let stripped = value.trim().trim_start_matches('<').trim_end_matches('>');
    let no_fragment = stripped.split('#').next().unwrap_or("");
    let no_query = no_fragment.split('?').next().unwrap_or("");
    no_query.trim().to_owned()
}

/// A target is "local" if it's non-empty, not a URL scheme, and not a pure anchor.
fn is_local_target(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    lazy_static! {
        static ref SCHEME: Regex = Regex::new(r"^[a-z][a-z0-9+.-]*:").unwrap();
    }
    !SCHEME.is_match(value) && !value.starts_with('#')
}

/// Used by `lazy_static!`.
// lazy_static is imported as a crate; no custom module needed.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_markdown_frontmatter() {
        let content = "---\ntitle: My Doc\nsummary: A summary\ntags: [a, b, c]\n---\n# Heading\n\nBody text";
        let doc = parse_document(content, "wiki/test.md");
        assert_eq!(doc.title, "My Doc");
        assert_eq!(doc.summary.as_deref(), Some("A summary"));
        assert_eq!(doc.tags, vec!["a", "b", "c"]);
        assert_eq!(doc.body_start_line, 6);
        assert_eq!(doc.sections.len(), 1);
        assert_eq!(doc.sections[0].heading, "Heading");
        assert_eq!(doc.sections[0].level, 1);
    }

    #[test]
    fn title_falls_back_to_first_heading() {
        let content = "# Hello World\n\nBody";
        let doc = parse_document(content, "wiki/test.md");
        assert_eq!(doc.title, "Hello World");
    }

    #[test]
    fn title_falls_back_to_basename() {
        let content = "No heading here";
        let doc = parse_document(content, "wiki/my-file.md");
        assert_eq!(doc.title, "my-file");
    }

    #[test]
    fn extracts_markdown_links() {
        let content = "# Doc\nSee [other](wiki/other.md) for details.";
        let doc = parse_document(content, "wiki/test.md");
        let links: Vec<_> = doc.relations.iter().filter(|r| r.source_kind == RelationSourceKind::MarkdownLink).collect();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "wiki/other.md");
    }

    #[test]
    fn skips_image_links() {
        let content = "![alt](image.png)";
        let doc = parse_document(content, "wiki/test.md");
        assert!(doc.relations.is_empty(), "image link should not create a relation");
    }

    #[test]
    fn extracts_wikilinks() {
        let content = "# Doc\nSee [[Other Page]] for details.";
        let doc = parse_document(content, "wiki/test.md");
        let wikis: Vec<_> = doc.relations.iter().filter(|r| r.source_kind == RelationSourceKind::Wikilink).collect();
        assert_eq!(wikis.len(), 1);
        assert_eq!(wikis[0].target, "Other Page");
    }

    #[test]
    fn extracts_frontmatter_relations() {
        let content = "---\nrelations:\n  - type: depends_on\n    target: wiki/base.md\n---\n# Doc";
        let doc = parse_document(content, "wiki/test.md");
        let fm_rels: Vec<_> = doc.relations.iter().filter(|r| r.source_kind == RelationSourceKind::Frontmatter).collect();
        assert_eq!(fm_rels.len(), 1);
        assert_eq!(fm_rels[0].relation_type, "depends_on");
        assert_eq!(fm_rels[0].target, "wiki/base.md");
    }

    #[test]
    fn skips_url_targets() {
        let content = "# Doc\nSee [google](https://google.com)";
        let doc = parse_document(content, "wiki/test.md");
        assert!(doc.relations.is_empty(), "URL link should not create a relation");
    }

    #[test]
    fn non_markdown_has_no_frontmatter() {
        let content = "just plain text";
        let doc = parse_document(content, "wiki/data.json");
        assert_eq!(doc.title, "data");
        assert_eq!(doc.body, "just plain text");
        assert!(doc.sections.is_empty());
    }

    #[test]
    fn normalize_relation_type_works() {
        assert_eq!(normalize_relation_type("Depends On"), "depends_on");
        assert_eq!(normalize_relation_type("references"), "references");
        assert_eq!(normalize_relation_type(""), "related_to");
        assert_eq!(normalize_relation_type("  Multiple   Spaces  "), "multiple_spaces");
    }

    #[test]
    fn slugify_handles_unicode() {
        assert_eq!(slugify_document("Hello World"), "hello-world");
        assert_eq!(slugify_document("国家数据权限"), "国家数据权限");
    }
}
