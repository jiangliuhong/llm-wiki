import nodeFs from "node:fs";
import nodePath from "node:path";
import { resolveDbPath } from "./connection.js";
import { applyBaseSchema, applyVectorSchema } from "./schema.js";
import type { KbConnection } from "./connection.js";

/**
 * Database initialization: creates the `.llm-wiki/` directory if missing and
 * applies the (idempotent) schema. Vector schema is only applied when the
 * sqlite-vec extension is available.
 */

export interface InitOptions {
  /** Project root containing `.llm-wiki/`. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Embedding dimensionality (only used to size `vec_chunks`). */
  dimensions: number;
}

export interface InitSchemaOptions {
  /** Recreate an incompatible vector table instead of rejecting the index run. */
  resetVector?: boolean;
}

/**
 * Ensures the directory holding the DB exists. With an explicit `dbPath`
 * (e.g. `--output-db`) only that file's parent directory is created — the
 * default `.llm-wiki/` under `projectRoot` is left untouched. Returns the
 * absolute DB path.
 */
export function ensureKbDir(
  projectRoot: string = process.cwd(),
  dbPath?: string,
): string {
  const resolved = resolveDbPath(projectRoot, dbPath);
  nodeFs.mkdirSync(nodePath.dirname(resolved), { recursive: true });
  return resolved;
}

/**
 * Initializes the database schema on an already-open connection.
 * Idempotent: safe to run on every startup.
 */
export function initSchema(
  conn: KbConnection,
  dimensions: number,
  options: InitSchemaOptions = {},
): void {
  applyBaseSchema(conn.db);
  if (conn.vectorEnabled) {
    const existingDimensions = readVectorDimensions(conn);
    if (existingDimensions !== null && existingDimensions !== dimensions) {
      if (!options.resetVector) {
        throw new Error(
          `Vector index dimension changed from ${existingDimensions} to ${dimensions}. ` +
            `Run "llm-wiki-cli index --reset" to rebuild the vector table.`,
        );
      }
      conn.db.exec("DROP TABLE vec_chunks");
    }
    applyVectorSchema(conn.db, dimensions);
  }
}

/** Reads the declared vec0 embedding dimension from SQLite's stored DDL. */
function readVectorDimensions(conn: KbConnection): number | null {
  const row = conn.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const match = /embedding\s+float\[(\d+)\]/i.exec(row.sql);
  return match?.[1] ? Number(match[1]) : null;
}
