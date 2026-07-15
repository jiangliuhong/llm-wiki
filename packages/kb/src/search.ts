import type { Database as DatabaseType } from "better-sqlite3";
import { withReadonlyDb, type OpenOptions } from "./db/connection.js";
import { generateEmbedding, float32ToBytes } from "./embedding.js";
import type { SearchHit, SearchResult, SearchSource } from "./types.js";

/**
 * Hybrid retrieval.
 *
 * Ported from the reference system's `searchKnowledgeBase`:
 *   - Vector leg: KNN over `vec_chunks` (MATCH + k, ORDER BY distance asc).
 *   - FTS leg: FTS5 MATCH over `chunks_fts`, ORDER BY bm25 asc. If the query
 *     trips FTS5 (special chars like `P&L`), the leg fails gracefully: we keep
 *     the vector results and surface a `warning`.
 *   - Merge by chunk id; tag each hit with its `source`:
 *       `vector+fts` (both) > `fts` (fts only) > `vector` (vector only).
 *   - Within each bucket, sort by the native score (distance asc for vector,
 *     bm25 asc for fts). Truncate to `limit`. Each hit carries a `preview`.
 *
 * There is no numeric weight blend / RRF — ordering is the categorical priority
 * above plus per-bucket native score, exactly as the reference docs describe.
 */

export interface SearchRunOptions extends OpenOptions {
  /** Resolved KB config (for the embedding dimension). */
  dimensions: number;
  /** Enable the experimental deterministic-vector retrieval leg. */
  enableVector?: boolean;
  /** Max results to return. */
  limit?: number;
}

/** Default result cap (matches the HTTP API default). */
export const DEFAULT_SEARCH_LIMIT = 8;
/** Hard cap shared by CLI/API callers to keep local queries bounded. */
export const MAX_SEARCH_LIMIT = 50;

interface VectorRow {
  chunkId: number;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  distance: number;
}

interface FtsRow {
  chunkId: number;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  bm25: number;
}

/**
 * Runs a hybrid search. Opens a read-only DB connection.
 */
export function searchKnowledgeBase(
  query: string,
  options: SearchRunOptions,
): SearchResult {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    throw new Error("Search query must not be empty.");
  }
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`Search limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`);
  }
  const enableVector = options.enableVector ?? false;
  return withReadonlyDb(
    { projectRoot: options.projectRoot, loadVector: enableVector },
    (conn) => {
      const vectorEnabled = enableVector && conn.vectorEnabled;
      let warning: string | undefined;

      // Vector leg (optional).
      let vectorRows: VectorRow[] = [];
      if (vectorEnabled) {
        try {
          vectorRows = runVectorSearch(conn.db, normalizedQuery, limit, options.dimensions);
        } catch (err) {
          warning = `Vector query failed (${(err as Error).message}); showing FTS results only.`;
        }
      }

      // FTS leg (with graceful degradation for malformed queries).
      let ftsRows: FtsRow[] = [];
      try {
        ftsRows = runFtsSearch(conn.db, normalizedQuery, limit);
      } catch (err) {
        const ftsWarning =
          `Full-text query failed (${(err as Error).message}).` +
          ` Try splitting special characters like "&" or rephrasing.`;
        warning = warning ? `${warning} ${ftsWarning}` : ftsWarning;
      }

      const hits = mergeHits(vectorRows, ftsRows, limit);
      return { query: normalizedQuery, limit, hits, vectorEnabled, warning };
    },
  );
}

/** KNN search over the vec0 virtual table. */
function runVectorSearch(
  db: DatabaseType,
  query: string,
  k: number,
  dimensions: number,
): VectorRow[] {
  const vec = generateEmbedding(query, dimensions);
  const stmt = db.prepare<
    [Uint8Array, number],
    Omit<VectorRow, "chunkId"> & { id: number }
  >(
    `SELECT v.rowid AS id,
            c.file_id       AS fileId,
            f.path          AS path,
            c.start_line    AS startLine,
            c.end_line      AS endLine,
            c.content       AS content,
            v.distance      AS distance
       FROM vec_chunks AS v
       JOIN chunks     AS c ON c.id = v.rowid
       JOIN files      AS f ON f.id = c.file_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance`,
  );
  const rows = stmt.all(float32ToBytes(vec), k);
  return rows.map((r) => ({
    chunkId: r.id,
    fileId: r.fileId,
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    content: r.content,
    distance: r.distance,
  }));
}

/** FTS5 search, ordered by bm25 (ascending = more relevant). */
function runFtsSearch(db: DatabaseType, query: string, limit: number): FtsRow[] {
  const stmt = db.prepare<
    [string, number],
    Omit<FtsRow, "chunkId" | "bm25"> & { id: number; rank: number }
  >(
    `SELECT c.id         AS id,
            c.file_id    AS fileId,
            f.path       AS path,
            c.start_line AS startLine,
            c.end_line   AS endLine,
            c.content    AS content,
            bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks        AS c ON c.id = chunks_fts.rowid
       JOIN files         AS f ON f.id = c.file_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
  );
  const rows = stmt.all(query, limit);
  return rows.map((r) => ({
    chunkId: r.id,
    fileId: r.fileId,
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    content: r.content,
    bm25: r.rank,
  }));
}

/** Priority order for result buckets (lower index = higher relevance). */
const SOURCE_PRIORITY: Record<SearchSource, number> = {
  "vector+fts": 0,
  fts: 1,
  vector: 2,
};

/** Merges vector + fts rows into ranked {@link SearchHit}s. */
function mergeHits(vector: VectorRow[], fts: FtsRow[], limit: number): SearchHit[] {
  const byId = new Map<
    number,
    {
      vec?: VectorRow;
      fts?: FtsRow;
      source: SearchSource;
    }
  >();

  for (const v of vector) {
    byId.set(v.chunkId, { vec: v, source: "vector" });
  }
  for (const f of fts) {
    const existing = byId.get(f.chunkId);
    if (existing) {
      existing.fts = f;
      existing.source = "vector+fts";
    } else {
      byId.set(f.chunkId, { fts: f, source: "fts" });
    }
  }

  const hits: SearchHit[] = [];
  for (const [chunkId, entry] of byId) {
    const base = entry.vec ?? entry.fts;
    if (!base) continue;
    hits.push({
      chunkId,
      fileId: base.fileId,
      path: base.path,
      startLine: base.startLine,
      endLine: base.endLine,
      content: base.content,
      source: entry.source,
      distance: entry.vec?.distance,
      bm25: entry.fts?.bm25,
      preview: makePreview(base.content, 160),
    });
  }

  hits.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source];
    const pb = SOURCE_PRIORITY[b.source];
    if (pa !== pb) return pa - pb;
    // Within the same bucket, lower native score = better.
    const sa = nativeScore(a);
    const sb = nativeScore(b);
    if (sa !== sb) return sa - sb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return hits.slice(0, limit);
}

/** Picks the relevant native score for in-bucket sorting. */
function nativeScore(hit: SearchHit): number {
  if (hit.source === "vector") return hit.distance ?? Number.POSITIVE_INFINITY;
  if (hit.source === "fts") return hit.bm25 ?? Number.POSITIVE_INFINITY;
  // vector+fts: use FTS relevance as the primary native score.
  return hit.bm25 ?? hit.distance ?? Number.POSITIVE_INFINITY;
}

/** Builds a single-line preview snippet, collapsing whitespace. */
function makePreview(content: string, max: number): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}
