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
  /** Max results to return. */
  limit?: number;
}

/** Default result cap (matches the HTTP API default). */
export const DEFAULT_SEARCH_LIMIT = 8;

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
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  return withReadonlyDb({ projectRoot: options.projectRoot }, (conn) => {
    const vectorEnabled = conn.vectorEnabled;

    // Vector leg (optional).
    let vectorRows: VectorRow[] = [];
    if (vectorEnabled) {
      try {
        vectorRows = runVectorSearch(conn.db, query, limit, options.dimensions);
      } catch {
        // Treat vector failures the same as disabled — fall back to FTS only.
      }
    }

    // FTS leg (with graceful degradation for malformed queries).
    let ftsRows: FtsRow[] = [];
    let warning: string | undefined;
    try {
      ftsRows = runFtsSearch(conn.db, query, limit);
    } catch (err) {
      warning =
        `Full-text query failed (${(err as Error).message}); showing vector results only.` +
        ` Try splitting special characters like "&" or rephrasing.`;
    }

    const hits = mergeHits(vectorRows, ftsRows, limit);
    return { query, limit, hits, vectorEnabled, warning };
  });
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
  // vector+fts: prefer the (closer-to-zero) bm25, then distance as tiebreak.
  return hit.bm25 ?? hit.distance ?? Number.POSITIVE_INFINITY;
}

/** Builds a single-line preview snippet, collapsing whitespace. */
function makePreview(content: string, max: number): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}
