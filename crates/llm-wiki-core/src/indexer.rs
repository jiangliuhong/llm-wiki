//! Incremental indexer — Rust port of `packages/kb/src/indexer.ts`.
//!
//! Phase A: FTS-only (no sqlite-vec vectors). This keeps the Rust port
//! dependency-free while producing a fully compatible `index.db` that the CLI
//! (which can load sqlite-vec) can later augment with vectors.
//!
//! Algorithm (mirrors the TS implementation):
//!   1. Scan configured include dirs.
//!   2. For each file: compute sha256 + mtime + size; skip if unchanged.
//!   3. For changed/new files: delete old chunks/fts, re-chunk, write chunks + FTS.
//!   4. Delete DB rows for stale files (no longer on disk).
//!   5. Reconcile relation proposals + rebuild deterministic relations.
//!   6. Write index provenance metadata.
//!   All writes run inside a single SQLite transaction.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::chunker::{split_into_chunks, ChunkOptions};
use crate::document_parser::{
    normalize_relation_type, parse_document, ParsedDocument, ParsedRelationReference,
    RelationSourceKind,
};
use crate::scanner::{scan_files_detailed, ScanOptions};
use crate::store::resolve_db_path;

/// KB-level configuration. Mirrors `KbConfig` in the TS types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbConfig {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub chunk: ChunkConfig,
    pub embedding: EmbeddingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkConfig {
    pub max_chars: usize,
    pub overlap: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub enabled: bool,
    pub dimensions: usize,
}

/// Default config matching the TS `DEFAULT_KB_CONFIG`.
impl Default for KbConfig {
    fn default() -> Self {
        Self {
            include: vec!["wiki".into()],
            exclude: vec![
                "node_modules".into(),
                ".git".into(),
                ".llm-wiki".into(),
                "dist".into(),
                "build".into(),
                "out".into(),
            ],
            chunk: ChunkConfig { max_chars: 1200, overlap: 200 },
            embedding: EmbeddingConfig { enabled: false, dimensions: 1536 },
        }
    }
}

/// Result of a single indexing pass. Mirrors `IndexStats`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub chunks: usize,
    pub vector_enabled: bool,
}

/// Options for an index run. Mirrors `IndexRunOptions`.
pub struct IndexRunOptions {
    pub project_root: PathBuf,
    pub db_path: Option<PathBuf>,
    pub config: KbConfig,
    pub reset: bool,
    pub source_revision: Option<String>,
    pub source_branch: Option<String>,
    pub on_progress: Option<Box<dyn Fn(&str)>>,
}

/// Schema version the current code writes and expects.
const EXPECTED_SCHEMA_VERSION: u32 = 3;

/// Runs an incremental index pass. Creates the DB if missing, ensures the
/// schema, and writes results in a single transaction. Returns aggregate stats.
pub fn index_files(options: IndexRunOptions) -> Result<IndexStats, crate::CoreError> {
    let project_root = options.project_root.clone();
    let db_path = options
        .db_path
        .clone()
        .unwrap_or_else(|| resolve_db_path(&project_root));

    // Ensure the .llm-wiki/ directory exists.
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;

    // Enable WAL + foreign keys (matches TS connection setup).
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");

    apply_base_schema(&conn)?;

    run_index(conn, &project_root, options)
}

