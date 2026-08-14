//! Deterministic Knowledge Core contracts shared by Desktop, CLI and MCP.
//!
//! The first Rust milestone deliberately keeps storage behind [`CoreStore`].
//! This lets us port the existing TypeScript SQLite/FTS/graph behavior with
//! fixture parity before coupling the core to a particular SQLite binding.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[macro_use]
extern crate lazy_static;

pub mod store;
pub mod scanner;
pub mod chunker;
pub mod document_parser;
pub mod indexer;

pub const WORKSPACE_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("workspace manifest not found from {0}")]
    WorkspaceRequired(PathBuf),
    #[error("workspace manifest is invalid: {0}")]
    InvalidWorkspaceManifest(String),
    #[error("document {0} was not found")]
    DocumentNotFound(String),
    #[error("graph depth must be between 1 and 3")]
    InvalidGraphDepth,
    #[error("storage error: {0}")]
    Storage(String),
}

impl From<rusqlite::Error> for CoreError {
    fn from(error: rusqlite::Error) -> Self {
        CoreError::Storage(error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceManifest {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub root: String,
    #[serde(rename = "createdAt", alias = "created_at")]
    pub created_at: String,
}

impl WorkspaceManifest {
    pub fn load_from_root(root: impl AsRef<Path>) -> Result<Self, CoreError> {
        let path = root.as_ref().join(".llm-wiki").join("workspace.json");
        let bytes = fs::read(&path).map_err(|_| CoreError::WorkspaceRequired(path.clone()))?;
        let manifest: Self = serde_json::from_slice(&bytes)
            .map_err(|error| CoreError::InvalidWorkspaceManifest(error.to_string()))?;
        if manifest.version != WORKSPACE_MANIFEST_VERSION
            || manifest.id.trim().is_empty()
            || manifest.title.trim().is_empty()
            || manifest.root.trim().is_empty()
        {
            return Err(CoreError::InvalidWorkspaceManifest(
                "version, id, title and root are required".to_owned(),
            ));
        }
        Ok(manifest)
    }

    pub fn discover_from(start: impl AsRef<Path>) -> Result<(PathBuf, Self), CoreError> {
        let mut current = start
            .as_ref()
            .canonicalize()
            .unwrap_or_else(|_| start.as_ref().to_path_buf());
        loop {
            let manifest_path = current.join(".llm-wiki").join("workspace.json");
            if manifest_path.is_file() {
                return Ok((current.clone(), Self::load_from_root(&current)?));
            }
            if !current.pop() {
                return Err(CoreError::WorkspaceRequired(start.as_ref().to_path_buf()));
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentNode {
    pub id: String,
    pub path: String,
    pub title: String,
    pub slug: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelationEvidence {
    pub source_kind: String,
    pub original_target: String,
    pub source_path: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub evidence_text: Option<String>,
    pub rationale: Option<String>,
    /// Confidence is kept as a normalized score to match the SQLite graph
    /// schema and the existing TypeScript graph API (`0 < score <= 1`).
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentRelation {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub source_path: String,
    pub target_path: String,
    pub source_title: String,
    pub target_title: String,
    pub relation_type: String,
    pub evidence: Vec<RelationEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentNeighborhood {
    pub center: DocumentNode,
    pub nodes: Vec<DocumentNode>,
    pub relations: Vec<DocumentRelation>,
    pub depth: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphSearchContext {
    pub seed_id: String,
    pub related_id: String,
    pub related_path: String,
    pub related_title: String,
    pub relation_type: String,
    pub direction: String,
    pub evidence: Vec<RelationEvidence>,
}

/// Storage contract to be implemented by the SQLite adapter.
pub trait CoreStore {
    fn document(&self, id: &str) -> Result<Option<DocumentNode>, CoreError>;
    fn relation_list(&self, document_id: &str) -> Result<Vec<DocumentRelation>, CoreError>;
}

pub struct KnowledgeCore<S> {
    store: S,
}

impl<S: CoreStore> KnowledgeCore<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn document_neighborhood(
        &self,
        document_id: &str,
        depth: u8,
    ) -> Result<DocumentNeighborhood, CoreError> {
        if !(1..=3).contains(&depth) {
            return Err(CoreError::InvalidGraphDepth);
        }
        let center = self
            .store
            .document(document_id)?
            .ok_or_else(|| CoreError::DocumentNotFound(document_id.to_owned()))?;
        let mut nodes = BTreeMap::from([(center.id.clone(), center.clone())]);
        let mut relations = BTreeMap::new();
        let mut frontier = VecDeque::from([center.id.clone()]);
        for _ in 0..depth {
            let mut next = VecDeque::new();
            while let Some(current) = frontier.pop_front() {
                for relation in self.store.relation_list(&current)? {
                    relations.insert(relation.id.clone(), relation.clone());
                    for related_id in [&relation.source_id, &relation.target_id] {
                        if !nodes.contains_key(related_id) {
                            if let Some(node) = self.store.document(related_id)? {
                                nodes.insert(node.id.clone(), node);
                                next.push_back(related_id.clone());
                            }
                        }
                    }
                }
            }
            frontier = next;
        }
        Ok(DocumentNeighborhood {
            center,
            nodes: nodes.into_values().collect(),
            relations: relations.into_values().collect(),
            depth,
        })
    }

    pub fn graph_search_context(
        &self,
        seed_ids: &[String],
        per_seed_limit: usize,
    ) -> Result<Vec<GraphSearchContext>, CoreError> {
        let limit = per_seed_limit.clamp(1, 10);
        let mut seen = BTreeSet::new();
        let mut result = Vec::new();
        for seed_id in seed_ids {
            for relation in self.store.relation_list(seed_id)?.into_iter().take(limit) {
                let outgoing = relation.source_id == *seed_id;
                let related_id = if outgoing {
                    &relation.target_id
                } else {
                    &relation.source_id
                };
                let key = format!("{seed_id}:{related_id}:{}", relation.relation_type);
                if !seen.insert(key) {
                    continue;
                }
                result.push(GraphSearchContext {
                    seed_id: seed_id.clone(),
                    related_id: related_id.clone(),
                    related_path: if outgoing {
                        relation.target_path
                    } else {
                        relation.source_path
                    },
                    related_title: if outgoing {
                        relation.target_title
                    } else {
                        relation.source_title
                    },
                    relation_type: relation.relation_type,
                    direction: if outgoing { "outgoing" } else { "incoming" }.to_owned(),
                    evidence: relation.evidence,
                });
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FixtureStore {
        docs: BTreeMap<String, DocumentNode>,
        relations: Vec<DocumentRelation>,
    }

    impl CoreStore for FixtureStore {
        fn document(&self, id: &str) -> Result<Option<DocumentNode>, CoreError> {
            Ok(self.docs.get(id).cloned())
        }

        fn relation_list(&self, document_id: &str) -> Result<Vec<DocumentRelation>, CoreError> {
            Ok(self
                .relations
                .iter()
                .filter(|relation| {
                    relation.source_id == document_id || relation.target_id == document_id
                })
                .cloned()
                .collect())
        }
    }

    fn fixture() -> FixtureStore {
        let mut store = FixtureStore::default();
        for (id, title) in [("a", "A"), ("b", "B"), ("c", "C")] {
            store.docs.insert(
                id.to_owned(),
                DocumentNode {
                    id: id.to_owned(),
                    path: format!("wiki/{id}.md"),
                    title: title.to_owned(),
                    slug: id.to_owned(),
                    tags: Vec::new(),
                },
            );
        }
        store.relations.push(DocumentRelation {
            id: "r1".into(),
            source_id: "a".into(),
            target_id: "b".into(),
            source_path: "wiki/a.md".into(),
            target_path: "wiki/b.md".into(),
            source_title: "A".into(),
            target_title: "B".into(),
            relation_type: "depends_on".into(),
            evidence: Vec::new(),
        });
        store.relations.push(DocumentRelation {
            id: "r2".into(),
            source_id: "b".into(),
            target_id: "c".into(),
            source_path: "wiki/b.md".into(),
            target_path: "wiki/c.md".into(),
            source_title: "B".into(),
            target_title: "C".into(),
            relation_type: "implements".into(),
            evidence: Vec::new(),
        });
        store
    }

    #[test]
    fn neighborhood_traverses_at_most_three_levels() {
        let graph = KnowledgeCore::new(fixture())
            .document_neighborhood("a", 2)
            .unwrap();
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.relations.len(), 2);
    }

    #[test]
    fn search_context_keeps_graph_separate() {
        let context = KnowledgeCore::new(fixture())
            .graph_search_context(&["a".into()], 3)
            .unwrap();
        assert_eq!(context[0].related_path, "wiki/b.md");
        assert_eq!(context[0].direction, "outgoing");
    }

    #[test]
    fn workspace_manifest_uses_cli_compatible_created_at() {
        let manifest: WorkspaceManifest = serde_json::from_str(
            r#"{"version":1,"id":"demo","title":"Demo","root":"/tmp/demo","createdAt":"2026-08-12T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(manifest.created_at, "2026-08-12T00:00:00Z");
        let encoded = serde_json::to_value(manifest).unwrap();
        assert!(encoded.get("createdAt").is_some());
        assert!(encoded.get("created_at").is_none());
    }
}
