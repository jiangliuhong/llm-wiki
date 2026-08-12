import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { scanFilesDetailed } from "./scanner.js";
import { splitIntoChunks } from "./chunker.js";
import { generateEmbedding, float32ToBytes } from "./embedding.js";
import { ensureKbDir, initSchema } from "./db/init.js";
import { openDatabase, closeConnection, type KbConnection } from "./db/connection.js";
import { computeConfigHash, writeIndexMetadata } from "./metadata.js";
import type { KbConfig, IndexStats } from "./types.js";
import {
  normalizeRelationType,
  parseDocument,
  type ParsedDocument,
  type ParsedRelationReference,
} from "./document-parser.js";

/**
 * Incremental indexer.
 *
 * Ported from the reference system's `scripts/kb/index-files.mjs`:
 *   - Scan configured include dirs.
 *   - For each file: compute sha256 + mtime + size; skip if all three are
 *     unchanged since last index.
 *   - For changed/new files: delete any old chunks (and their FTS + vec rows),
 *     re-chunk, and write new chunks + FTS + (optionally) vectors.
 *   - Delete DB rows for files that no longer exist on disk (stale cleanup).
 *   - All writes run inside a single SQLite transaction.
 */

export interface IndexRunOptions {
  /** Project root the KB belongs to. */
  projectRoot?: string;
  /**
   * Explicit SQLite file path. When omitted the default
   * `<projectRoot>/.llm-wiki/index.db` is used. Supports building into a
   * throwaway file (e.g. `index --output-db`) that the caller swaps in
   * atomically after a successful index + validate.
   */
  dbPath?: string;
  /** Resolved KB config (merged with defaults by the caller). */
  config: KbConfig;
  /**
   * Wipe all existing rows before indexing (full rebuild). When true, every
   * scanned file is treated as new.
   */
  reset?: boolean;
  /**
   * Free-form revision identifier (e.g. the merged commit sha) to record as
   * the source this index was built from. `llm-wiki` never reads git —
   * callers (e.g. pi-agents) are responsible for passing the right value.
   * Stored verbatim in index metadata.
   */
  sourceRevision?: string;
  /** Optional human-readable source branch label, recorded alongside the revision. */
  sourceBranch?: string;
  /** Receives one line per significant event (for CLI output). */
  onProgress?: (message: string) => void;
}