fn run_index(
    conn: Connection,
    project_root: &Path,
    options: IndexRunOptions,
) -> Result<IndexStats, crate::CoreError> {
    let config = &options.config;
    let reset = options.reset;
    let on_progress = options.on_progress.as_ref();
    let progress = |msg: &str| {
        if let Some(cb) = on_progress {
            cb(msg);
        }
    };

    let scan = scan_files_detailed(&ScanOptions {
        project_root: project_root.to_owned(),
        include: config.include.clone(),
        exclude: config.exclude.clone(),
    });
    let scanned = &scan.files;
    let include_str = config.include.join(", ");
    progress(&format!("Scanned {} file(s) under {}.", scanned.len(), if include_str.is_empty() { "(none)" } else { &include_str }));
    if !scan.unavailable_roots.is_empty() {
        progress(&format!(
            "Warning: could not completely scan {}; stale cleanup will be skipped.",
            scan.unavailable_roots.join(", ")
        ));
    }

    // Read + hash each scanned file.
    #[allow(dead_code)]
    struct FileInput {
        rel_path: String,
        abs_path: PathBuf,
        language: String,
        size: i64,
        mtime_ms: i64,
        sha256: String,
        parsed: ParsedDocument,
    }

    let mut inputs: Vec<FileInput> = Vec::new();
    for file in scanned {
        let metadata = match fs::metadata(&file.abs_path) {
            Ok(m) => m,
            Err(_) => {
                progress(&format!("Skip (missing): {}", file.rel_path));
                continue;
            }
        };
        let content = match fs::read_to_string(&file.abs_path) {
            Ok(c) => c,
            Err(e) => {
                progress(&format!("Skip (unreadable): {} — {}", file.rel_path, e));
                continue;
            }
        };
        let sha256 = sha256_hex(content.as_bytes());
        let mtime_ms = mtime_to_ms(metadata.modified().ok());
        let parsed = parse_document(&content, &file.rel_path);
        inputs.push(FileInput {
            rel_path: file.rel_path.clone(),
            abs_path: file.abs_path.clone(),
            language: file.language.clone(),
            size: metadata.len() as i64,
            mtime_ms,
            sha256,
            parsed,
        });
    }

    let mut stats = IndexStats {
        scanned: scanned.len(),
        added: 0,
        updated: 0,
        skipped: 0,
        deleted: 0,
        chunks: 0,
        // Phase A: vectors are never written from Rust.
        vector_enabled: false,
    };

    let now = now_iso();

    let tx = conn.unchecked_transaction().map_err(|e| crate::CoreError::Storage(e.to_string()))?;

    if reset {
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap_or(0);
        tx.execute_batch("DELETE FROM files; DELETE FROM chunks; DELETE FROM chunks_fts;")
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        progress(&format!("Reset: cleared {} existing file(s).", count));
    }

    let scanned_paths: HashSet<String> = scanned.iter().map(|f| f.rel_path.clone()).collect();

    for input in &inputs {
        let existing = find_existing_file(&tx, &input.rel_path)?;
        let indexed_at = now.clone();

        // Change detection: sha256 + mtime + size all unchanged => skip.
        if !reset {
            if let Some(ref ex) = existing {
                if ex.size == input.size && ex.mtime == input.mtime_ms && !ex.sha256.is_empty() {
                    if ex.sha256 == input.sha256 {
                        persist_document_graph(&tx, ex.id, &input.parsed)?;
                        stats.skipped += 1;
                        continue;
                    }
                }
            }
        }

        // Remove prior chunks/fts for this file.
        if let Some(ref ex) = existing {
            delete_rows_for_file(&tx, ex.id)?;
        }

        // Upsert the file row.
        let file_id = if let Some(ref ex) = existing {
            tx.execute(
                "UPDATE files SET sha256=?1, mtime=?2, size=?3, language=?4, indexed_at=?5 WHERE id=?6",
                params![input.sha256, input.mtime_ms, input.size, input.language, indexed_at, ex.id],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
            progress(&format!("Updated: {}", input.rel_path));
            stats.updated += 1;
            ex.id
        } else {
            tx.execute(
                "INSERT INTO files (path, sha256, mtime, size, language, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![input.rel_path, input.sha256, input.mtime_ms, input.size, input.language, indexed_at],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
            let id = tx.last_insert_rowid();
            progress(&format!("Added: {}", input.rel_path));
            stats.added += 1;
            id
        };

        persist_document_graph(&tx, file_id, &input.parsed)?;

        // Chunk + write.
        let chunks = split_into_chunks(
            &input.parsed.body,
            &ChunkOptions { max_chars: config.chunk.max_chars, overlap: config.chunk.overlap },
        );
        for (i, chunk) in chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO chunks (file_id, chunk_index, content, start_line, end_line) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    file_id,
                    i as i64,
                    chunk.content,
                    chunk.start_line as i64 + input.parsed.body_start_line as i64 - 1,
                    chunk.end_line as i64 + input.parsed.body_start_line as i64 - 1,
                ],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
            let chunk_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO chunks_fts (rowid, content) VALUES (?1, ?2)",
                params![chunk_id, chunk.content],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
            stats.chunks += 1;
        }
    }

    // Stale cleanup: files in DB but not on disk.
    if !reset && scan.unavailable_roots.is_empty() {
        let mut stmt = tx
            .prepare("SELECT id, path FROM files")
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        let all_rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for (id, path) in &all_rows {
            if !scanned_paths.contains(path) {
                delete_rows_for_file(&tx, *id)?;
                tx.execute("DELETE FROM files WHERE id = ?1", params![id])
                    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
                stats.deleted += 1;
                progress(&format!("Deleted (stale): {}", path));
            }
        }
    }

    // Reconcile relation proposals + rebuild deterministic relations.
    reconcile_relation_proposals(&tx, &now)?;
    rebuild_deterministic_relations(
        &tx,
        &inputs.iter().map(|i| (i.rel_path.clone(), i.parsed.clone())).collect::<Vec<_>>(),
        scan.unavailable_roots.is_empty() && inputs.len() == scanned.len(),
    )?;

    // Write provenance metadata.
    let file_count: i64 = tx.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;
    let chunk_count: i64 = tx.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    write_index_metadata(
        &tx,
        options.source_revision.as_deref().unwrap_or(""),
        options.source_branch.as_deref().unwrap_or(""),
        &config.include,
        &compute_config_hash(config),
        &now,
        file_count,
        chunk_count,
    )?;

    tx.commit().map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    Ok(stats)
}

