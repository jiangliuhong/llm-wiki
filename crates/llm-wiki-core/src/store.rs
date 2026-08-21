//! SQLite adapter over the knowledge-base index.
//!
//! This module mirrors the TypeScript `@llm-wiki/kb` read surface
//! (`reader.ts`, `graph.ts`) so the Tauri desktop app can read the very same
//! `<root>/.llm-wiki/index.db` that the CLI writes — without spawning Node or
//! reimplementing the indexer. Every read query opens a short-lived read-only
//! connection and tolerates a missing / partially-initialized database by
//! returning well-formed empty results, matching the TS behavior
//! (`tablesOk: false`).
//!
//! Draft lifecycle (create/list/get/apply/reject) is also implemented here
//! using read-write connections, following architecture-v1.md §10.2 and §8.6.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::document_parser::normalize_relation_type;
use crate::CoreError;

/// Directory name (relative to the workspace root) holding the index DB.
/// Mirrors `KB_DIR_NAME` in `packages/kb/src/db/connection.ts`.
pub const KB_DIR_NAME: &str = ".llm-wiki";
/// SQLite file name inside [`KB_DIR_NAME`].
pub const DB_FILE_NAME: &str = "index.db";

/// Resolves the absolute DB path for a workspace root.
/// Mirrors `resolveDbPath()` in `connection.ts`.
pub fn resolve_db_path(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(KB_DIR_NAME).join(DB_FILE_NAME)
}

// ---------------------------------------------------------------------------
// Public response types (camelCase via serde, matching the TS contracts in
// `packages/kb/src/types.ts` so the frontend can consume them unchanged).
// ---------------------------------------------------------------------------

/// A lightweight file row for list views. Mirrors `KbFileSummary`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFileSummary {
    pub id: i64,
    pub path: String,
    pub language: String,
    pub size: i64,
    #[serde(rename = "indexedAt")]
    pub indexed_at: Option<String>,
    pub chunk_count: i64,
}

/// Paginated file list. Mirrors `KbFileListPage`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFileListPage {
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub files: Vec<KbFileSummary>,
}

/// A file's reconstructed content. Mirrors `KbFileContent`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbChunkRef {
    pub id: i64,
    pub chunk_index: i64,
    #[serde(rename = "startLine")]
    pub start_line: i64,
    #[serde(rename = "endLine")]
    pub end_line: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFileContent {
    #[serde(rename = "fileId")]
    pub file_id: i64,
    pub path: String,
    pub language: String,
    pub content: String,
    pub chunks: Vec<KbChunkRef>,
}

/// Per-language / per-root file counts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbLanguageStat {
    pub language: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbRootStat {
    pub root: String,
    pub count: i64,
}

/// Aggregated index health metrics. Mirrors `KbStats`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbStats {
    #[serde(rename = "dbPath")]
    pub db_path: String,
    pub files: i64,
    pub chunks: i64,
    #[serde(rename = "ftsRecords")]
    pub fts_records: i64,
    #[serde(rename = "vectorRecords")]
    pub vector_records: i64,
    #[serde(rename = "earliestIndexedAt")]
    pub earliest_indexed_at: Option<String>,
    #[serde(rename = "latestIndexedAt")]
    pub latest_indexed_at: Option<String>,
    /// Whether all required tables exist (files / chunks / chunks_fts).
    #[serde(rename = "tablesOk")]
    pub tables_ok: bool,
    #[serde(rename = "vectorEnabled")]
    pub vector_enabled: bool,
    #[serde(rename = "byLanguage")]
    pub by_language: Vec<KbLanguageStat>,
    #[serde(rename = "byRoot")]
    pub by_root: Vec<KbRootStat>,
}

/// Relation proposal status. Mirrors `RelationProposalStatus`.
pub type RelationProposalStatus = String;

/// A pending/approved/rejected relation proposal. Mirrors `RelationProposal`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationProposal {
    pub id: i64,
    #[serde(rename = "sourceFileId")]
    pub source_file_id: Option<i64>,
    #[serde(rename = "targetFileId")]
    pub target_file_id: Option<i64>,
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    #[serde(rename = "relationType")]
    pub relation_type: String,
    pub confidence: f64,
    pub rationale: String,
    #[serde(rename = "evidencePath")]
    pub evidence_path: String,
    #[serde(rename = "evidenceStartLine")]
    pub evidence_start_line: i64,
    #[serde(rename = "evidenceEndLine")]
    pub evidence_end_line: i64,
    #[serde(rename = "evidenceText")]
    pub evidence_text: Option<String>,
    pub status: RelationProposalStatus,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "reviewedAt")]
    pub reviewed_at: Option<String>,
}

/// Input for creating a new relation proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationProposalCreateInput {
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    #[serde(rename = "relationType")]
    pub relation_type: String,
    pub confidence: f64,
    pub rationale: String,
    #[serde(rename = "evidencePath")]
    pub evidence_path: String,
    #[serde(rename = "evidenceStartLine")]
    pub evidence_start_line: i64,
    #[serde(rename = "evidenceEndLine")]
    pub evidence_end_line: i64,
    #[serde(rename = "evidenceText")]
    pub evidence_text: Option<String>,
}

/// Evidence backing a published relation. Mirrors `RelationEvidence`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEvidence {
    pub id: i64,
    #[serde(rename = "sourceKind")]
    pub source_kind: String,
    #[serde(rename = "originalTarget")]
    pub original_target: String,
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "startLine")]
    pub start_line: Option<i64>,
    #[serde(rename = "endLine")]
    pub end_line: Option<i64>,
    #[serde(rename = "evidenceText")]
    pub evidence_text: Option<String>,
    pub rationale: Option<String>,
    pub confidence: f64,
}

/// A published (approved) relation edge. Mirrors `DocumentRelation`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRelation {
    pub id: i64,
    #[serde(rename = "sourceFileId")]
    pub source_file_id: i64,
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    #[serde(rename = "targetFileId")]
    pub target_file_id: i64,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    #[serde(rename = "targetTitle")]
    pub target_title: String,
    #[serde(rename = "relationType")]
    pub relation_type: String,
    /// `true` when the relation type is marked symmetric.
    pub symmetric: bool,
    pub evidence: Vec<RelationEvidence>,
}

/// Options for listing files.
#[derive(Debug, Clone, Default)]
pub struct ListFilesOptions {
    pub page: Option<i64>,
    pub page_size: Option<i64>,
    pub q: Option<String>,
}

// ---------------------------------------------------------------------------
// Draft types (待确认草稿) — per architecture-v1.md §10.2
// ---------------------------------------------------------------------------

/// A pending draft awaiting user confirmation. Mirrors the `drafts` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: i64,
    pub draft_id: String,
    pub workspace_id: String,
    pub target_path: String,
    pub operation_type: String,
    pub base_document_hash: String,
    pub generated_content: String,
    pub source_citations: Vec<String>,
    /// For `update_section` drafts: the slug of the heading to replace.
    /// Empty for other operation types.
    pub section_slug: String,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
    pub reviewed_at: Option<String>,
}

/// Input for creating a new draft.
#[derive(Debug, Clone)]
pub struct DraftCreateInput {
    pub workspace_id: String,
    pub target_path: String,
    pub operation_type: String,
    pub base_document_hash: String,
    pub generated_content: String,
    pub source_citations: Vec<String>,
    pub section_slug: String,
    pub created_by: String,
}

/// Result of applying a draft.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftApplyResult {
    pub draft_id: String,
    pub target_path: String,
    pub content_hash: String,
    pub bytes_written: i64,
    pub backup_path: Option<String>,
}

/// A single FTS5 search hit. Mirrors the FTS portion of TS `SearchHit`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chunk_id: i64,
    pub file_id: i64,
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub content: String,
    pub preview: String,
    pub bm25: f64,
}

/// Metadata for an AI chat session. Mirrors the `chat_sessions` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionRecord {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub model_provider: String,
    pub model_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub pinned: bool,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Read-only handle over a workspace's `index.db`.
///
/// Cheap to construct; each query opens its own short-lived read-only
/// connection (matching the TS `withReadonlyDb` pattern) so concurrent CLI
/// writes never block reads.
#[derive(Debug, Clone)]
pub struct SqliteStore {
    db_path: PathBuf,
}

impl SqliteStore {
    /// Opens a store for the given workspace root, resolving
    /// `<root>/.llm-wiki/index.db`. The DB does not need to exist yet —
    /// queries return empty results when it is missing.
    pub fn from_root(root: impl AsRef<Path>) -> Self {
        Self { db_path: resolve_db_path(root) }
    }

