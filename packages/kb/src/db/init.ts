import nodeFs from "node:fs";
import nodePath from "node:path";
import { KB_DIR_NAME } from "./connection.js";
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

/** Ensures the `.llm-wiki/` directory exists. Returns its absolute path. */
export function ensureKbDir(projectRoot: string = process.cwd()): string {
  const dir = nodePath.resolve(projectRoot, KB_DIR_NAME);
  nodeFs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Initializes the database schema on an already-open connection.
 * Idempotent: safe to run on every startup.
 */
export function initSchema(conn: KbConnection, dimensions: number): void {
  applyBaseSchema(conn.db);
  if (conn.vectorEnabled) {
    applyVectorSchema(conn.db, dimensions);
  }
}
