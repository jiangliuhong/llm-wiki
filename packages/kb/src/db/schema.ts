import type { Database } from "better-sqlite3";

/**
 * Database schema (DDL) for the knowledge base.
 *
 * Ported from the reference system (`scripts/kb/init-db.mjs`):
 *   - `files`    : one row per indexed source file (path is unique).
 *   - `chunks`   : one row per text chunk; `id` is shared with `chunks_fts`
 *                  and `vec_chunks` via `content_rowid='id'` / `rowid`.
 *   - `chunks_fts`: FTS5 external-content table over `chunks.content`.
 *   - `vec_chunks`: sqlite-vec `vec0` table keyed by `chunks.id` rowid.
 *
 * The vector table dimension is passed in (must equal `embedding.dimensions`);
 * sqlite-vec is optional at runtime, so its DDL is applied separately from the
 * base schema (see {@link applyVectorSchema}).
 */

/**
 * Applies the base (non-vector) schema to a database. Idempotent.
 */
export function applyBaseSchema(db: Database): void {
  db.exec(`
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

    -- External-content FTS5 table: indexes chunks.content, keyed by chunks.id.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, content='chunks', content_rowid='id');
  `);
}

/**
 * Applies the sqlite-vec virtual table. Only called when the vec0 extension is
 * loaded. Idempotent.
 *
 * @param db          Open database.
 * @param dimensions  Vector dimensionality (must match generated embeddings).
 */
export function applyVectorSchema(db: Database, dimensions: number): void {
  // sqlite-vec's vec0 module uses rowid as the key; we insert `chunks.id` as
  // the rowid so vectors join back to chunks/files.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
    USING vec0(
      embedding float[${dimensions}]
    );
  `);
}

/** Names of the tables we check for health stats. */
export const TABLE_NAMES = {
  files: "files",
  chunks: "chunks",
  fts: "chunks_fts",
  vec: "vec_chunks",
} as const;