    /// Opens a store for an explicit DB path.
    pub fn from_db_path(db_path: impl Into<PathBuf>) -> Self {
        Self { db_path: db_path.into() }
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Opens a read-only connection. Returns `Ok(None)` when the DB file does
    /// not exist (fresh workspace) so callers can short-circuit to empty
    /// results without erroring.
    fn connect(&self) -> Result<Option<Connection>, CoreError> {
        if !self.db_path.exists() {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(Some(conn))
    }

    /// Opens a read-write connection, creating the DB file if it does not yet
    /// exist. Used by draft create/apply/reject operations. The caller must
    /// ensure the base schema has been applied (by the indexer) before calling
    /// draft methods — we do not auto-create schema here to keep the read
    /// store's responsibility boundary clean.
    fn connect_write(&self) -> Result<Connection, CoreError> {
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| CoreError::Storage(e.to_string()))?;
        }
        let conn = Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        Ok(conn)
    }

    // -- schema helpers -----------------------------------------------------

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            rusqlite::params![name],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Returns true iff the base tables (files / chunks / chunks_fts) exist.
    fn base_tables_ok(conn: &Connection) -> bool {
        Self::table_exists(conn, "files")
            && Self::table_exists(conn, "chunks")
            && Self::table_exists(conn, "chunks_fts")
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        if !Self::table_exists(conn, table) {
            return 0;
        }
        // table name is a hard-coded literal from our own constant set — safe
        // to interpolate.
        let sql = format!("SELECT COUNT(*) FROM {table}");
        conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0)
    }

    // -- queries ------------------------------------------------------------

    /// Aggregated index health metrics. Safe before any index has run.
    pub fn stats(&self) -> Result<KbStats, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(empty_stats(&self.db_path));
        };
        let tables_ok = Self::base_tables_ok(&conn);
        let vec_table = Self::table_exists(&conn, "vec_chunks");
        let files = Self::count(&conn, "files");
        let chunks = Self::count(&conn, "chunks");
        let fts_records = Self::count(&conn, "chunks_fts");
        let vector_records = if vec_table { Self::count(&conn, "vec_chunks") } else { 0 };

        Ok(KbStats {
            db_path: self.db_path.to_string_lossy().into_owned(),
            files,
            chunks,
            fts_records,
            vector_records,
            earliest_indexed_at: earliest_latest(&conn, "ASC"),
            latest_indexed_at: earliest_latest(&conn, "DESC"),
            tables_ok,
            // We never load the sqlite-vec extension from the read-only store;
            // vectors are unread here but the count is still reported when the
            // table exists.
            vector_enabled: vec_table,
            by_language: by_language(&conn),
            by_root: by_root(&conn),
        })
    }

    /// Paginated file list with optional path LIKE filter.
    pub fn list_files(&self, options: ListFilesOptions) -> Result<KbFileListPage, CoreError> {
        let page = options.page.unwrap_or(1).max(1);
        let page_size = options.page_size.unwrap_or(1000).clamp(1, 10000);
        let q = options.q.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());

        let Some(conn) = self.connect()? else {
            return Ok(KbFileListPage { page, page_size, total: 0, files: vec![] });
        };
        if !Self::base_tables_ok(&conn) {
            return Ok(KbFileListPage { page, page_size, total: 0, files: vec![] });
        }

        let total = if let Some(ref q) = q {
            conn.query_row(
                "SELECT COUNT(*) FROM files f WHERE f.path LIKE ?1",
                rusqlite::params![format!("%{q}%")],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
        } else {
            Self::count(&conn, "files")
        };

        let offset = (page - 1) * page_size;
        let mut sql = String::from(
            "SELECT f.id AS id, f.path AS path, f.language AS language, f.size AS size,
                    f.indexed_at AS indexed_at, COUNT(c.id) AS chunk_count
               FROM files f
          LEFT JOIN chunks c ON c.file_id = f.id ",
        );
        let params: Vec<Box<dyn rusqlite::ToSql>> = if let Some(ref q) = q {
            sql.push_str("WHERE f.path LIKE ?1 ");
            sql.push_str("GROUP BY f.id ORDER BY f.path ASC LIMIT ?2 OFFSET ?3");
            vec![
                Box::new(format!("%{q}%")),
                Box::new(page_size),
                Box::new(offset),
            ]
        } else {
            sql.push_str("GROUP BY f.id ORDER BY f.path ASC LIMIT ?1 OFFSET ?2");
            vec![Box::new(page_size), Box::new(offset)]
        };
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql).map_err(|e| CoreError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(KbFileSummary {
                    id: row.get("id")?,
                    path: row.get("path")?,
                    language: row.get("language")?,
                    size: row.get("size")?,
                    indexed_at: row.get("indexed_at")?,
                    chunk_count: row.get("chunk_count")?,
                })
            })
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut files = Vec::new();
        for row in rows {
            files.push(row.map_err(|e| CoreError::Storage(e.to_string()))?);
        }

        Ok(KbFileListPage { page, page_size, total, files })
    }

    /// A file's full content, reassembled from `documents.body` or its chunks.
    pub fn file_content(&self, file_id: i64) -> Result<Option<KbFileContent>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(None);
        };
        if !Self::base_tables_ok(&conn) {
            return Ok(None);
        }

        let file = conn
            .query_row(
                "SELECT f.id, f.path, f.language, d.body
                   FROM files f LEFT JOIN documents d ON d.file_id = f.id
                  WHERE f.id = ?1",
                rusqlite::params![file_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let Some((id, path, language, body)) = file else {
            return Ok(None);
        };

        let mut stmt = conn
            .prepare(
                "SELECT id, chunk_index, start_line, end_line, content
                   FROM chunks WHERE file_id = ?1 ORDER BY chunk_index ASC",
            )
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let chunk_rows = stmt
            .query_map(rusqlite::params![file_id], |row| {
                Ok((
                    KbChunkRef {
                        id: row.get(0)?,
                        chunk_index: row.get(1)?,
                        start_line: row.get(2)?,
                        end_line: row.get(3)?,
                    },
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut chunks = Vec::new();
        let mut parts: Vec<String> = Vec::new();
        for row in chunk_rows {
            let (cref, content) = row.map_err(|e| CoreError::Storage(e.to_string()))?;
            chunks.push(cref);
            parts.push(content);
        }

        let content = body.unwrap_or_else(|| parts.join("\n"));
        Ok(Some(KbFileContent { file_id: id, path, language, content, chunks }))
    }

    /// Runs an FTS5 full-text search over `chunks_fts`, ordered by bm25
    /// relevance. Returns up to `limit` hits (default 20, max 100).
    ///
    /// The query uses FTS5 query syntax; for a simple keyword search, pass the
    /// raw query string. Special characters (e.g. `&`) may cause FTS5 to error
    /// — in that case the error is returned to the caller so the UI can show a
    /// helpful message. Mirrors the FTS leg of TS `searchKnowledgeBase`.
    pub fn search(&self, query: &str, limit: Option<usize>) -> Result<Vec<SearchHit>, CoreError> {
        let normalized = query.trim();
        if normalized.is_empty() {
            return Err(CoreError::Storage("search query must not be empty".into()));
        }
        let limit = limit.unwrap_or(20).clamp(1, 100);

        let Some(conn) = self.connect()? else {
            return Ok(vec![]);
        };
        if !Self::base_tables_ok(&conn) {
            return Ok(vec![]);
        }

        let mut stmt = conn.prepare(
            "SELECT c.id         AS id,
                    c.file_id    AS file_id,
                    f.path       AS path,
                    c.start_line AS start_line,
                    c.end_line   AS end_line,
                    c.content    AS content,
                    bm25(chunks_fts) AS rank
               FROM chunks_fts
               JOIN chunks AS c ON c.id = chunks_fts.rowid
               JOIN files  AS f ON f.id = c.file_id
              WHERE chunks_fts MATCH ?1
              ORDER BY rank
              LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![normalized, limit as i64], |row| {
            let content: String = row.get("content")?;
            let preview = make_preview(&content, normalized);
            Ok(SearchHit {
                chunk_id: row.get("id")?,
                file_id: row.get("file_id")?,
                path: row.get("path")?,
                start_line: row.get("start_line")?,
                end_line: row.get("end_line")?,
                content,
                preview,
                bm25: row.get("rank")?,
            })
        })?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row?);
        }
        Ok(hits)
    }

    /// Lists relation proposals, optionally filtered by status.
    /// Pass `None` for all statuses. Mirrors `listRelationProposals`.
    pub fn relation_proposals(
        &self,
        status: Option<&str>,
    ) -> Result<Vec<RelationProposal>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(vec![]);
        };
        if !Self::table_exists(&conn, "relation_proposals") {
            return Ok(vec![]);
        }

        let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match status {
            Some(s) => (
                "SELECT id, source_file_id, target_file_id, source_path, target_path,
                        relation_type, confidence, rationale, evidence_path,
                        evidence_start_line, evidence_end_line, evidence_text,
                        status, created_at, reviewed_at
                   FROM relation_proposals WHERE status = ?1 ORDER BY id DESC"
                    .into(),
                vec![Box::new(s.to_owned())],
            ),
            None => (
                "SELECT id, source_file_id, target_file_id, source_path, target_path,
                        relation_type, confidence, rationale, evidence_path,
                        evidence_start_line, evidence_end_line, evidence_text,
                        status, created_at, reviewed_at
                   FROM relation_proposals ORDER BY id DESC"
                    .into(),
                vec![],
            ),
        };
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| CoreError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map(param_refs.as_slice(), map_proposal)
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| CoreError::Storage(e.to_string()))?);
        }
        Ok(out)
    }

    /// Creates a new pending relation proposal.
    pub fn create_relation_proposal(
        &self,
        input: &RelationProposalCreateInput,
    ) -> Result<RelationProposal, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "relation_proposals") {
            return Err(CoreError::Storage("relation_proposals table does not exist".into()));
        }
        let now = now_iso();
        let source_file_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM files WHERE path = ?1",
                params![input.source_path],
                |row| row.get(0),
            )
            .ok();
        let target_file_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM files WHERE path = ?1",
                params![input.target_path],
                |row| row.get(0),
            )
            .ok();
        let normalized_type = normalize_relation_type(&input.relation_type);

        conn.execute(
            "INSERT INTO relation_proposals
             (source_file_id, target_file_id, source_path, target_path, relation_type,
              confidence, rationale, evidence_path, evidence_start_line, evidence_end_line,
              evidence_text, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12)",
            params![
                source_file_id,
                target_file_id,
                input.source_path,
                input.target_path,
                normalized_type,
                input.confidence,
                input.rationale.trim(),
                input.evidence_path,
                input.evidence_start_line,
                input.evidence_end_line,
                input.evidence_text.as_deref().map(str::trim),
                now,
            ],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        let id = conn.last_insert_rowid();
        self.get_relation_proposal(id)?
            .ok_or_else(|| CoreError::Storage(format!("relation proposal {id} not found after create")))
    }

    /// Gets a single relation proposal by ID.
    pub fn get_relation_proposal(&self, id: i64) -> Result<Option<RelationProposal>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(None);
        };
        if !Self::table_exists(&conn, "relation_proposals") {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, source_file_id, target_file_id, source_path, target_path,
                        relation_type, confidence, rationale, evidence_path,
                        evidence_start_line, evidence_end_line, evidence_text,
                        status, created_at, reviewed_at
                   FROM relation_proposals WHERE id = ?1",
            )
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![id], map_proposal)
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        if let Some(row) = rows.next() {
            Ok(Some(row.map_err(|e| CoreError::Storage(e.to_string()))?))
        } else {
            Ok(None)
        }
    }

    /// Approves a pending relation proposal and publishes it to document_relations.
    pub fn approve_relation_proposal(&self, id: i64) -> Result<RelationProposal, CoreError> {
        let mut conn = self.connect_write()?;
        if !Self::table_exists(&conn, "relation_proposals") {
            return Err(CoreError::Storage("relation_proposals table does not exist".into()));
        }
        let now = now_iso();
        let tx = conn
            .transaction()
            .map_err(|e| CoreError::Storage(e.to_string()))?;

        let proposal_opt: Option<RelationProposal> = tx
            .prepare(
                "SELECT id, source_file_id, target_file_id, source_path, target_path,
                        relation_type, confidence, rationale, evidence_path,
                        evidence_start_line, evidence_end_line, evidence_text,
                        status, created_at, reviewed_at
                   FROM relation_proposals WHERE id = ?1",
            )
            .map_err(|e| CoreError::Storage(e.to_string()))?
            .query_map(params![id], map_proposal)
            .map_err(|e| CoreError::Storage(e.to_string()))?
            .filter_map(|r| r.ok())
            .next();

        let proposal = proposal_opt
            .ok_or_else(|| CoreError::Storage(format!("relation proposal {id} not found")))?;

        // Ensure files exist
        let source_file_id: i64 = proposal.source_file_id.or_else(|| {
            tx.query_row(
                "SELECT id FROM files WHERE path = ?1",
                params![proposal.source_path],
                |row| row.get(0),
            ).ok()
        }).ok_or_else(|| CoreError::Storage(format!("Source document '{}' not indexed", proposal.source_path)))?;

        let target_file_id: i64 = proposal.target_file_id.or_else(|| {
            tx.query_row(
                "SELECT id FROM files WHERE path = ?1",
                params![proposal.target_path],
                |row| row.get(0),
            ).ok()
        }).ok_or_else(|| CoreError::Storage(format!("Target document '{}' not indexed", proposal.target_path)))?;

        // Update proposal status
        tx.execute(
            "UPDATE relation_proposals
                SET status = 'approved', reviewed_at = ?1, source_file_id = ?2, target_file_id = ?3
              WHERE id = ?4",
            params![now, source_file_id, target_file_id, id],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        // Ensure relation type exists
        tx.execute(
            "INSERT INTO relation_types (name, display_name, inverse_name, symmetric, core)
             VALUES (?1, ?2, NULL, 0, 0) ON CONFLICT(name) DO NOTHING",
            params![proposal.relation_type, proposal.relation_type],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        // Insert / update document_relations
        tx.execute(
            "INSERT INTO document_relations (source_file_id, target_file_id, relation_type, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(source_file_id, target_file_id, relation_type)
             DO UPDATE SET updated_at = excluded.updated_at",
            params![source_file_id, target_file_id, proposal.relation_type, now, now],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        let relation_id: i64 = tx.query_row(
            "SELECT id FROM document_relations
              WHERE source_file_id = ?1 AND target_file_id = ?2 AND relation_type = ?3",
            params![source_file_id, target_file_id, proposal.relation_type],
            |row| row.get(0),
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        // Insert evidence
        tx.execute(
            "INSERT OR IGNORE INTO relation_evidence
              (relation_id, source_kind, original_target, source_path, start_line, end_line,
               evidence_text, rationale, confidence)
             VALUES (?1, 'agent', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                relation_id,
                proposal.target_path,
                proposal.evidence_path,
                proposal.evidence_start_line,
                proposal.evidence_end_line,
                proposal.evidence_text,
                proposal.rationale,
                proposal.confidence,
            ],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        tx.commit().map_err(|e| CoreError::Storage(e.to_string()))?;

        self.get_relation_proposal(id)?
            .ok_or_else(|| CoreError::Storage(format!("relation proposal {id} disappeared")))
    }

    /// Rejects a relation proposal.
    pub fn reject_relation_proposal(&self, id: i64) -> Result<RelationProposal, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "relation_proposals") {
            return Err(CoreError::Storage("relation_proposals table does not exist".into()));
        }
        let now = now_iso();
        conn.execute(
            "UPDATE relation_proposals SET status = 'rejected', reviewed_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        self.get_relation_proposal(id)?
            .ok_or_else(|| CoreError::Storage(format!("relation proposal {id} disappeared")))
    }

    /// Deletes a relation proposal by ID.
    pub fn delete_relation_proposal(&self, id: i64) -> Result<(), CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "relation_proposals") {
            return Ok(());
        }
        conn.execute("DELETE FROM relation_proposals WHERE id = ?1", params![id])
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Lists all published (approved) relations across the workspace.
    /// Used by the desktop graph view to render every edge at once.
    pub fn all_relations(&self) -> Result<Vec<DocumentRelation>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(vec![]);
        };
        if !Self::table_exists(&conn, "document_relations") {
            return Ok(vec![]);
        }
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.source_file_id, sf.path AS source_path, sd.title AS source_title,
                        r.target_file_id, tf.path AS target_path, td.title AS target_title,
                        r.relation_type, rt.symmetric
                   FROM document_relations r
                   JOIN files sf ON sf.id = r.source_file_id
                   JOIN documents sd ON sd.file_id = sf.id
                   JOIN files tf ON tf.id = r.target_file_id
                   JOIN documents td ON td.file_id = tf.id
                   JOIN relation_types rt ON rt.name = r.relation_type
                  ORDER BY r.relation_type, sf.path, tf.path",
            )
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map([], map_relation)
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            let mut rel = row.map_err(|e| CoreError::Storage(e.to_string()))?;
            rel.evidence = query_evidence(&conn, rel.id)?;
            out.push(rel);
        }
        Ok(out)
    }

    // -- drafts --------------------------------------------------------------

    /// Lists drafts, optionally filtered by status. Returns empty if the
    /// `drafts` table does not exist yet (pre-index workspace).
    pub fn list_drafts(&self, status: Option<&str>) -> Result<Vec<Draft>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(vec![]);
        };
        if !Self::table_exists(&conn, "drafts") {
            return Ok(vec![]);
        }
        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = match status {
            Some(s) => (
                "SELECT id, draft_id, workspace_id, target_path, operation_type,
                        base_document_hash, generated_content, source_citations, section_slug,
                        status, created_by, created_at, reviewed_at
                   FROM drafts WHERE status = ?1 ORDER BY id DESC".into(),
                vec![Box::new(s.to_owned())],
            ),
            None => (
                "SELECT id, draft_id, workspace_id, target_path, operation_type,
                        base_document_hash, generated_content, source_citations, section_slug,
                        status, created_by, created_at, reviewed_at
                   FROM drafts ORDER BY id DESC".into(),
                vec![],
            ),
        };
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(param_refs.as_slice(), map_draft)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Returns a single draft by its `draft_id`, or `None` if not found.
    pub fn get_draft(&self, draft_id: &str) -> Result<Option<Draft>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(None);
        };
        if !Self::table_exists(&conn, "drafts") {
            return Ok(None);
        }
        let draft = conn
            .query_row(
                "SELECT id, draft_id, workspace_id, target_path, operation_type,
                        base_document_hash, generated_content, source_citations, section_slug,
                        status, created_by, created_at, reviewed_at
                   FROM drafts WHERE draft_id = ?1",
                rusqlite::params![draft_id],
                map_draft,
            )
            .optional()?;
        Ok(draft)
    }

    /// Creates a new draft. Returns the created draft. The workspace root is
    /// needed to compute `base_document_hash` when it is empty and the target
    /// already exists (so the caller can detect conflicts on apply).
    pub fn create_draft(&self, input: &DraftCreateInput) -> Result<Draft, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "drafts") {
            return Err(CoreError::Storage(
                "drafts table not found; run index first to initialize the schema".into(),
            ));
        }
        let now = now_iso();
        let draft_id = format!("draft-{}-{}", now_timestamp(), rand_suffix());
        let citations_json = serde_json::to_string(&input.source_citations)
            .unwrap_or_else(|_| "[]".into());

        conn.execute(
            "INSERT INTO drafts (draft_id, workspace_id, target_path, operation_type,
                 base_document_hash, generated_content, source_citations, section_slug, status, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)",
            rusqlite::params![
                draft_id,
                input.workspace_id,
                input.target_path,
                input.operation_type,
                input.base_document_hash,
                input.generated_content,
                citations_json,
                input.section_slug,
                input.created_by,
                now,
            ],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Draft {
            id,
            draft_id,
            workspace_id: input.workspace_id.clone(),
            target_path: input.target_path.clone(),
            operation_type: input.operation_type.clone(),
            base_document_hash: input.base_document_hash.clone(),
            generated_content: input.generated_content.clone(),
            source_citations: input.source_citations.clone(),
            section_slug: input.section_slug.clone(),
            status: "pending".into(),
            created_by: input.created_by.clone(),
            created_at: now,
            reviewed_at: None,
        })
    }

    /// Rejects (discards) a pending draft. Sets status to `rejected`.
    pub fn reject_draft(&self, draft_id: &str) -> Result<Draft, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "drafts") {
            return Err(CoreError::Storage("drafts table not found".into()));
        }
        let now = now_iso();
        let rows = conn.execute(
            "UPDATE drafts SET status = 'rejected', reviewed_at = ?1
              WHERE draft_id = ?2 AND status = 'pending'",
            rusqlite::params![now, draft_id],
        )?;
        if rows == 0 {
            return Err(CoreError::Storage(format!(
                "draft {draft_id} not found or not pending"
            )));
        }
        self.get_draft(draft_id)?
            .ok_or_else(|| CoreError::Storage(format!("draft {draft_id} disappeared after reject")))
    }

    /// Deletes a draft record by `draft_id`. Also removes any associated
    /// records in `write_operations` referencing this draft. Returns true if a
    /// record was deleted.
    pub fn delete_draft(&self, draft_id: &str) -> Result<bool, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "drafts") {
            return Ok(false);
        }
        if Self::table_exists(&conn, "write_operations") {
            conn.execute(
                "DELETE FROM write_operations WHERE draft_id = ?1",
                rusqlite::params![draft_id],
            )?;
        }
        let count = conn.execute(
            "DELETE FROM drafts WHERE draft_id = ?1",
            rusqlite::params![draft_id],
        )?;
        Ok(count > 0)
    }

    /// Deletes drafts matching the given status (e.g. "applied", "rejected").
    pub fn delete_drafts_by_status(&self, status: &str) -> Result<usize, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "drafts") {
            return Ok(0);
        }
        if Self::table_exists(&conn, "write_operations") {
            conn.execute(
                "DELETE FROM write_operations WHERE draft_id IN (SELECT draft_id FROM drafts WHERE status = ?1)",
                rusqlite::params![status],
            )?;
        }
        let count = conn.execute(
            "DELETE FROM drafts WHERE status = ?1",
            rusqlite::params![status],
        )?;
        Ok(count)
    }

    /// Applies a pending draft to the filesystem and records the write.
    ///
    /// Follows architecture-v1.md §8.6: validates `base_document_hash` against
    /// the current file (if it exists), creates a backup for overwrite/append,
    /// writes via temp-file + atomic rename, records a `write_operations` row,
    /// and marks the draft `applied`.
    ///
    /// `workspace_root` is the absolute path to the workspace root (the target
    /// path is resolved relative to it).
    pub fn apply_draft(
        &self,
        draft_id: &str,
        workspace_root: impl AsRef<Path>,
        applied_by: &str,
    ) -> Result<DraftApplyResult, CoreError> {
        let draft = self.get_draft(draft_id)?
            .ok_or_else(|| CoreError::Storage(format!("draft {draft_id} not found")))?;
        if draft.status != "pending" {
            return Err(CoreError::Storage(format!(
                "draft {draft_id} is {} (only pending drafts can be applied)",
                draft.status
            )));
        }

        let root = workspace_root.as_ref();
        let target_abs = resolve_target_path(root, &draft.target_path)?;
        let current_hash = file_sha256(&target_abs);

        // expectedHash validation (§8.6): if the draft was created against an
        // existing file, the current content hash must match.
        if !draft.base_document_hash.is_empty() && draft.base_document_hash != current_hash {
            // Mark as conflicted so the UI can prompt for a re-generate.
            self.mark_conflicted(draft_id)?;
            return Err(CoreError::Storage(format!(
                "hash mismatch for {}: expected {}, got {}; draft marked conflicted",
                draft.target_path, draft.base_document_hash, current_hash
            )));
        }

        // Compute the new content based on operation_type.
        let new_content = match draft.operation_type.as_str() {
            "create" => {
                if target_abs.exists() {
                    return Err(CoreError::Storage(format!(
                        "target {} already exists; use 'overwrite' instead",
                        draft.target_path
                    )));
                }
                draft.generated_content.clone()
            }
            "overwrite" => draft.generated_content.clone(),
            "append" => {
                let existing = std::fs::read_to_string(&target_abs)
                    .map_err(|e| CoreError::Storage(format!("cannot read target for append: {e}")))?;
                format!("{existing}\n\n{content}", content = draft.generated_content)
            }
            "update_section" => {
                let existing = std::fs::read_to_string(&target_abs)
                    .map_err(|e| CoreError::Storage(format!("cannot read target for update_section: {e}")))?;
                replace_section(&existing, &draft.section_slug, &draft.generated_content)?
            }
            other => {
                return Err(CoreError::Storage(format!(
                    "unsupported operation_type: {other}"
                )));
            }
        };

        let new_hash = sha256_hex(new_content.as_bytes());
        let bytes_written = new_content.len() as i64;

        // Create backup for non-create operations (§8.6).
        let backup_path = if target_abs.exists() {
            let backup = backup_path_for(&target_abs);
            std::fs::copy(&target_abs, &backup)
                .map_err(|e| CoreError::Storage(format!("backup failed: {e}")))?;
            Some(backup.to_string_lossy().into_owned())
        } else {
            None
        };

        // Ensure parent directory exists.
        if let Some(parent) = target_abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CoreError::Storage(format!("cannot create target dir: {e}")))?;
        }

        // Atomic write: temp file + rename.
        let temp = target_abs.with_extension("tmp.draft");
        std::fs::write(&temp, new_content.as_bytes())
            .map_err(|e| CoreError::Storage(format!("temp write failed: {e}")))?;
        std::fs::rename(&temp, &target_abs)
            .map_err(|e| CoreError::Storage(format!("atomic rename failed: {e}")))?;

        // Record the write operation and mark the draft applied.
        let now = now_iso();
        let conn = self.connect_write()?;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO write_operations (draft_id, target_path, operation_type, backup_path, content_hash, bytes_written, applied_at, applied_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                draft.draft_id,
                draft.target_path,
                draft.operation_type,
                backup_path,
                new_hash,
                bytes_written,
                now,
                applied_by,
            ],
        )?;
        tx.execute(
            "UPDATE drafts SET status = 'applied', reviewed_at = ?1 WHERE draft_id = ?2",
            rusqlite::params![now, draft_id],
        )?;
        tx.commit()?;

        Ok(DraftApplyResult {
            draft_id: draft.draft_id,
            target_path: draft.target_path,
            content_hash: new_hash,
            bytes_written,
            backup_path,
        })
    }

    /// Marks a draft as conflicted (hash mismatch detected during apply).
    fn mark_conflicted(&self, draft_id: &str) -> Result<(), CoreError> {
        let conn = self.connect_write()?;
        let now = now_iso();
        conn.execute(
            "UPDATE drafts SET status = 'conflicted', reviewed_at = ?1 WHERE draft_id = ?2",
            rusqlite::params![now, draft_id],
        )?;
        Ok(())
    }

    // -- chat sessions -------------------------------------------------------

    /// Lists chat sessions, optionally filtered by workspace_id.
    pub fn list_chat_sessions(&self, workspace_id: Option<&str>) -> Result<Vec<ChatSessionRecord>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(vec![]);
        };
        if !Self::table_exists(&conn, "chat_sessions") {
            return Ok(vec![]);
        }
        let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match workspace_id {
            Some(wid) => (
                "SELECT id, workspace_id, title, model_provider, model_id, created_at, updated_at, archived, pinned
                   FROM chat_sessions WHERE workspace_id = ?1 ORDER BY pinned DESC, updated_at DESC".into(),
                vec![Box::new(wid.to_string())],
            ),
            None => (
                "SELECT id, workspace_id, title, model_provider, model_id, created_at, updated_at, archived, pinned
                   FROM chat_sessions ORDER BY pinned DESC, updated_at DESC".into(),
                vec![],
            ),
        };
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql).map_err(|e| CoreError::Storage(e.to_string()))?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                let archived_int: i64 = row.get("archived")?;
                let pinned_int: i64 = row.get("pinned")?;
                Ok(ChatSessionRecord {
                    id: row.get("id")?,
                    workspace_id: row.get("workspace_id")?,
                    title: row.get("title")?,
                    model_provider: row.get("model_provider")?,
                    model_id: row.get("model_id")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    archived: archived_int != 0,
                    pinned: pinned_int != 0,
                })
            })
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| CoreError::Storage(e.to_string()))?);
        }
        Ok(out)
    }

    /// Fetches a chat session by ID.
    pub fn get_chat_session(&self, id: &str) -> Result<Option<ChatSessionRecord>, CoreError> {
        let Some(conn) = self.connect()? else {
            return Ok(None);
        };
        if !Self::table_exists(&conn, "chat_sessions") {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, workspace_id, title, model_provider, model_id, created_at, updated_at, archived, pinned
                   FROM chat_sessions WHERE id = ?1",
            )
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        let result = stmt
            .query_row([id], |row| {
                let archived_int: i64 = row.get("archived")?;
                let pinned_int: i64 = row.get("pinned")?;
                Ok(ChatSessionRecord {
                    id: row.get("id")?,
                    workspace_id: row.get("workspace_id")?,
                    title: row.get("title")?,
                    model_provider: row.get("model_provider")?,
                    model_id: row.get("model_id")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    archived: archived_int != 0,
                    pinned: pinned_int != 0,
                })
            })
            .optional()
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(result)
    }

    /// Creates or updates a chat session metadata record.
    pub fn upsert_chat_session(&self, session: &ChatSessionRecord) -> Result<(), CoreError> {
        let conn = self.connect_write()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_sessions (
              id              TEXT PRIMARY KEY,
              workspace_id    TEXT NOT NULL,
              title           TEXT NOT NULL,
              model_provider  TEXT NOT NULL,
              model_id        TEXT NOT NULL,
              created_at      TEXT NOT NULL,
              updated_at      TEXT NOT NULL,
              archived        INTEGER NOT NULL DEFAULT 0,
              pinned          INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id, updated_at DESC);",
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;

        conn.execute(
            "INSERT INTO chat_sessions (id, workspace_id, title, model_provider, model_id, created_at, updated_at, archived, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               model_provider = excluded.model_provider,
               model_id = excluded.model_id,
               updated_at = excluded.updated_at,
               archived = excluded.archived,
               pinned = excluded.pinned",
            rusqlite::params![
                session.id,
                session.workspace_id,
                session.title,
                session.model_provider,
                session.model_id,
                session.created_at,
                session.updated_at,
                if session.archived { 1 } else { 0 },
                if session.pinned { 1 } else { 0 },
            ],
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(())
    }

    /// Deletes a chat session metadata record by ID.
    pub fn delete_chat_session(&self, id: &str) -> Result<bool, CoreError> {
        let conn = self.connect_write()?;
        if !Self::table_exists(&conn, "chat_sessions") {
            return Ok(false);
        }
        let count = conn
            .execute("DELETE FROM chat_sessions WHERE id = ?1", [id])
            .map_err(|e| CoreError::Storage(e.to_string()))?;
        Ok(count > 0)
    }
}