// ---------------------------------------------------------------------------
// Document graph persistence
// ---------------------------------------------------------------------------

struct ExistingFile {
    id: i64,
    #[allow(dead_code)]
    sha256: String,
    #[allow(dead_code)]
    mtime: i64,
    #[allow(dead_code)]
    size: i64,
}

fn find_existing_file(conn: &Connection, path: &str) -> Result<Option<ExistingFile>, crate::CoreError> {
    let row = conn
        .query_row(
            "SELECT id, sha256, mtime, size FROM files WHERE path = ?1",
            params![path],
            |row| {
                Ok(ExistingFile {
                    id: row.get(0)?,
                    sha256: row.get(1)?,
                    mtime: row.get(2)?,
                    size: row.get(3)?,
                })
            },
        )
        .optional_conn();
    Ok(row)
}

/// Inserts/updates the `documents`, `document_sections`, and `document_tags`
/// rows for a file. Mirrors `persistDocumentGraph`.
fn persist_document_graph(
    conn: &Connection,
    file_id: i64,
    parsed: &ParsedDocument,
) -> Result<(), crate::CoreError> {
    let metadata_json = serde_json::to_string(&parsed.metadata).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO documents (file_id, title, slug, summary, body, body_start_line, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_id) DO UPDATE SET
           title=excluded.title, slug=excluded.slug, summary=excluded.summary,
           body=excluded.body, body_start_line=excluded.body_start_line,
           metadata_json=excluded.metadata_json",
        params![
            file_id,
            parsed.title,
            parsed.slug,
            parsed.summary,
            parsed.body,
            parsed.body_start_line,
            metadata_json,
        ],
    )
    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;

    conn.execute("DELETE FROM document_sections WHERE file_id = ?1", params![file_id])
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    for section in &parsed.sections {
        conn.execute(
            "INSERT INTO document_sections (file_id, heading, slug, level, start_line) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![file_id, section.heading, section.slug, section.level, section.start_line],
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    }

    conn.execute("DELETE FROM document_tags WHERE file_id = ?1", params![file_id])
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    for tag in &parsed.tags {
        conn.execute(
            "INSERT INTO tags (name) VALUES (?1) ON CONFLICT(name) DO NOTHING",
            params![tag],
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        let tag_id: i64 = conn
            .query_row("SELECT id FROM tags WHERE name = ?1", params![tag], |row| row.get(0))
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        conn.execute(
            "INSERT OR IGNORE INTO document_tags (file_id, tag_id) VALUES (?1, ?2)",
            params![file_id, tag_id],
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Relation reconciliation
// ---------------------------------------------------------------------------

/// Rebinds proposal file IDs after stale cleanup and restores approved agent
/// edges. Mirrors `reconcileRelationProposals`.
fn reconcile_relation_proposals(conn: &Connection, now: &str) -> Result<(), crate::CoreError> {
    if !table_exists(conn, "relation_proposals") {
        return Ok(());
    }
    conn.execute_batch(
        "UPDATE relation_proposals
            SET source_file_id = (SELECT id FROM files WHERE path = relation_proposals.source_path),
                target_file_id = (SELECT id FROM files WHERE path = relation_proposals.target_path);",
    )
    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;

    conn.execute(
        "UPDATE relation_proposals SET status='invalid', reviewed_at=?1
         WHERE status IN ('pending','approved')
           AND (source_file_id IS NULL OR target_file_id IS NULL)",
        params![now],
    )
    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;

    let mut stmt = conn
        .prepare(
            "SELECT source_file_id, target_file_id, target_path, relation_type,
                    confidence, rationale, evidence_path, evidence_start_line,
                    evidence_end_line, evidence_text
               FROM relation_proposals
              WHERE status='approved' AND source_file_id IS NOT NULL AND target_file_id IS NOT NULL",
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    let approved: Vec<ApprovedRow> = stmt
        .query_map([], |row| {
            Ok(ApprovedRow {
                source_file_id: row.get(0)?,
                target_file_id: row.get(1)?,
                target_path: row.get(2)?,
                relation_type: row.get(3)?,
                confidence: row.get(4)?,
                rationale: row.get(5)?,
                evidence_path: row.get(6)?,
                evidence_start_line: row.get(7)?,
                evidence_end_line: row.get(8)?,
                evidence_text: row.get(9)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for proposal in &approved {
        conn.execute(
            "INSERT INTO relation_types (name, display_name, inverse_name, symmetric, core)
             VALUES (?1, ?2, NULL, 0, 0) ON CONFLICT(name) DO NOTHING",
            params![proposal.relation_type, proposal.relation_type],
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        conn.execute(
            "INSERT INTO document_relations (source_file_id, target_file_id, relation_type, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(source_file_id, target_file_id, relation_type)
             DO UPDATE SET updated_at=excluded.updated_at",
            params![
                proposal.source_file_id,
                proposal.target_file_id,
                proposal.relation_type,
                now,
                now,
            ],
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        let relation_id: i64 = conn.query_row(
            "SELECT id FROM document_relations
              WHERE source_file_id=?1 AND target_file_id=?2 AND relation_type=?3",
            params![proposal.source_file_id, proposal.target_file_id, proposal.relation_type],
            |row| row.get(0),
        ).map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        conn.execute(
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
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    }

    Ok(())
}

struct ApprovedRow {
    source_file_id: i64,
    target_file_id: i64,
    target_path: String,
    relation_type: String,
    confidence: f64,
    rationale: String,
    evidence_path: String,
    evidence_start_line: i64,
    evidence_end_line: i64,
    evidence_text: Option<String>,
}

/// Resolves parsed relation references against the current file map and writes
/// `document_relations` + `relation_evidence` or `unresolved_relation_refs`.
/// Mirrors `rebuildDeterministicRelations`.
fn rebuild_deterministic_relations(
    conn: &Connection,
    sources: &[(String, ParsedDocument)],
    full_refresh: bool,
) -> Result<(), crate::CoreError> {
    if !table_exists(conn, "document_relations") {
        return Ok(());
    }

    if full_refresh {
        conn.execute_batch(
            "DELETE FROM relation_evidence WHERE source_kind <> 'agent';
             DELETE FROM unresolved_relation_refs;",
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    } else {
        for (path, _) in sources {
            conn.execute(
                "DELETE FROM relation_evidence WHERE source_kind <> 'agent' AND source_path = ?1",
                params![path],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
            conn.execute(
                "DELETE FROM unresolved_relation_refs WHERE source_file_id = (SELECT id FROM files WHERE path = ?1)",
                params![path],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
        }
    }
    conn.execute_batch(
        "DELETE FROM document_relations
           WHERE NOT EXISTS (SELECT 1 FROM relation_evidence e WHERE e.relation_id = document_relations.id);",
    )
    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;

    // Build the document lookup map.
    let mut stmt = conn
        .prepare("SELECT f.id, f.path, d.title, d.slug FROM files f JOIN documents d ON d.file_id = f.id")
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    let docs: Vec<DocLookup> = stmt
        .query_map([], |row| {
            Ok(DocLookup {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                slug: row.get(3)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let by_path: HashMap<String, &DocLookup> =
        docs.iter().map(|d| (normalize_path(&d.path), d)).collect();
    let source_by_path: HashMap<String, &ParsedDocument> =
        sources.iter().map(|(p, d)| (normalize_path(p), d)).collect();

    let now = now_iso();

    for source in &docs {
        let Some(parsed) = source_by_path.get(&normalize_path(&source.path)) else { continue; };
        for ref_ in &parsed.relations {
            let relation_type = normalize_relation_type(&ref_.relation_type);
            conn.execute(
                "INSERT INTO relation_types (name, display_name, inverse_name, symmetric, core)
                 VALUES (?1, ?2, NULL, 0, 0) ON CONFLICT(name) DO NOTHING",
                params![relation_type, relation_type],
            )
            .map_err(|e| crate::CoreError::Storage(e.to_string()))?;

            let resolution = resolve_target(&source.path, ref_, &docs, &by_path);
            match resolution {
                ResolveResult::Found(target) => {
                    if target.id == source.id {
                        continue;
                    }
                    conn.execute(
                        "INSERT INTO document_relations (source_file_id, target_file_id, relation_type, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(source_file_id, target_file_id, relation_type)
                         DO UPDATE SET updated_at=excluded.updated_at",
                        params![source.id, target.id, relation_type, now, now],
                    )
                    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
                    let rel_id: i64 = conn.query_row(
                        "SELECT id FROM document_relations
                          WHERE source_file_id=?1 AND target_file_id=?2 AND relation_type=?3",
                        params![source.id, target.id, relation_type],
                        |row| row.get(0),
                    ).map_err(|e| crate::CoreError::Storage(e.to_string()))?;
                    conn.execute(
                        "INSERT OR IGNORE INTO relation_evidence
                          (relation_id, source_kind, original_target, source_path, start_line, end_line,
                           evidence_text, rationale, confidence)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 1.0)",
                        params![
                            rel_id,
                            ref_.source_kind.as_str(),
                            ref_.target,
                            source.path,
                            ref_.start_line,
                            ref_.start_line,
                            ref_.evidence_text,
                        ],
                    )
                    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
                }
                ResolveResult::Unresolved { reason } => {
                    conn.execute(
                        "INSERT OR IGNORE INTO unresolved_relation_refs
                          (source_file_id, relation_type, source_kind, original_target, source_path, start_line, reason)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            source.id,
                            relation_type,
                            ref_.source_kind.as_str(),
                            ref_.target,
                            source.path,
                            ref_.start_line,
                            reason,
                        ],
                    )
                    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
                }
            }
        }
    }

    Ok(())
}

struct DocLookup {
    id: i64,
    path: String,
    title: String,
    slug: String,
}

enum ResolveResult<'a> {
    Found(&'a DocLookup),
    Unresolved { reason: String },
}

/// Resolves a relation reference target to a document. Mirrors `resolveTarget`.
fn resolve_target<'a>(
    source_path: &str,
    ref_: &ParsedRelationReference,
    docs: &'a [DocLookup],
    by_path: &HashMap<String, &'a DocLookup>,
) -> ResolveResult<'a> {
    let mut raw = ref_.target.trim().to_owned();
    // decodeURIComponent equivalent — Rust's percent_encoding would need a crate.
    // For our purposes, most targets are plain paths; URL-encoded targets are rare.
    raw = percent_decode(&raw);

    let path_candidate = if raw.starts_with("./") || raw.starts_with("../") {
        let dir = posix_dirname(source_path);
        normalize_path(&posix_join(&dir, &raw))
    } else {
        normalize_path(&raw.trim_start_matches('/').to_owned())
    };

    let mut direct_candidates = vec![path_candidate.clone()];
    if posix_extname(&path_candidate).is_empty() {
        direct_candidates.push(format!("{}.md", path_candidate));
        direct_candidates.push(format!("{}.mdx", path_candidate));
        direct_candidates.push(format!("{}.txt", path_candidate));
    }
    for candidate in &direct_candidates {
        if let Some(found) = by_path.get(candidate) {
            return ResolveResult::Found(*found);
        }
    }

    if ref_.source_kind != RelationSourceKind::Wikilink {
        return ResolveResult::Unresolved { reason: "target_not_found".into() };
    }

    let key = raw.to_lowercase();
    let matches: Vec<&DocLookup> = docs
        .iter()
        .filter(|doc| {
            doc.slug.to_lowercase() == key
                || doc.title.to_lowercase() == key
                || posix_basename_no_ext(&doc.path).to_lowercase() == key
        })
        .collect();
    if matches.len() == 1 {
        return ResolveResult::Found(matches[0]);
    }
    ResolveResult::Unresolved {
        reason: if matches.len() > 1 { "ambiguous_target".into() } else { "target_not_found".into() },
    }
}

// ---------------------------------------------------------------------------
// Schema + metadata
// ---------------------------------------------------------------------------

/// Applies the base (non-vector) schema. Idempotent. Mirrors `applyBaseSchema`.
fn apply_base_schema(conn: &Connection) -> Result<(), crate::CoreError> {
    conn.execute_batch(BASE_SCHEMA_SQL).map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
        params![name],
        |_| Ok(()),
    )
    .is_ok()
}

fn delete_rows_for_file(conn: &Connection, file_id: i64) -> Result<(), crate::CoreError> {
    conn.execute(
        "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?1)",
        params![file_id],
    )
    .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    conn.execute("DELETE FROM chunks WHERE file_id = ?1", params![file_id])
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    Ok(())
}

fn write_index_metadata(
    conn: &Connection,
    source_revision: &str,
    source_branch: &str,
    content_dirs: &[String],
    config_hash: &str,
    built_at: &str,
    file_count: i64,
    chunk_count: i64,
) -> Result<(), crate::CoreError> {
    let dirs_json = serde_json::to_string(content_dirs).unwrap_or_else(|_| "[]".into());
    let entries: [(&str, String); 8] = [
        ("schema_version", EXPECTED_SCHEMA_VERSION.to_string()),
        ("source_revision", source_revision.to_owned()),
        ("source_branch", source_branch.to_owned()),
        ("content_directories", dirs_json),
        ("config_hash", config_hash.to_owned()),
        ("built_at", built_at.to_owned()),
        ("file_count", file_count.to_string()),
        ("chunk_count", chunk_count.to_string()),
    ];
    for (key, value) in &entries {
        conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| crate::CoreError::Storage(e.to_string()))?;
    }
    Ok(())
}

/// Computes a stable sha256 over the config parts that influence index contents.
fn compute_config_hash(config: &KbConfig) -> String {
    let mut include = config.include.clone();
    let mut exclude = config.exclude.clone();
    include.sort();
    exclude.sort();
    // Serialize in a stable order matching the TS `JSON.stringify(stable)`.
    let stable = serde_json::json!({
        "include": include,
        "exclude": exclude,
        "chunk": { "maxChars": config.chunk.max_chars, "overlap": config.chunk.overlap },
        "dimensions": config.embedding.dimensions,
    });
    let json = serde_json::to_string(&stable).unwrap_or_default();
    sha256_hex(json.as_bytes())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    hex_encode(&result)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn now_iso() -> String {
    // Simple ISO 8601 timestamp matching JS `new Date().toISOString()`.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();

    // Convert epoch seconds to UTC date-time.
    let days = secs / 86400;
    let remainder = secs % 86400;
    let hour = remainder / 3600;
    let minute = (remainder % 3600) / 60;
    let second = remainder % 60;

    let (year, month, day) = days_to_date(days as i64);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

/// Converts days since 1970-01-01 to (year, month, day). Algorithm from
/// <https://howardhinnant.github.io/date_algorithms.html>.
fn days_to_date(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { (mp + 3) as u32 } else { (mp - 9) as u32 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

fn mtime_to_ms(mtime: Option<SystemTime>) -> i64 {
    match mtime {
        Some(t) => t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0),
        None => 0,
    }
}

fn normalize_path(value: &str) -> String {
    let cleaned = value.replace('\\', "/");
    posix_normalize(&cleaned).replace("./", "")
}

fn posix_normalize(path: &str) -> String {
    // Simplified posix normalize: resolve "." and ".." segments.
    let mut segments: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    let joined = segments.join("/");
    if path.starts_with('/') {
        format!("/{}", joined)
    } else {
        joined
    }
}

fn posix_dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_owned(),
        None => String::new(),
    }
}

fn posix_join(dir: &str, file: &str) -> String {
    if dir.is_empty() {
        file.to_owned()
    } else {
        format!("{}/{}", dir, file)
    }
}

fn posix_extname(path: &str) -> String {
    match path.rfind('.') {
        Some(idx) if idx > path.rfind('/').unwrap_or(0) => path[idx..].to_owned(),
        _ => String::new(),
    }
}

fn posix_basename_no_ext(path: &str) -> String {
    let basename = match path.rfind('/') {
        Some(idx) => &path[idx + 1..],
        None => path,
    };
    match basename.rfind('.') {
        Some(idx) => basename[..idx].to_owned(),
        None => basename.to_owned(),
    }
}

/// Minimal percent-decoding (mirrors JS `decodeURIComponent` for common cases).
fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let bytes = s.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                result.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Trait extension to add `.optional_conn()` on query_row results.
trait OptionalConn {
    type Item;
    fn optional_conn(self) -> Option<Self::Item>;
}

impl<T> OptionalConn for Result<T, rusqlite::Error> {
    type Item = T;
    fn optional_conn(self) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(_) => None,
        }
    }
}

/// The base schema SQL. Verbatim from `packages/kb/src/db/schema.ts` (base part only;
/// the vec0 virtual table is omitted for Phase A).
const BASE_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT NOT NULL UNIQUE,
      sha256      TEXT NOT NULL,
      mtime       INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      language    TEXT NOT NULL,
      indexed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index  INTEGER NOT NULL,
      content      TEXT NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);

    CREATE TABLE IF NOT EXISTS documents (
      file_id          INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      title            TEXT NOT NULL,
      slug             TEXT NOT NULL,
      summary          TEXT,
      body             TEXT NOT NULL,
      body_start_line  INTEGER NOT NULL DEFAULT 1,
      metadata_json    TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug);
    CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);

    CREATE TABLE IF NOT EXISTS document_sections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      heading     TEXT NOT NULL,
      slug        TEXT NOT NULL,
      level       INTEGER NOT NULL,
      start_line  INTEGER NOT NULL,
      UNIQUE(file_id, slug, start_line)
    );

    CREATE INDEX IF NOT EXISTS idx_sections_file_id ON document_sections(file_id);

    CREATE TABLE IF NOT EXISTS relation_types (
      name           TEXT PRIMARY KEY,
      display_name   TEXT NOT NULL,
      inverse_name   TEXT,
      symmetric      INTEGER NOT NULL DEFAULT 0 CHECK (symmetric IN (0, 1)),
      core           INTEGER NOT NULL DEFAULT 0 CHECK (core IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS document_relations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      target_file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      relation_type   TEXT NOT NULL REFERENCES relation_types(name),
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(source_file_id, target_file_id, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_relations_source ON document_relations(source_file_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON document_relations(target_file_id);

    CREATE TABLE IF NOT EXISTS relation_evidence (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      relation_id      INTEGER NOT NULL REFERENCES document_relations(id) ON DELETE CASCADE,
      source_kind      TEXT NOT NULL CHECK (source_kind IN ('frontmatter','markdown_link','wikilink','agent')),
      original_target  TEXT NOT NULL,
      source_path      TEXT NOT NULL,
      start_line       INTEGER,
      end_line         INTEGER,
      evidence_text    TEXT,
      rationale        TEXT,
      confidence       REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      UNIQUE(relation_id, source_kind, source_path, start_line, original_target)
    );

    CREATE TABLE IF NOT EXISTS relation_proposals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id        INTEGER REFERENCES files(id) ON DELETE SET NULL,
      target_file_id        INTEGER REFERENCES files(id) ON DELETE SET NULL,
      source_path           TEXT NOT NULL,
      target_path           TEXT NOT NULL,
      relation_type         TEXT NOT NULL,
      confidence            REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
      rationale             TEXT NOT NULL,
      evidence_path         TEXT NOT NULL,
      evidence_start_line   INTEGER NOT NULL,
      evidence_end_line     INTEGER NOT NULL,
      evidence_text         TEXT,
      status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','invalid')),
      created_at            TEXT NOT NULL,
      reviewed_at           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_relation_proposals_status ON relation_proposals(status);

    CREATE TABLE IF NOT EXISTS unresolved_relation_refs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      relation_type    TEXT NOT NULL,
      source_kind      TEXT NOT NULL,
      original_target  TEXT NOT NULL,
      source_path      TEXT NOT NULL,
      start_line       INTEGER,
      reason           TEXT NOT NULL,
      UNIQUE(source_file_id, relation_type, source_kind, original_target, start_line)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY(file_id, tag_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, content='chunks', content_rowid='id');

    INSERT INTO schema_meta(key, value) VALUES ('schema_version', '3')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;

    INSERT INTO schema_meta(key, value) VALUES
      ('source_revision', ''),
      ('source_branch', ''),
      ('content_directories', '[]'),
      ('config_hash', ''),
      ('built_at', ''),
      ('file_count', '0'),
      ('chunk_count', '0')
    ON CONFLICT(key) DO NOTHING;

    INSERT OR IGNORE INTO relation_types(name, display_name, inverse_name, symmetric, core) VALUES
      ('references', 'references', 'referenced_by', 0, 1),
      ('depends_on', 'depends_on', 'dependency_of', 0, 1),
      ('implements', 'implements', 'implemented_by', 0, 1),
      ('extends', 'extends', 'extended_by', 0, 1),
      ('related_to', 'related_to', 'related_to', 1, 1);

    -- Drafts (待确认草稿): content staged by Pi/Agent before the user confirms
    -- the write. Fields per architecture-v1.md §10.2. `status` transitions:
    -- pending → applied | rejected | conflicted.
    CREATE TABLE IF NOT EXISTS drafts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id            TEXT NOT NULL UNIQUE,
      workspace_id        TEXT NOT NULL,
      target_path         TEXT NOT NULL,
      operation_type      TEXT NOT NULL CHECK (operation_type IN ('create','append','update_section','overwrite')),
      base_document_hash  TEXT NOT NULL DEFAULT '',
      generated_content   TEXT NOT NULL,
      source_citations    TEXT NOT NULL DEFAULT '[]',
      section_slug        TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','conflicted')),
      created_by          TEXT NOT NULL DEFAULT 'pi',
      created_at          TEXT NOT NULL,
      reviewed_at         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_workspace ON drafts(workspace_id);

    -- Write operations: audit record of each materialized file write produced
    -- by applying a draft. Per architecture-v1.md §8.5/§8.6.
    CREATE TABLE IF NOT EXISTS write_operations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id        TEXT NOT NULL REFERENCES drafts(draft_id),
      target_path     TEXT NOT NULL,
      operation_type  TEXT NOT NULL,
      backup_path     TEXT,
      content_hash    TEXT NOT NULL,
      bytes_written   INTEGER NOT NULL,
      applied_at      TEXT NOT NULL,
      applied_by      TEXT NOT NULL DEFAULT 'desktop'
    );

    CREATE INDEX IF NOT EXISTS idx_write_ops_draft ON write_operations(draft_id);

    -- Chat session metadata: maps workspaceId to sessionId with title, model, timestamps
    CREATE TABLE IF NOT EXISTS chat_sessions (
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

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id, updated_at DESC);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nonce = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-index-{}-{}-{}",
            std::process::id(),
            nonce,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn indexes_markdown_files() {
        let root = unique_temp_dir();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(
            root.join("wiki/intro.md"),
            "---\ntitle: Intro\n---\n# Introduction\n\nThis is the intro. See [other](wiki/other.md).",
        )
        .unwrap();
        fs::write(root.join("wiki/other.md"), "# Other\n\nSome content here.").unwrap();

        let stats = index_files(IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();

        assert_eq!(stats.scanned, 2);
        assert_eq!(stats.added, 2);
        assert!(stats.chunks > 0);

        // Verify the DB is readable by the store.
        let store = crate::store::SqliteStore::from_root(&root);
        let list = store.list_files(Default::default()).unwrap();
        assert_eq!(list.total, 2);
        let stats = store.stats().unwrap();
        assert!(stats.tables_ok);
        assert_eq!(stats.files, 2);
    }

    #[test]
    fn incremental_skip_unchanged_files() {
        let root = unique_temp_dir();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/a.md"), "# A\ncontent").unwrap();

        let opts = IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        };
        let first = index_files(opts).unwrap();
        assert_eq!(first.added, 1);

        // Second pass without changes.
        let opts = IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        };
        let second = index_files(opts).unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(second.updated, 0);
    }

    #[test]
    fn stale_cleanup_removes_deleted_files() {
        let root = unique_temp_dir();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/a.md"), "# A").unwrap();
        fs::write(root.join("wiki/b.md"), "# B").unwrap();

        let opts = IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        };
        index_files(opts).unwrap();

        // Delete b.md and re-index.
        fs::remove_file(root.join("wiki/b.md")).unwrap();
        let opts = IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        };
        let second = index_files(opts).unwrap();
        assert_eq!(second.deleted, 1);

        let store = crate::store::SqliteStore::from_root(&root);
        let list = store.list_files(Default::default()).unwrap();
        assert_eq!(list.total, 1);
    }

    #[test]
    fn resolves_markdown_link_relations() {
        let root = unique_temp_dir();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("wiki/a.md"), "# A\nSee [B](wiki/b.md)").unwrap();
        fs::write(root.join("wiki/b.md"), "# B\nContent").unwrap();

        index_files(IndexRunOptions {
            project_root: root.clone(),
            db_path: None,
            config: KbConfig::default(),
            reset: false,
            source_revision: None,
            source_branch: None,
            on_progress: None,
        })
        .unwrap();

        let store = crate::store::SqliteStore::from_root(&root);
        let rels = store.all_relations().unwrap();
        assert_eq!(rels.len(), 1, "expected one resolved relation: {:?}", rels);
        assert_eq!(rels[0].relation_type, "references");
        assert!(rels[0].source_path.ends_with("a.md"));
        assert!(rels[0].target_path.ends_with("b.md"));
    }

    #[test]
    fn config_hash_is_stable() {
        let config = KbConfig::default();
        let hash1 = compute_config_hash(&config);
        let hash2 = compute_config_hash(&config);
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64); // sha256 hex
    }
}
