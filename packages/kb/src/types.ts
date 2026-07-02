/**
 * Public types for the knowledge-base engine.
 *
 * These shapes are returned by the data-access layer (`reader.ts`,
 * `search.ts`, `indexer.ts`) and are consumed by both the CLI commands and the
 * Next.js API routes. Keeping them in one place lets both surfaces share the
 * exact same contracts.
 */

/** KB-level configuration. Mirrors (and defaults from) the CLI's `WikiConfig.kb`. */
export interface KbConfig {
  /** Directories (relative to the project root) to scan recursively. */
  include: string[];
  /** Directory names to skip while scanning. */
  exclude: string[];
  /** Chunking controls. */
  chunk: {
    /** Max characters per chunk. */
    maxChars: number;
    /** Overlap (in characters) between adjacent chunks. */
    overlap: number;
  };
  /** Embedding controls. */
  embedding: {
    /** Vector dimensionality — MUST match the `vec_chunks` table. */
    dimensions: number;
  };
}

/** Result of a single indexing pass. */
export interface IndexStats {
  /** Files examined by the scanner. */
  scanned: number;
  /** Files newly indexed (not previously in the DB). */
  added: number;
  /** Files whose sha256/mtime/size changed and were re-indexed. */
  updated: number;
  /** Files unchanged since last index (skipped). */
  skipped: number;
  /** Files present in the DB but no longer on disk (removed). */
  deleted: number;
  /** Total chunks written this pass. */
  chunks: number;
  /** Whether the vector index is available. False ⇒ no embeddings stored. */
  vectorEnabled: boolean;
}

/** A file's row in the `files` table. */
export interface KbFileRecord {
  id: number;
  path: string;
  sha256: string;
  mtime: number;
  size: number;
  language: string;
  indexedAt: string | null;
}

/** A lightweight file row for list views. */
export interface KbFileSummary {
  id: number;
  path: string;
  language: string;
  size: number;
  indexedAt: string | null;
  /** Number of chunks owned by this file. */
  chunkCount: number;
}

/** A single chunk row. */
export interface KbChunk {
  id: number;
  fileId: number;
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
}

/** A file plus a summary of its chunks. */
export interface KbFileDetail {
  file: Omit<KbFileRecord, "indexedAt"> & { indexedAt: string | null };
  chunks: Pick<KbChunk, "id" | "chunkIndex" | "startLine" | "endLine">[];
}

/**
 * A file's full, reconstructed content.
 *
 * Chunks are stored separately and indexed by `chunk_index`; this view
 * concatenates them back into a single document for rendering (e.g. the
 * web reader). The per-chunk line ranges are kept so a UI can render
 * source anchors or a table of contents.
 */
export interface KbFileContent {
  fileId: number;
  path: string;
  language: string;
  /** The full content of the file, reassembled from its chunks. */
  content: string;
  /** Per-chunk metadata, ordered by `chunkIndex`. */
  chunks: Pick<KbChunk, "id" | "chunkIndex" | "startLine" | "endLine">[];
}

/** Per-language file count, for stats. */
export interface KbLanguageStat {
  language: string;
  count: number;
}

/** Per-root-directory file count, for stats. */
export interface KbRootStat {
  root: string;
  count: number;
}

/** Aggregated index health / volume metrics. */
export interface KbStats {
  dbPath: string;
  files: number;
  chunks: number;
  ftsRecords: number;
  vectorRecords: number;
  /** Earliest `indexed_at` across files, ISO string. */
  earliestIndexedAt: string | null;
  /** Latest `indexed_at` across files, ISO string. */
  latestIndexedAt: string | null;
  /** Whether all required tables exist (files / chunks / chunks_fts). */
  tablesOk: boolean;
  /** Whether the sqlite-vec extension loaded and `vec_chunks` exists. */
  vectorEnabled: boolean;
  byLanguage: KbLanguageStat[];
  byRoot: KbRootStat[];
}

/** Where a search hit came from. */
export type SearchSource = "vector+fts" | "fts" | "vector";

/** A single hybrid search result. */
export interface SearchHit {
  chunkId: number;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  source: SearchSource;
  /** Vector distance (cosine-style, lower = closer). Present when vector hit. */
  distance?: number;
  /** FTS5 bm25 rank (more relevant = smaller magnitude). Present when FTS hit. */
  bm25?: number;
  /** Short snippet of the chunk content for preview. */
  preview: string;
}

/** Output of a hybrid search. */
export interface SearchResult {
  query: string;
  limit: number;
  hits: SearchHit[];
  vectorEnabled: boolean;
  /** Populated if the FTS leg failed (e.g. special chars like "P&L"). */
  warning?: string;
}

/** Options for `listFiles`. */
export interface ListFilesOptions {
  page?: number;
  pageSize?: number;
  /** Optional LIKE filter applied to `path` (not anchored). */
  q?: string;
}

/** Paginated file list. */
export interface KbFileListPage {
  page: number;
  pageSize: number;
  total: number;
  files: KbFileSummary[];
}