// ---------------------------------------------------------------------------
// free helpers
// ---------------------------------------------------------------------------

/// Builds a short preview snippet from chunk content, centered around the
/// first occurrence of the query term. Caps at ~200 characters.
fn make_preview(content: &str, query: &str) -> String {
    const MAX_CHARS: usize = 120;
    let chars: Vec<char> = content.chars().collect();
    if chars.is_empty() {
        return String::new();
    }

    let lower_content = content.to_lowercase();
    let query_lower = query.to_lowercase();
    let query_term = query_lower.split_whitespace().next().unwrap_or(&query_lower);

    let char_idx = if let Some(byte_idx) = lower_content.find(query_term) {
        content[..byte_idx].chars().count()
    } else {
        0
    };

    let start = char_idx.saturating_sub(MAX_CHARS / 3);
    let end = (start + MAX_CHARS).min(chars.len());

    let mut preview = String::new();
    if start > 0 {
        preview.push('…');
    }
    preview.extend(&chars[start..end]);
    if end < chars.len() {
        preview.push('…');
    }
    preview.replace('\n', " ")
}

/// Maps a `drafts` row into a `Draft`.
fn map_draft(row: &rusqlite::Row<'_>) -> rusqlite::Result<Draft> {
    let citations_json: String = row.get("source_citations")?;
    let citations: Vec<String> = serde_json::from_str(&citations_json).unwrap_or_default();
    Ok(Draft {
        id: row.get("id")?,
        draft_id: row.get("draft_id")?,
        workspace_id: row.get("workspace_id")?,
        target_path: row.get("target_path")?,
        operation_type: row.get("operation_type")?,
        base_document_hash: row.get("base_document_hash")?,
        generated_content: row.get("generated_content")?,
        source_citations: citations,
        section_slug: row.get("section_slug")?,
        status: row.get("status")?,
        created_by: row.get("created_by")?,
        created_at: row.get("created_at")?,
        reviewed_at: row.get("reviewed_at")?,
    })
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86400;
    let remainder = secs % 86400;
    let hour = remainder / 3600;
    let minute = (remainder % 3600) / 60;
    let second = remainder % 60;
    let (year, month, day) = days_to_date(days as i64);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, month, day, hour, minute, second, millis)
}

