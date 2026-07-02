import type { Database as DatabaseType } from "better-sqlite3";
import { withReadonlyDb, type OpenOptions } from "./db/connection.js";
import { TABLE_NAMES } from "./db/schema.js";
import type {
  KbStats,
  KbFileListPage,
  KbFileDetail,
  KbFileContent,
  KbChunk,
  ListFilesOptions,
} from "./types.js";

/**
 * Read-only data access (the "lib/kb" layer).
 *
 * Each function opens a short-lived read-only connection and closes it after,
 * matching the reference system's `withDb` pattern. All queries validate the
 * required tables exist first so a freshly created (or missing) DB returns a
 * well-formed "empty" result rather than throwing.
 */

/** True if a table exists in the DB schema. */
function tableExists(db: DatabaseType, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as { ok?: number } | undefined;
  return row?.ok === 1;
}

/** Returns true iff all base tables (files / chunks / chunks_fts) exist. */
function baseTablesOk(db: DatabaseType): boolean {
  return (
    tableExists(db, TABLE_NAMES.files) &&
    tableExists(db, TABLE_NAMES.chunks) &&
    tableExists(db, TABLE_NAMES.fts)
  );
}

function count(db: DatabaseType, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

/**
 * Returns aggregated index health / volume metrics. Safe to call before any
 * index has run (returns zeros + `tablesOk: false`).
 */
export function getKbStats(options: OpenOptions = {}): KbStats {
  return withReadonlyDb(options, (conn) => {
    const db = conn.db;
    const tablesOk = baseTablesOk(db);
    const vectorEnabled = conn.vectorEnabled && tableExists(db, TABLE_NAMES.vec);

    return {
      dbPath: conn.dbPath,
      files: count(db, TABLE_NAMES.files),
      chunks: count(db, TABLE_NAMES.chunks),
      ftsRecords: count(db, TABLE_NAMES.fts),
      vectorRecords: vectorEnabled ? count(db, TABLE_NAMES.vec) : 0,
      earliestIndexedAt: earliestLatest(db, "ASC"),
      latestIndexedAt: earliestLatest(db, "DESC"),
      tablesOk,
      vectorEnabled,
      byLanguage: byLanguage(db),
      byRoot: byRoot(db),
    };
  });
}

function earliestLatest(db: DatabaseType, dir: "ASC" | "DESC"): string | null {
  if (!tableExists(db, TABLE_NAMES.files)) return null;
  const row = db
    .prepare(
      `SELECT indexed_at AS v FROM files WHERE indexed_at IS NOT NULL ORDER BY indexed_at ${dir} LIMIT 1`,
    )
    .get() as { v?: string } | undefined;
  return row?.v ?? null;
}

interface LangRow {
  language: string;
  count: number;
}
function byLanguage(db: DatabaseType): LangRow[] {
  if (!tableExists(db, TABLE_NAMES.files)) return [];
  return db
    .prepare("SELECT language, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC, language ASC")
    .all() as LangRow[];
}

interface RootRow {
  root: string;
  count: number;
}
function byRoot(db: DatabaseType): RootRow[] {
  if (!tableExists(db, TABLE_NAMES.files)) return [];
  // The first path segment is the include root (e.g. `wiki/foo.md` → `wiki`).
  return db
    .prepare(
      `SELECT substr(path, 1, instr(path || '/', '/') - 1) AS root, COUNT(*) AS count
         FROM files
        GROUP BY root
        ORDER BY count DESC, root ASC`,
    )
    .all() as RootRow[];
}

/** Paginated file list with optional path LIKE filter. */
export function listFiles(options: OpenOptions & ListFilesOptions = {}): KbFileListPage {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, options.pageSize ?? 50));
  const q = options.q?.trim();

  return withReadonlyDb(options, (conn) => {
    const db = conn.db;
    if (!baseTablesOk(db)) {
      return { page, pageSize, total: 0, files: [] };
    }

    const where = q ? "WHERE f.path LIKE ?" : "";
    const params: string[] = [];
    if (q) params.push(`%${q}%`);

    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM files f ${where}`)
      .get(...params) as { c: number };
    const total = countRow.c;

    const offset = (page - 1) * pageSize;
    const rows = db
      .prepare(
        `SELECT f.id          AS id,
                f.path         AS path,
                f.language     AS language,
                f.size         AS size,
                f.indexed_at   AS indexedAt,
                COUNT(c.id)    AS chunkCount
           FROM files f
      LEFT JOIN chunks c ON c.file_id = f.id
          ${where}
       GROUP BY f.id
       ORDER BY f.path ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as Array<{
      id: number;
      path: string;
      language: string;
      size: number;
      indexedAt: string | null;
      chunkCount: number;
    }>;

    return { page, pageSize, total, files: rows };
  });
}

