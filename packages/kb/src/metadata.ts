import { createHash } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import type { KbConfig, IndexMetadata } from "./types.js";
import { EXPECTED_SCHEMA_VERSION } from "./types.js";

/**
 * Index provenance metadata.
 *
 * Stored in the `schema_meta` KV table (one row per key) so the schema itself
 * never needs to change when we add metadata fields. The indexer writes a full
 * snapshot after every successful pass; readers (`status`, `search --json`,
 * `validate`) reassemble it via {@link readIndexMetadata}.
 *
 * `sourceRevision` / `sourceBranch` are opaque strings supplied by the caller
 * — `llm-wiki-cli` deliberately has no concept of a repository, only a
 * directory. A higher-level orchestration layer (e.g. pi-agents) is expected
 * to pass the merged commit sha so answers can cite exactly which version of
 * the knowledge base they came from.
 */

/**
 * Computes a stable sha256 over the parts of {@link KbConfig} that influence
 * index contents. Sorting the arrays before hashing means reordering
 * `include`/`exclude` without changing membership does not trigger a rebuild.
 */
export function computeConfigHash(config: KbConfig): string {
  const stable = {
    include: [...config.include].sort(),
    exclude: [...config.exclude].sort(),
    chunk: {
      maxChars: config.chunk.maxChars,
      overlap: config.chunk.overlap,
    },
    dimensions: config.embedding.dimensions,
  };
  return createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex");
}

/** Input for {@link writeIndexMetadata}. */
export interface IndexMetadataInput {
  /** Caller-supplied source revision sha. Empty string when unspecified. */
  sourceRevision?: string;
  /** Caller-supplied source branch label. Empty string when unspecified. */
  sourceBranch?: string;
  /** `kb.include` directories the index was built from. */
  contentDirectories: string[];
  /** Precomputed config hash (see {@link computeConfigHash}). */
  configHash: string;
  /** ISO timestamp of the build. */
  builtAt: string;
  /** File count at build time. */
  fileCount: number;
  /** Chunk count at build time. */
  chunkCount: number;
}

/**
 * Upserts the full index metadata snapshot. Intended to be called inside the
 * indexer's write transaction so the metadata commits atomically with the
 * rows it describes.
 */
export function writeIndexMetadata(db: DatabaseType, input: IndexMetadataInput): void {
  const entries: Array<[string, string]> = [
    ["schema_version", String(EXPECTED_SCHEMA_VERSION)],
    ["source_revision", input.sourceRevision ?? ""],
    ["source_branch", input.sourceBranch ?? ""],
    ["content_directories", JSON.stringify(input.contentDirectories)],
    ["config_hash", input.configHash],
    ["built_at", input.builtAt],
    ["file_count", String(input.fileCount)],
    ["chunk_count", String(input.chunkCount)],
  ];
  const upsert = db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const [key, value] of entries) {
    upsert.run(key, value);
  }
}

/** Returns true if the `schema_meta` table exists in the database. */
function metaTableExists(db: DatabaseType): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get() as { ok?: number } | undefined;
  return row?.ok === 1;
}

/**
 * Reads the stored index metadata, or `null` when the DB has no `schema_meta`
 * table (e.g. a freshly created or partially initialized DB). Missing keys
 * default to empty/zero rather than throwing so a partially-written index is
 * still observable.
 */
export function readIndexMetadata(db: DatabaseType): IndexMetadata | null {
  if (!metaTableExists(db)) return null;
  const select = db.prepare<[string], { value: string }>(
    "SELECT value FROM schema_meta WHERE key = ?",
  );
  const get = (key: string): string => select.get(key)?.value ?? "";
  const parsedDirectories = safeParseStringArray(get("content_directories"));
  return {
    schemaVersion: Number.parseInt(get("schema_version"), 10) || 0,
    sourceRevision: get("source_revision"),
    sourceBranch: get("source_branch"),
    contentDirectories: parsedDirectories,
    configHash: get("config_hash"),
    builtAt: get("built_at"),
    fileCount: Number.parseInt(get("file_count"), 10) || 0,
    chunkCount: Number.parseInt(get("chunk_count"), 10) || 0,
  };
}

function safeParseStringArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : [];
  } catch {
    return [];
  }
}
