import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import { scanFiles } from "./scanner.js";
import { splitIntoChunks } from "./chunker.js";
import { generateEmbedding, float32ToBytes } from "./embedding.js";
import { initSchema } from "./db/init.js";
import { openDatabase, closeConnection, type KbConnection } from "./db/connection.js";
import type { KbConfig, IndexStats } from "./types.js";

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
  /** Resolved KB config (merged with defaults by the caller). */
  config: KbConfig;
  /**
   * Wipe all existing rows before indexing (full rebuild). When true, every
   * scanned file is treated as new.
   */
  reset?: boolean;
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

  const conn = openDatabase({ projectRoot, loadVector: true, warn: onProgress });
  try {
    initSchema(conn, options.config.embedding.dimensions);
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

  const scanned = scanFiles({
    projectRoot,
    include: config.include,
    exclude: config.exclude,
  });
  onProgress(`Scanned ${scanned.length} file(s) under ${config.include.join(", ") || "(none)"}.`);

  // Prepared statements.
  const findExisting = db.prepare<
    [string],
    ExistingFile
  >("SELECT id, sha256, mtime, size FROM files WHERE path = ?");
  const insertFile = db.prepare<
    [string, string, number, number, string, string],
    { id: number }
  >(
    `INSERT INTO files (path, sha256, mtime, size, language, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const updateFile = db.prepare<
    [string, number, number, string, string, number]
  >(
    `UPDATE files
       SET sha256 = ?, mtime = ?, size = ?, language = ?, indexed_at = ?
     WHERE id = ?`,
  );
  const deleteChunksByFile = db.prepare<[number]>(
    "DELETE FROM chunks WHERE file_id = ?",
  );
  const deleteFtsByFile = db.prepare<[number]>(
    `DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?)`,
  );
  const deleteVecByFile = conn.vectorEnabled
    ? db.prepare<[number]>(`DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE file_id = ?)`)
    : null;
  const insertChunk = db.prepare<
    [number, number, string, number, number],
    { id: number }
  >(
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

    const scannedPaths = new Set<string>();

    for (const file of scanned) {
      scannedPaths.add(file.relPath);

      const stat = safeStat(file.absPath);
      if (!stat) {
        onProgress(`Skip (missing): ${file.relPath}`);
        continue;
      }

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
        let skip = false;
        try {
          const { sha256 } = sha256OfFile(file.absPath);
          skip = sha256 === existing.sha256;
        } catch {
          skip = false;
        }
        if (skip) {
          stats.skipped++;
          continue;
        }
      }

      let content: string;
      let sha256: string;
      try {
        const read = sha256OfFile(file.absPath);
        content = read.content;
        sha256 = read.sha256;
      } catch (err) {
        onProgress(`Skip (unreadable): ${file.relPath} — ${(err as Error).message}`);
        continue;
      }

      // Remove prior chunks/fts/vec for this file (path may already exist).
      if (existing !== null) {
        deleteRowsForFile(existing.id, deleteFtsByFile, deleteVecByFile, deleteChunksByFile);
      }

      // Upsert the file row.
      let fileId: number;
      if (existing !== null) {
        updateFile.run(sha256, Math.floor(stat.mtimeMs), stat.size, file.language, indexedAt, existing.id);
        fileId = existing.id;
        stats.updated++;
        onProgress(`Updated: ${file.relPath}`);
      } else {
        const row = insertFile.get(file.relPath, sha256, Math.floor(stat.mtimeMs), stat.size, file.language, indexedAt);
        if (!row) {
          continue;
        }
        fileId = row.id;
        stats.added++;
        onProgress(`Added: ${file.relPath}`);
      }

      // Chunk + write.
      const chunks = splitIntoChunks(content, {
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
          chunk.startLine,
          chunk.endLine,
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
    if (!reset) {
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
  });

  tx();
  return stats;
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