/** A file plus a summary of its chunks. */
export function getFileDetail(fileId: number, options: OpenOptions = {}): KbFileDetail | null {
  return withReadonlyDb(options, (conn) => {
    const db = conn.db;
    if (!baseTablesOk(db)) return null;

    const file = db
      .prepare(
        `SELECT id, path, sha256, mtime, size, language, indexed_at AS indexedAt
           FROM files WHERE id = ?`,
      )
      .get(fileId) as
      | {
          id: number;
          path: string;
          sha256: string;
          mtime: number;
          size: number;
          language: string;
          indexedAt: string | null;
        }
      | undefined;
    if (!file) return null;

    const chunks = db
      .prepare(
        `SELECT id, chunk_index AS chunkIndex, start_line AS startLine, end_line AS endLine
           FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC`,
      )
      .all(fileId) as Array<{
      id: number;
      chunkIndex: number;
      startLine: number;
      endLine: number;
    }>;

    return { file, chunks };
  });
}

/**
 * A file's full content, reassembled by concatenating its chunks in order.
 *
 * Returns `null` if the base tables are missing or the file id is unknown.
 * The returned `content` joins chunk `content` values with `\n`; the
 * per-chunk line ranges are preserved in `chunks` so callers can render
 * source anchors or derive a table of contents.
 */
export function getFileContent(fileId: number, options: OpenOptions = {}): KbFileContent | null {
  return withReadonlyDb(options, (conn) => {
    const db = conn.db;
    if (!baseTablesOk(db)) return null;

    const file = db
      .prepare(`SELECT id, path, language FROM files WHERE id = ?`)
      .get(fileId) as { id: number; path: string; language: string } | undefined;
    if (!file) return null;

    const chunks = db
      .prepare(
        `SELECT id, chunk_index AS chunkIndex, start_line AS startLine, end_line AS endLine, content
           FROM chunks WHERE file_id = ? ORDER BY chunk_index ASC`,
      )
      .all(fileId) as Array<{
      id: number;
      chunkIndex: number;
      startLine: number;
      endLine: number;
      content: string;
    }>;

    const content = chunks.map((c) => c.content).join("\n");
    return {
      fileId: file.id,
      path: file.path,
      language: file.language,
      content,
      chunks: chunks.map(({ id, chunkIndex, startLine, endLine }) => ({
        id,
        chunkIndex,
        startLine,
        endLine,
      })),
    };
  });
}

/** Full content of a single chunk. */
export function getChunkDetail(chunkId: number, options: OpenOptions = {}): KbChunk | null {
  return withReadonlyDb(options, (conn) => {
    const db = conn.db;
    if (!baseTablesOk(db)) return null;

    const row = db
      .prepare(
        `SELECT id, file_id AS fileId, chunk_index AS chunkIndex, content,
                start_line AS startLine, end_line AS endLine
           FROM chunks WHERE id = ?`,
      )
      .get(chunkId) as
      | {
          id: number;
          fileId: number;
          chunkIndex: number;
          content: string;
          startLine: number;
          endLine: number;
        }
      | undefined;
    return row ?? null;
  });
}