fn now_timestamp() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

/// A short random suffix for draft IDs (not cryptographically secure — just
/// for uniqueness within the same millisecond).
fn rand_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{:x}", n)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    let mut s = String::with_capacity(result.len() * 2);
    for b in result.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Computes the sha256 hex of a file's UTF-8 content, or empty string if the
/// file does not exist.
fn file_sha256(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => String::new(),
    }
}

/// Resolves a workspace-relative target path (e.g. `wiki/foo.md`) to an
/// absolute path. Validates that the result stays within the workspace root to
/// prevent path traversal.
fn resolve_target_path(workspace_root: &Path, target_path: &str) -> Result<PathBuf, CoreError> {
    let cleaned = target_path.replace('\\', "/");
    if cleaned.starts_with('/') || cleaned.contains("..") {
        return Err(CoreError::Storage(format!(
            "target path must be workspace-relative (got: {target_path})"
        )));
    }
    let abs = workspace_root.join(&cleaned);
    Ok(abs)
}

/// Returns a backup path for a file: `<path>.bak-<timestamp>`.
fn backup_path_for(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    name.push_str(&format!(".bak-{}", now_timestamp()));
    path.with_file_name(name)
}

/// Replaces the body of a single section (identified by its slug) within an
/// existing document. The section's heading line is preserved; everything from
/// the line *after* the heading up to (but not including) the next heading of
/// the same or higher level is replaced with `new_body`.
///
/// A section ends at the next heading whose level is ≤ the target section's
/// level (e.g. a `##` section ends at the next `#` or `##`, but not `###`).
/// If it is the last section, it extends to EOF.
///
/// `new_body` should NOT include the heading line itself — only the content
/// that goes under it. If `new_body` is empty, the section's body is cleared
/// but the heading is kept.
fn replace_section(existing: &str, section_slug: &str, new_body: &str) -> Result<String, CoreError> {
    if section_slug.is_empty() {
        return Err(CoreError::Storage(
            "update_section requires a non-empty section_slug".into(),
        ));
    }

    let parsed = crate::document_parser::parse_document(existing, "section.md");
    let slug_prefix: String = section_slug.chars().take(20).collect();
    let target = parsed
        .sections
        .iter()
        .find(|s| s.slug == section_slug)
        .or_else(|| parsed.sections.iter().find(|s| s.slug.starts_with(&slug_prefix)));

    let Some(target) = target else {
        return Err(CoreError::Storage(format!(
            "section with slug '{section_slug}' not found in the target document"
        )));
    };

    let lines: Vec<&str> = existing.split('\n').collect();
    let heading_line_idx = (target.start_line as usize).saturating_sub(1);
    if heading_line_idx >= lines.len() {
        return Err(CoreError::Storage("section start_line is beyond file bounds".into()));
    }

    // Find the end line: the line index of the next heading with level <= target.level.
    // The section body starts at heading_line_idx + 1.
    let mut end_idx = lines.len(); // exclusive end (extends to EOF if no later heading)
    for (i, line) in lines.iter().enumerate().skip(heading_line_idx + 1) {
        if let Some(level) = heading_level(line) {
            if level <= target.level {
                end_idx = i;
                break;
            }
        }
    }

    // Reassemble: lines before heading + heading line + new_body + lines from end_idx onward.
    let mut result = String::new();
    // Lines before the heading (0..=heading_line_idx, which includes the heading itself).
    for line in &lines[..=heading_line_idx] {
        result.push_str(line);
        result.push('\n');
    }
    // New body content.
    if !new_body.is_empty() {
        // Trim leading/trailing newlines to keep spacing clean, then re-add.
        let trimmed = new_body.trim_matches('\n');
        if !trimmed.is_empty() {
            result.push_str(trimmed);
            result.push('\n');
        }
    }
    // Lines from end_idx to end of file.
    for line in &lines[end_idx..] {
        result.push_str(line);
        result.push('\n');
    }

    // Remove the trailing newline that the original content may or may not have had.
    // If the original didn't end with \n, strip the one we added.
    if !existing.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }

    Ok(result)
}