/** SHA-256 hex digest of a file's contents. */
function sha256OfFile(absPath: string): { sha256: string; content: string } {
  const content = nodeFs.readFileSync(absPath, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  return { sha256, content };
}

interface ExistingFile {
  id: number;
  sha256: string;
  mtime: number;
  size: number;
}

/**
 * Runs an incremental index pass. Opens its own connection, ensures the schema,
 * and writes results in a single transaction. Returns aggregate stats.
 */
export function indexFiles(options: IndexRunOptions): IndexStats {
  const projectRoot = options.projectRoot ?? process.cwd();
  const onProgress = options.onProgress ?? (() => {});

  ensureKbDir(projectRoot, options.dbPath);
  const conn = openDatabase({
    projectRoot,
    dbPath: options.dbPath,
    loadVector: options.config.embedding.enabled,
    warn: onProgress,
  });
  try {
    initSchema(conn, options.config.embedding.dimensions, {
      resetVector: options.reset ?? false,
    });
    return runIndex(conn, projectRoot, options);
  } finally {
    closeConnection(conn);
  }
}

function runIndex(conn: KbConnection, projectRoot: string, options: IndexRunOptions): IndexStats {
  const db = conn.db;
  const config = options.config;
  const reset = options.reset ?? false;
  const onProgress = options.onProgress ?? (() => {});

  const scan = scanFilesDetailed({
    projectRoot,
    include: config.include,
    exclude: config.exclude,
  });
  const scanned = scan.files;
  onProgress(`Scanned ${scanned.length} file(s) under ${config.include.join(", ") || "(none)"}.`);
  if (scan.unavailableRoots.length > 0) {
    onProgress(
      `Warning: could not completely scan ${scan.unavailableRoots.join(", ")}; stale cleanup will be skipped.`,
    );
  }

  const inputs = scanned.flatMap((file) => {
    const stat = safeStat(file.absPath);
    if (!stat) {
      onProgress(`Skip (missing): ${file.relPath}`);
      return [];
    }
    try {
      const read = sha256OfFile(file.absPath);
      return [{ file, stat, ...read, parsed: parseDocument(read.content, file.relPath) }];
    } catch (err) {
      onProgress(`Skip (unreadable): ${file.relPath} — ${(err as Error).message}`);
      return [];
    }
  });

  // Prepared statements.
  const findExisting = db.prepare<[string], ExistingFile>(
    "SELECT id, sha256, mtime, size FROM files WHERE path = ?",
  );
  const insertFile = db.prepare<[string, string, number, number, string, string], { id: number }>(
    `INSERT INTO files (path, sha256, mtime, size, language, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const updateFile = db.prepare<[string, number, number, string, string, number]>(
    `UPDATE files
       SET sha256 = ?, mtime = ?, size = ?, language = ?, indexed_at = ?
     WHERE id = ?`,
  );
  const deleteChunksByFile = db.prepare<[number]>("DELETE FROM chunks WHERE file_id = ?");
  const deleteFtsByFile = db.prepare<[number]>(
    `DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?)`,
  );
  const deleteVecByFile = conn.vectorEnabled
    ? db.prepare<[number]>(
        `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?)`,
      )
    : null;
  const insertChunk = db.prepare<[number, number, string, number, number], { id: number }>(
    `INSERT INTO chunks (file_id, chunk_index, content, start_line, end_line)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const insertFts = db.prepare<[number, string]>(
    "INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)",
  );
  const insertVec = conn.vectorEnabled
    ? db.prepare<[number | bigint, Uint8Array]>(
        "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
      )
    : null;
  const findAllPaths = db.prepare<[], { id: number; path: string }>("SELECT id, path FROM files");
  const hasMissingVectors = conn.vectorEnabled
    ? db.prepare<[number], { missing: number }>(
        `SELECT EXISTS(
           SELECT 1
             FROM chunks AS c
             LEFT JOIN vec_chunks AS v ON v.rowid = c.id
            WHERE c.file_id = ? AND v.rowid IS NULL
         ) AS missing`,
      )
    : null;

  const stats: IndexStats = {
    scanned: scanned.length,
    added: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    chunks: 0,
    vectorEnabled: conn.vectorEnabled,
  };

  const tx = db.transaction(() => {
    if (reset) {
      const n = db.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number };
      db.exec("DELETE FROM files");
      db.exec("DELETE FROM chunks");
      db.exec("DELETE FROM chunks_fts");
      if (conn.vectorEnabled) {
        db.exec("DELETE FROM vec_chunks");
      }
      onProgress(`Reset: cleared ${n.c} existing file(s).`);
    }

    // A discovered-but-temporarily-unreadable file is still present and must
    // not be mistaken for a stale deletion.
    const scannedPaths = new Set(scanned.map((file) => file.relPath));

    for (const input of inputs) {
      const { file, stat, sha256, parsed } = input;

      const existing = findExisting.get(file.relPath) ?? null;
      const indexedAt = new Date().toISOString();

      // Change detection: sha256 + mtime + size all unchanged ⇒ skip.
      if (
        !reset &&
        existing !== null &&
        existing.size === stat.size &&
        existing.mtime === Math.floor(stat.mtimeMs) &&
        existing.sha256 // sha256 present
      ) {
        // Still need to verify content hash to be certain; only stat-skip when
        // the hash also matches (cheap-ish relative to re-chunking).
        const skip = sha256 === existing.sha256;
        const vectorsComplete =
          !hasMissingVectors || (hasMissingVectors.get(existing.id)?.missing ?? 0) === 0;
        if (skip && vectorsComplete) {
          persistDocumentGraph(db, existing.id, parsed);
          stats.skipped++;
          continue;
        }
      }

      // Remove prior chunks/fts/vec for this file (path may already exist).
      if (existing !== null) {
        deleteRowsForFile(existing.id, deleteFtsByFile, deleteVecByFile, deleteChunksByFile);
      }

      // Upsert the file row.
      let fileId: number;
      if (existing !== null) {
        updateFile.run(
          sha256,
          Math.floor(stat.mtimeMs),
          stat.size,
          file.language,
          indexedAt,
          existing.id,
        );
        fileId = existing.id;
        stats.updated++;
        onProgress(`Updated: ${file.relPath}`);
      } else {
        const row = insertFile.get(
          file.relPath,
          sha256,
          Math.floor(stat.mtimeMs),
          stat.size,
          file.language,
          indexedAt,
        );
        if (!row) {
          continue;
        }
        fileId = row.id;
        stats.added++;
        onProgress(`Added: ${file.relPath}`);
      }

      persistDocumentGraph(db, fileId, parsed);

      // Chunk + write.
      const chunks = splitIntoChunks(parsed.body, {
        maxChars: config.chunk.maxChars,
        overlap: config.chunk.overlap,
      });

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const inserted = insertChunk.get(
          fileId,
          i,
          chunk.content,
          chunk.startLine + parsed.bodyStartLine - 1,
          chunk.endLine + parsed.bodyStartLine - 1,
        );
        if (!inserted) continue;
        const chunkId = inserted.id;
        insertFts.run(chunkId, chunk.content);
        if (insertVec) {
          const vec = generateEmbedding(chunk.content, config.embedding.dimensions);
          // vec0 requires an INTEGER rowid; better-sqlite3 binds JS numbers as
          // REAL, so bind via BigInt to satisfy sqlite-vec's PK check.
          insertVec.run(BigInt(chunkId), float32ToBytes(vec));
        }
        stats.chunks++;
      }
    }

    // Stale cleanup: files in DB but not on disk.
    if (!reset && scan.unavailableRoots.length === 0) {
      const allRows = findAllPaths.all();
      for (const row of allRows) {
        if (!scannedPaths.has(row.path)) {
          deleteRowsForFile(row.id, deleteFtsByFile, deleteVecByFile, deleteChunksByFile);
          db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
          stats.deleted++;
          onProgress(`Deleted (stale): ${row.path}`);
        }
      }
    }

    reconcileRelationProposals(db);

    rebuildDeterministicRelations(
      db,
      inputs.map((input) => ({ path: input.file.relPath, parsed: input.parsed })),
      scan.unavailableRoots.length === 0 && inputs.length === scanned.length,
    );

    // Record provenance metadata atomically with the rows it describes. The
    // counts reflect the post-index state of the DB, not just this pass's
    // deltas, so consumers (status/validate) see the true index size.
    const fileCount = (
      db.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number }
    ).c;
    const chunkCount = (
      db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }
    ).c;
    writeIndexMetadata(db, {
      sourceRevision: options.sourceRevision,
      sourceBranch: options.sourceBranch,
      contentDirectories: [...config.include],
      configHash: computeConfigHash(config),
      builtAt: new Date().toISOString(),
      fileCount,
      chunkCount,
    });
  });

  tx();
  return stats;
}

