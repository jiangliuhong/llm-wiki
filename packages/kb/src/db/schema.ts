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

    -- External-content FTS5 table: indexes chunks.content, keyed by chunks.id.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, content='chunks', content_rowid='id');

    -- Index provenance metadata. schema_version is bumped when the schema or
    -- the metadata contract changes; the other keys record which source the
    -- index was built from (revision/branch/content dirs) and a hash of the
    -- index-affecting config so callers (pi-agents) can detect drift without
    -- parsing logs. Values are upserted by the indexer after each pass.
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
  documents: "documents",
  relations: "document_relations",
} as const;