/// Returns the heading level (1-6) if the line is an ATX heading, else None.
fn heading_level(line: &str) -> Option<u32> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if hashes >= 1 && hashes <= 6 {
        let after = trimmed.get(hashes..)?;
        if after.starts_with(' ') || after.starts_with('\t') || after.is_empty() {
            return Some(hashes as u32);
        }
    }
    None
}

/// Converts days since 1970-01-01 to (year, month, day).
/// From <https://howardhinnant.github.io/date_algorithms.html>.
fn days_to_date(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { (mp + 3) as u32 } else { (mp - 9) as u32 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

fn empty_stats(db_path: &Path) -> KbStats {
    KbStats {
        db_path: db_path.to_string_lossy().into_owned(),
        files: 0,
        chunks: 0,
        fts_records: 0,
        vector_records: 0,
        earliest_indexed_at: None,
        latest_indexed_at: None,
        tables_ok: false,
        vector_enabled: false,
        by_language: vec![],
        by_root: vec![],
    }
}

fn earliest_latest(conn: &Connection, dir: &str) -> Option<String> {
    if !SqliteStore::table_exists(conn, "files") {
        return None;
    }
    let sql = format!(
        "SELECT indexed_at FROM files WHERE indexed_at IS NOT NULL ORDER BY indexed_at {dir} LIMIT 1"
    );
    conn.query_row(&sql, [], |row| row.get::<_, Option<String>>(0))
        .ok()
        .flatten()
}

fn by_language(conn: &Connection) -> Vec<KbLanguageStat> {
    if !SqliteStore::table_exists(conn, "files") {
        return vec![];
    }
    let mut stmt = match conn.prepare(
        "SELECT language, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC, language ASC",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map([], |row| {
        Ok(KbLanguageStat { language: row.get(0)?, count: row.get(1)? })
    });
    let Ok(rows) = rows else { return vec![] };
    rows.filter_map(|r| r.ok()).collect()
}

fn by_root(conn: &Connection) -> Vec<KbRootStat> {
    if !SqliteStore::table_exists(conn, "files") {
        return vec![];
    }
    let mut stmt = match conn.prepare(
        "SELECT substr(path, 1, instr(path || '/', '/') - 1) AS root, COUNT(*) AS count
           FROM files GROUP BY root ORDER BY count DESC, root ASC",
    ) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = stmt.query_map([], |row| {
        Ok(KbRootStat { root: row.get(0)?, count: row.get(1)? })
    });
    let Ok(rows) = rows else { return vec![] };
    rows.filter_map(|r| r.ok()).collect()
}

fn query_evidence(conn: &Connection, relation_id: i64) -> Result<Vec<RelationEvidence>, CoreError> {
    if !SqliteStore::table_exists(conn, "relation_evidence") {
        return Ok(vec![]);
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, source_kind, original_target, source_path, start_line, end_line,
                    evidence_text, rationale, confidence
               FROM relation_evidence WHERE relation_id = ?1 ORDER BY id",
        )
        .map_err(|e| CoreError::Storage(e.to_string()))?;
    let rows = stmt
        .query_map(rusqlite::params![relation_id], |row| {
            Ok(RelationEvidence {
                id: row.get(0)?,
                source_kind: row.get(1)?,
                original_target: row.get(2)?,
                source_path: row.get(3)?,
                start_line: row.get(4)?,
                end_line: row.get(5)?,
                evidence_text: row.get(6)?,
                rationale: row.get(7)?,
                confidence: row.get(8)?,
            })
        })
        .map_err(|e| CoreError::Storage(e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| CoreError::Storage(e.to_string()))?);
    }
    Ok(out)
}

fn map_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<RelationProposal> {
    Ok(RelationProposal {
        id: row.get("id")?,
        source_file_id: row.get("source_file_id")?,
        target_file_id: row.get("target_file_id")?,
        source_path: row.get("source_path")?,
        target_path: row.get("target_path")?,
        relation_type: row.get("relation_type")?,
        confidence: row.get("confidence")?,
        rationale: row.get("rationale")?,
        evidence_path: row.get("evidence_path")?,
        evidence_start_line: row.get("evidence_start_line")?,
        evidence_end_line: row.get("evidence_end_line")?,
        evidence_text: row.get("evidence_text")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        reviewed_at: row.get("reviewed_at")?,
    })
}

fn map_relation(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRelation> {
    let symmetric_int: i64 = row.get("symmetric")?;
    Ok(DocumentRelation {
        id: row.get("id")?,
        source_file_id: row.get("source_file_id")?,
        source_path: row.get("source_path")?,
        source_title: row.get("source_title")?,
        target_file_id: row.get("target_file_id")?,
        target_path: row.get("target_path")?,
        target_title: row.get("target_title")?,
        relation_type: row.get("relation_type")?,
        symmetric: symmetric_int == 1,
        evidence: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a fresh in-memory DB with the base schema + a couple of rows so
    /// we can exercise the read paths without a real index.
    fn seed() -> (rusqlite::Connection, std::path::PathBuf) {
        let dir = tempfile_dir();
        let db_path = dir.join(DB_FILE_NAME);
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
                sha256 TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
                language TEXT NOT NULL, indexed_at TEXT);
             CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL, content TEXT NOT NULL, start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL);
             CREATE TABLE documents (file_id INTEGER PRIMARY KEY, title TEXT NOT NULL,
                slug TEXT NOT NULL, summary TEXT, body TEXT NOT NULL, body_start_line INTEGER NOT NULL DEFAULT 1,
                metadata_json TEXT NOT NULL DEFAULT '{}');
             CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='id');
             INSERT INTO files(path, sha256, mtime, size, language, indexed_at) VALUES
                ('wiki/a.md', 'aa', 1, 100, 'markdown', '2026-08-10T00:00:00Z'),
                ('wiki/b.md', 'bb', 2, 200, 'markdown', '2026-08-11T00:00:00Z');
             INSERT INTO documents(file_id, title, slug, body) VALUES
                (1, 'Alpha', 'alpha', 'alpha body'),
                (2, 'Beta', 'beta', 'beta body');
             INSERT INTO chunks(file_id, chunk_index, content, start_line, end_line) VALUES
                (1, 0, 'alpha body', 1, 1);",
        )
        .unwrap();
        (conn, db_path)
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("llm-wiki-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // unique per call
        let unique = dir.join(format!("d{}", rand_nonce()));
        std::fs::create_dir_all(&unique).unwrap();
        unique
    }

    fn rand_nonce() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
    }

    #[test]
    fn stats_reports_real_counts() {
        let (_conn, db_path) = seed();
        let store = SqliteStore::from_db_path(&db_path);
        let stats = store.stats().unwrap();
        assert!(stats.tables_ok);
        assert_eq!(stats.files, 2);
        assert_eq!(stats.chunks, 1);
    }

    #[test]
    fn list_files_paginates_and_filters() {
        let (_conn, db_path) = seed();
        let store = SqliteStore::from_db_path(&db_path);
        let page = store.list_files(ListFilesOptions::default()).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.files.len(), 2);
        assert_eq!(page.files[0].path, "wiki/a.md");

        let filtered = store
            .list_files(ListFilesOptions { q: Some("b.md".into()), ..Default::default() })
            .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.files[0].path, "wiki/b.md");
    }

    #[test]
    fn file_content_prefers_document_body() {
        let (_conn, db_path) = seed();
        let store = SqliteStore::from_db_path(&db_path);
        let content = store.file_content(1).unwrap().unwrap();
        assert_eq!(content.content, "alpha body");
        assert_eq!(content.path, "wiki/a.md");
        assert_eq!(content.chunks.len(), 1);
    }

    #[test]
    fn missing_db_returns_empty_results() {
        let store = SqliteStore::from_root("/nonexistent/llm-wiki-test-missing");
        assert_eq!(store.stats().unwrap().files, 0);
        assert_eq!(store.list_files(ListFilesOptions::default()).unwrap().total, 0);
        assert_eq!(store.relation_proposals(None).unwrap().len(), 0);
        assert!(store.file_content(1).unwrap().is_none());
    }

    #[test]
    fn db_path_resolves_under_workspace_root() {
        let path = resolve_db_path("/tmp/my-wiki");
        assert_eq!(path, std::path::PathBuf::from("/tmp/my-wiki/.llm-wiki/index.db"));
    }

    // -- draft tests ---------------------------------------------------------

    /// Creates a workspace dir with a single wiki file, runs the indexer (which
    /// applies the full schema including drafts/write_operations), and returns
    /// the workspace root + store.
    fn draft_workspace() -> (std::path::PathBuf, SqliteStore) {
        let root = tempfile_dir();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/existing.md"), "# Existing\n\nOriginal content.").unwrap();
        // Run the indexer to initialize the full schema.
        crate::indexer::index_files(crate::indexer::IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: crate::indexer::KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();
        let store = SqliteStore::from_root(&root);
        (root, store)
    }

    #[test]
    fn create_and_list_draft() {
        let (_root, store) = draft_workspace();
        assert_eq!(store.list_drafts(None).unwrap().len(), 0);

        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/new.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "# New\n\nContent.".into(),
                source_citations: vec!["wiki/existing.md".into()],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();
        assert_eq!(draft.status, "pending");
        assert_eq!(draft.operation_type, "create");
        assert!(draft.draft_id.starts_with("draft-"));

        let pending = store.list_drafts(Some("pending")).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].draft_id, draft.draft_id);
        assert_eq!(pending[0].source_citations, vec!["wiki/existing.md"]);
    }

    #[test]
    fn apply_create_draft_writes_file() {
        let (root, store) = draft_workspace();
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/new.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "# Brand New\n\nFresh.".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let result = store.apply_draft(&draft.draft_id, &root, "desktop").unwrap();
        assert!(result.target_path.ends_with("wiki/new.md"));
        assert!(!result.content_hash.is_empty());

        // File should exist on disk with the generated content.
        let written = std::fs::read_to_string(root.join("wiki/new.md")).unwrap();
        assert_eq!(written, "# Brand New\n\nFresh.");

        // Draft should now be 'applied'.
        let updated = store.get_draft(&draft.draft_id).unwrap().unwrap();
        assert_eq!(updated.status, "applied");
    }

    #[test]
    fn apply_overwrite_creates_backup() {
        let (root, store) = draft_workspace();
        let existing_hash = file_sha256(&root.join("wiki/existing.md"));

        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "overwrite".into(),
                base_document_hash: existing_hash,
                generated_content: "# Updated\n\nNew content.".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let result = store.apply_draft(&draft.draft_id, &root, "desktop").unwrap();
        assert!(result.backup_path.is_some(), "overwrite should create a backup");

        // Backup should contain the original content.
        let backup = std::fs::read_to_string(result.backup_path.as_ref().unwrap()).unwrap();
        assert!(backup.contains("Original content."));

        // Target should have the new content.
        let written = std::fs::read_to_string(root.join("wiki/existing.md")).unwrap();
        assert_eq!(written, "# Updated\n\nNew content.");
    }

    #[test]
    fn apply_detects_hash_conflict() {
        let (root, store) = draft_workspace();
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "overwrite".into(),
                base_document_hash: "wrong-hash-value".into(),
                generated_content: "# Should Not Apply".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let result = store.apply_draft(&draft.draft_id, &root, "desktop");
        assert!(result.is_err(), "hash mismatch should reject the apply");

        // Draft should be marked conflicted.
        let updated = store.get_draft(&draft.draft_id).unwrap().unwrap();
        assert_eq!(updated.status, "conflicted");

        // File should be unchanged.
        let content = std::fs::read_to_string(root.join("wiki/existing.md")).unwrap();
        assert!(content.contains("Original content."));
    }

    #[test]
    fn reject_draft_sets_status() {
        let (_root, store) = draft_workspace();
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/new.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "content".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let rejected = store.reject_draft(&draft.draft_id).unwrap();
        assert_eq!(rejected.status, "rejected");

        // Should not appear in pending list.
        let pending = store.list_drafts(Some("pending")).unwrap();
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn delete_draft_removes_record() {
        let (_root, store) = draft_workspace();
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/to-delete.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "content to delete".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        assert!(store.get_draft(&draft.draft_id).unwrap().is_some());
        let deleted = store.delete_draft(&draft.draft_id).unwrap();
        assert!(deleted);
        assert!(store.get_draft(&draft.draft_id).unwrap().is_none());

        // Deleting non-existent draft returns false
        assert!(!store.delete_draft("non-existent-id").unwrap());
    }

    #[test]
    fn delete_draft_removes_write_operations() {
        let (root, store) = draft_workspace();
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/applied-delete.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "applied content".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "desktop".into(),
            })
            .unwrap();

        store.apply_draft(&draft.draft_id, &root, "desktop").unwrap();
        let applied_draft = store.get_draft(&draft.draft_id).unwrap().unwrap();
        assert_eq!(applied_draft.status, "applied");

        let deleted = store.delete_draft(&draft.draft_id).unwrap();
        assert!(deleted);
        assert!(store.get_draft(&draft.draft_id).unwrap().is_none());
    }

    #[test]
    fn delete_drafts_by_status_works() {
        let (_root, store) = draft_workspace();
        let draft1 = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/d1.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "c1".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let draft2 = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/d2.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "c2".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        store.reject_draft(&draft1.draft_id).unwrap();
        let count = store.delete_drafts_by_status("rejected").unwrap();
        assert_eq!(count, 1);
        assert!(store.get_draft(&draft1.draft_id).unwrap().is_none());
        assert!(store.get_draft(&draft2.draft_id).unwrap().is_some());
    }

    #[test]
    fn apply_append_prepends_to_existing() {
        let (root, store) = draft_workspace();
        let existing_hash = file_sha256(&root.join("wiki/existing.md"));

        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "append".into(),
                base_document_hash: existing_hash,
                generated_content: "## Appended Section".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        store.apply_draft(&draft.draft_id, &root, "desktop").unwrap();
        let written = std::fs::read_to_string(root.join("wiki/existing.md")).unwrap();
        assert!(written.contains("Original content."));
        assert!(written.contains("Appended Section"));
    }

    #[test]
    fn apply_create_rejects_if_file_exists() {
        let (root, store) = draft_workspace();
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "create".into(),
                base_document_hash: String::new(),
                generated_content: "should fail".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let result = store.apply_draft(&draft.draft_id, &root, "desktop");
        assert!(result.is_err(), "create on existing file should fail");
    }

    #[test]
    fn update_section_replaces_only_targeted_section() {
        let (root, store) = draft_workspace();

        // Write a multi-section document.
        let multi = "# Top\n\nIntro paragraph.\n\n## First Section\n\nOld first content.\n\n## Second Section\n\nOld second content.\n\n## Third Section\n\nThird content.";
        std::fs::write(root.join("wiki/existing.md"), multi).unwrap();

        let existing_hash = file_sha256(&root.join("wiki/existing.md"));
        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "update_section".into(),
                base_document_hash: existing_hash,
                generated_content: "Brand new second content.".into(),
                source_citations: vec![],
                section_slug: "second-section".into(),
                created_by: "pi".into(),
            })
            .unwrap();

        store.apply_draft(&draft.draft_id, &root, "desktop").unwrap();

        let written = std::fs::read_to_string(root.join("wiki/existing.md")).unwrap();
        // First section untouched.
        assert!(written.contains("Old first content."), "first section should be unchanged");
        // Second section updated.
        assert!(written.contains("Brand new second content."), "second section should have new content");
        assert!(!written.contains("Old second content."), "old second content should be gone");
        // Third section untouched.
        assert!(written.contains("Third content."), "third section should be unchanged");
        // Heading preserved.
        assert!(written.contains("## Second Section"), "heading should be preserved");
    }

    #[test]
    fn update_section_fails_on_unknown_slug() {
        let (root, store) = draft_workspace();
        let existing_hash = file_sha256(&root.join("wiki/existing.md"));

        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "update_section".into(),
                base_document_hash: existing_hash,
                generated_content: "new content".into(),
                source_citations: vec![],
                section_slug: "nonexistent-slug".into(),
                created_by: "pi".into(),
            })
            .unwrap();

        let result = store.apply_draft(&draft.draft_id, &root, "desktop");
        assert!(result.is_err(), "unknown section slug should fail");
        assert!(result.unwrap_err().to_string().contains("not found"));
    }

    #[test]
    fn update_section_empty_slug_errors() {
        let (root, store) = draft_workspace();
        let existing_hash = file_sha256(&root.join("wiki/existing.md"));

        let draft = store
            .create_draft(&DraftCreateInput {
                workspace_id: "ws-1".into(),
                target_path: "wiki/existing.md".into(),
                operation_type: "update_section".into(),
                base_document_hash: existing_hash,
                generated_content: "new content".into(),
                source_citations: vec![],
                section_slug: String::new(),
                created_by: "pi".into(),
            })
            .unwrap();

        let result = store.apply_draft(&draft.draft_id, &root, "desktop");
        assert!(result.is_err(), "empty section_slug should fail for update_section");
    }

    #[test]
    fn replace_section_includes_subsections() {
        // A section spans from its heading to the next heading of the same or
        // higher level. Replacing "## Parent" also replaces its "### Child"
        // subsection, but preserves the sibling "## Other" section.
        let original = "# Title\n\nIntro.\n\n## Parent\n\nParent body.\n\n### Child\n\nChild body.\n\n## Sibling\n\nSibling body.";
        let result = super::replace_section(original, "parent", "New parent body.").unwrap();
        assert!(result.contains("New parent body."));
        assert!(!result.contains("Parent body."), "old parent body should be replaced");
        assert!(!result.contains("### Child"), "subsection should be replaced along with parent");
        assert!(!result.contains("Child body."), "subsection content should be replaced");
        assert!(result.contains("## Sibling"), "sibling heading should be preserved");
        assert!(result.contains("Sibling body."), "sibling content should be untouched");
    }

    // -- search tests --------------------------------------------------------

    #[test]
    fn search_returns_relevant_hits() {
        let root = tempfile_dir();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "# Alpha\n\nThe architecture document describes the system.").unwrap();
        std::fs::write(root.join("wiki/b.md"), "# Beta\n\nCooking recipes for Italian food.").unwrap();

        crate::indexer::index_files(crate::indexer::IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: crate::indexer::KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();

        let store = SqliteStore::from_root(&root);
        let hits = store.search("architecture", None).unwrap();
        assert!(!hits.is_empty(), "should find 'architecture' hits");
        assert!(hits[0].path.ends_with("a.md"), "top hit should be from a.md: {}", hits[0].path);
        assert!(hits[0].preview.contains("architecture") || hits[0].content.contains("architecture"));
    }

    #[test]
    fn search_returns_empty_for_no_matches() {
        let root = tempfile_dir();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "# Alpha\n\nSimple content.").unwrap();

        crate::indexer::index_files(crate::indexer::IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: crate::indexer::KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();

        let store = SqliteStore::from_root(&root);
        let hits = store.search("nonexistentterm12345", None).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn search_rejects_empty_query() {
        let root = tempfile_dir();
        let store = SqliteStore::from_root(&root);
        assert!(store.search("", None).is_err());
        assert!(store.search("   ", None).is_err());
    }

    #[test]
    fn search_respects_limit() {
        let root = tempfile_dir();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        // Create a file with many chunks containing "keyword".
        let mut content = String::from("# Doc\n\n");
        for i in 0..50 {
            content.push_str(&format!("Section {} has the keyword.\n\n", i));
        }
        std::fs::write(root.join("wiki/big.md"), content).unwrap();

        crate::indexer::index_files(crate::indexer::IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: crate::indexer::KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();

        let store = SqliteStore::from_root(&root);
        let hits = store.search("keyword", Some(5)).unwrap();
        assert!(hits.len() <= 5, "should respect limit of 5, got {}", hits.len());
    }

    #[test]
    fn chat_sessions_lifecycle() {
        let root = tempfile_dir();
        let store = SqliteStore::from_root(&root);

        // 1. Initially empty
        let sessions = store.list_chat_sessions(None).unwrap();
        assert!(sessions.is_empty());

        // 2. Insert session
        let session = ChatSessionRecord {
            id: "session-1".into(),
            workspace_id: "ws-1".into(),
            title: "First Conversation".into(),
            model_provider: "anthropic".into(),
            model_id: "claude-sonnet-4-5".into(),
            created_at: "2026-08-20T10:00:00Z".into(),
            updated_at: "2026-08-20T10:00:00Z".into(),
            archived: false,
            pinned: false,
        };
        store.upsert_chat_session(&session).unwrap();

        // 3. Get session
        let fetched = store.get_chat_session("session-1").unwrap().expect("session should exist");
        assert_eq!(fetched.title, "First Conversation");
        assert_eq!(fetched.model_provider, "anthropic");

        // 4. Update title and pinned
        let mut updated = session.clone();
        updated.title = "Updated Conversation".into();
        updated.pinned = true;
        store.upsert_chat_session(&updated).unwrap();

        let fetched2 = store.get_chat_session("session-1").unwrap().unwrap();
        assert_eq!(fetched2.title, "Updated Conversation");
        assert!(fetched2.pinned);

        // 5. List with workspace filter
        let list = store.list_chat_sessions(Some("ws-1")).unwrap();
        assert_eq!(list.len(), 1);
        let list_other = store.list_chat_sessions(Some("other-ws")).unwrap();
        assert_eq!(list_other.len(), 0);

        // 6. Delete session
        let deleted = store.delete_chat_session("session-1").unwrap();
        assert!(deleted);
        assert!(store.get_chat_session("session-1").unwrap().is_none());
    }

    #[test]
    fn relation_proposals_lifecycle() {
        let (root, store) = draft_workspace();

        // 1. Initially empty
        let proposals = store.relation_proposals(None).unwrap();
        assert!(proposals.is_empty());

        // 2. Create proposal
        let input = RelationProposalCreateInput {
            source_path: "wiki/existing.md".into(),
            target_path: "wiki/other.md".into(),
            relation_type: "depends_on".into(),
            confidence: 0.95,
            rationale: "Architecture depends on storage".into(),
            evidence_path: "wiki/existing.md".into(),
            evidence_start_line: 1,
            evidence_end_line: 5,
            evidence_text: Some("Intro paragraph.".into()),
        };
        let created = store.create_relation_proposal(&input).unwrap();
        assert_eq!(created.source_path, "wiki/existing.md");
        assert_eq!(created.target_path, "wiki/other.md");
        assert_eq!(created.relation_type, "depends_on");
        assert_eq!(created.status, "pending");

        // 3. List pending
        let pending = store.relation_proposals(Some("pending")).unwrap();
        assert_eq!(pending.len(), 1);

        // 4. Reject
        let rejected = store.reject_relation_proposal(created.id).unwrap();
        assert_eq!(rejected.status, "rejected");

        // 5. Create another and approve
        // First create target file in DB by writing and indexing or inserting
        std::fs::write(root.join("wiki/target.md"), "# Target Document\n\nTarget content.").unwrap();
        crate::indexer::index_files(crate::indexer::IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: crate::indexer::KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();

        let input2 = RelationProposalCreateInput {
            source_path: "wiki/existing.md".into(),
            target_path: "wiki/target.md".into(),
            relation_type: "implements".into(),
            confidence: 0.88,
            rationale: "Implements target spec".into(),
            evidence_path: "wiki/existing.md".into(),
            evidence_start_line: 1,
            evidence_end_line: 2,
            evidence_text: Some("Intro paragraph.".into()),
        };
        let created2 = store.create_relation_proposal(&input2).unwrap();
        let approved = store.approve_relation_proposal(created2.id).unwrap();
        assert_eq!(approved.status, "approved");

        // 6. Verify published relations
        let all_rels = store.all_relations().unwrap();
        assert_eq!(all_rels.len(), 1);
        assert_eq!(all_rels[0].relation_type, "implements");
        assert_eq!(all_rels[0].source_path, "wiki/existing.md");
        assert_eq!(all_rels[0].target_path, "wiki/target.md");
    }
}