function persistDocumentGraph(db: DatabaseType, fileId: number, parsed: ParsedDocument): void {
  db.prepare(
    `INSERT INTO documents(file_id, title, slug, summary, body, body_start_line, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       title=excluded.title, slug=excluded.slug, summary=excluded.summary,
       body=excluded.body, body_start_line=excluded.body_start_line,
       metadata_json=excluded.metadata_json`,
  ).run(
    fileId,
    parsed.title,
    parsed.slug,
    parsed.summary,
    parsed.body,
    parsed.bodyStartLine,
    JSON.stringify(parsed.metadata),
  );

  db.prepare("DELETE FROM document_sections WHERE file_id = ?").run(fileId);
  const insertSection = db.prepare(
    "INSERT INTO document_sections(file_id, heading, slug, level, start_line) VALUES (?, ?, ?, ?, ?)",
  );
  for (const section of parsed.sections) {
    insertSection.run(fileId, section.heading, section.slug, section.level, section.startLine);
  }

  db.prepare("DELETE FROM document_tags WHERE file_id = ?").run(fileId);
  const insertTag = db.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  const findTag = db.prepare<[string], { id: number }>("SELECT id FROM tags WHERE name = ?");
  const linkTag = db.prepare("INSERT OR IGNORE INTO document_tags(file_id, tag_id) VALUES (?, ?)");
  for (const tag of parsed.tags) {
    insertTag.run(tag);
    const row = findTag.get(tag);
    if (row) linkTag.run(fileId, row.id);
  }
}

interface DocumentLookupRow {
  id: number;
  path: string;
  title: string;
  slug: string;
}

function rebuildDeterministicRelations(
  db: DatabaseType,
  sources: Array<{ path: string; parsed: ParsedDocument }>,
  fullRefresh: boolean,
): void {
  if (fullRefresh) {
    db.exec(`
      DELETE FROM relation_evidence WHERE source_kind <> 'agent';
      DELETE FROM unresolved_relation_refs;
    `);
  } else {
    const deleteEvidence = db.prepare(
      "DELETE FROM relation_evidence WHERE source_kind <> 'agent' AND source_path = ?",
    );
    const deleteUnresolved = db.prepare(
      "DELETE FROM unresolved_relation_refs WHERE source_file_id = (SELECT id FROM files WHERE path = ?)",
    );
    for (const source of sources) {
      deleteEvidence.run(source.path);
      deleteUnresolved.run(source.path);
    }
  }
  db.exec(`
    DELETE FROM document_relations
      WHERE NOT EXISTS (SELECT 1 FROM relation_evidence e WHERE e.relation_id = document_relations.id);
  `);

  const docs = db
    .prepare(
      `SELECT f.id, f.path, d.title, d.slug FROM files f JOIN documents d ON d.file_id = f.id`,
    )
    .all() as DocumentLookupRow[];
  const byPath = new Map(docs.map((doc) => [normalizePath(doc.path), doc]));
  const sourceByPath = new Map(
    sources.map((source) => [normalizePath(source.path), source.parsed]),
  );
  const upsertType = db.prepare(
    `INSERT INTO relation_types(name, display_name, inverse_name, symmetric, core)
     VALUES (?, ?, NULL, 0, 0) ON CONFLICT(name) DO NOTHING`,
  );
  const upsertRelation = db.prepare(
    `INSERT INTO document_relations(source_file_id, target_file_id, relation_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_file_id, target_file_id, relation_type)
     DO UPDATE SET updated_at = excluded.updated_at
     RETURNING id`,
  );
  const insertEvidence = db.prepare(
    `INSERT OR IGNORE INTO relation_evidence
      (relation_id, source_kind, original_target, source_path, start_line, end_line, evidence_text, rationale, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1.0)`,
  );
  const insertUnresolved = db.prepare(
    `INSERT OR IGNORE INTO unresolved_relation_refs
      (source_file_id, relation_type, source_kind, original_target, source_path, start_line, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const source of docs) {
    const parsed = sourceByPath.get(normalizePath(source.path));
    if (!parsed) continue;
    for (const ref of parsed.relations) {
      const relationType = normalizeRelationType(ref.type);
      upsertType.run(relationType, relationType);
      const resolution = resolveTarget(source.path, ref, docs, byPath);
      if (!resolution.target) {
        insertUnresolved.run(
          source.id,
          relationType,
          ref.sourceKind,
          ref.target,
          source.path,
          ref.startLine,
          resolution.reason,
        );
        continue;
      }
      if (resolution.target.id === source.id) continue;
      const now = new Date().toISOString();
      const row = upsertRelation.get(source.id, resolution.target.id, relationType, now, now) as
        | { id: number }
        | undefined;
      if (row)
        insertEvidence.run(
          row.id,
          ref.sourceKind,
          ref.target,
          source.path,
          ref.startLine,
          ref.startLine,
          ref.evidenceText,
        );
    }
  }
}

/**
 * Rebinds audit records to the current file ids after stale cleanup/reset and
 * restores every approved Agent edge from its durable proposal payload.
 */
function reconcileRelationProposals(db: DatabaseType): void {
  db.exec(`
    UPDATE relation_proposals
       SET source_file_id = (SELECT id FROM files WHERE path = relation_proposals.source_path),
           target_file_id = (SELECT id FROM files WHERE path = relation_proposals.target_path);
  `);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE relation_proposals SET status='invalid', reviewed_at=?
      WHERE status IN ('pending','approved')
        AND (source_file_id IS NULL OR target_file_id IS NULL)`,
  ).run(now);

  const approved = db
    .prepare(
      `SELECT source_file_id AS sourceFileId, target_file_id AS targetFileId,
              target_path AS targetPath, relation_type AS relationType,
              confidence, rationale, evidence_path AS evidencePath,
              evidence_start_line AS startLine, evidence_end_line AS endLine,
              evidence_text AS evidenceText
         FROM relation_proposals
        WHERE status='approved' AND source_file_id IS NOT NULL AND target_file_id IS NOT NULL`,
    )
    .all() as Array<{
    sourceFileId: number;
    targetFileId: number;
    targetPath: string;
    relationType: string;
    confidence: number;
    rationale: string;
    evidencePath: string;
    startLine: number;
    endLine: number;
    evidenceText: string | null;
  }>;
  const upsertType = db.prepare(
    `INSERT INTO relation_types(name, display_name, inverse_name, symmetric, core)
     VALUES (?, ?, NULL, 0, 0) ON CONFLICT(name) DO NOTHING`,
  );
  const upsertRelation = db.prepare(
    `INSERT INTO document_relations(source_file_id, target_file_id, relation_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_file_id, target_file_id, relation_type)
     DO UPDATE SET updated_at=excluded.updated_at RETURNING id`,
  );
  const insertEvidence = db.prepare(
    `INSERT OR IGNORE INTO relation_evidence
      (relation_id, source_kind, original_target, source_path, start_line, end_line, evidence_text, rationale, confidence)
     VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const proposal of approved) {
    upsertType.run(proposal.relationType, proposal.relationType);
    const relation = upsertRelation.get(
      proposal.sourceFileId,
      proposal.targetFileId,
      proposal.relationType,
      now,
      now,
    ) as { id: number };
    insertEvidence.run(
      relation.id,
      proposal.targetPath,
      proposal.evidencePath,
      proposal.startLine,
      proposal.endLine,
      proposal.evidenceText,
      proposal.rationale,
      proposal.confidence,
    );
  }
}

function resolveTarget(
  sourcePath: string,
  ref: ParsedRelationReference,
  docs: DocumentLookupRow[],
  byPath: Map<string, DocumentLookupRow>,
): { target: DocumentLookupRow | null; reason: string } {
  let raw = ref.target.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* retain invalid escape literally */
  }
  const pathCandidate =
    raw.startsWith("./") || raw.startsWith("../")
      ? normalizePath(nodePath.posix.join(nodePath.posix.dirname(sourcePath), raw))
      : normalizePath(raw.replace(/^\//, ""));
  const directCandidates = [pathCandidate];
  if (!nodePath.posix.extname(pathCandidate)) {
    directCandidates.push(`${pathCandidate}.md`, `${pathCandidate}.mdx`, `${pathCandidate}.txt`);
  }
  for (const candidate of directCandidates) {
    const found = byPath.get(candidate);
    if (found) return { target: found, reason: "" };
  }
  if (ref.sourceKind !== "wikilink") return { target: null, reason: "target_not_found" };
  const key = raw.toLowerCase();
  const matches = docs.filter(
    (doc) =>
      doc.slug.toLowerCase() === key ||
      doc.title.toLowerCase() === key ||
      nodePath.posix.basename(doc.path, nodePath.posix.extname(doc.path)).toLowerCase() === key,
  );
  if (matches.length === 1) return { target: matches[0] ?? null, reason: "" };
  return { target: null, reason: matches.length > 1 ? "ambiguous_target" : "target_not_found" };
}

function normalizePath(value: string): string {
  return nodePath.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

/** Deletes chunks (and their FTS/vec rows) for a file. Called within a tx. */
function deleteRowsForFile(
  fileId: number,
  deleteFtsByFile: { run: (id: number) => void },
  deleteVecByFile: { run: (id: number) => void } | null,
  deleteChunksByFile: { run: (id: number) => void },
): void {
  deleteFtsByFile.run(fileId);
  deleteVecByFile?.run(fileId);
  deleteChunksByFile.run(fileId);
}

function safeStat(absPath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = nodeFs.statSync(absPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
