import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import nodePath from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * SQLite connection management for the knowledge base.
 *
 * Opens `<projectRoot>/.llm-wiki/index.db` via `better-sqlite3` and attempts
 * to load the `sqlite-vec` extension. Vector search is **optional**: if the
 * extension cannot be loaded (missing native binary, unsupported platform,
 * etc.), the connection still opens with `vectorEnabled = false` and the system
 * falls back to FTS-only retrieval. This keeps the tool usable even when the
 * native vector dependency fails to install or load.
 */

export interface KbConnection {
  db: DatabaseType;
  /** Absolute path to the index.db file. */
  dbPath: string;
  /** Whether sqlite-vec loaded successfully. */
  vectorEnabled: boolean;
}

export interface OpenOptions {
  /** Project root containing `.llm-wiki/`. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /**
   * Explicit SQLite file path. When omitted, the DB is resolved from
   * {@link projectRoot} as `<root>/.llm-wiki/index.db`. Decouples the DB
   * location from the project root so callers can build/serve indexes from
   * arbitrary files (e.g. `index --output-db`, `validate --db`).
   */
  dbPath?: string;
  /** Open the DB read-only (for queries). Defaults to `false` (read-write). */
  readonly?: boolean;
  /**
   * Whether to attempt loading the sqlite-vec extension. Defaults to `true`;
   * callers that never use vectors can pass `false` to skip the probe.
   */
  loadVector?: boolean;
  /** Optional logger; receives a warning when the extension fails to load. */
  warn?: (message: string) => void;
}

/** Directory name (relative to project root) holding the index DB. */
export const KB_DIR_NAME = ".llm-wiki";
/** SQLite file name inside {@link KB_DIR_NAME}. */
export const DB_FILE_NAME = "index.db";

/**
 * Resolves the absolute DB file path. An explicit `dbPath` (already absolute or
 * resolved against `process.cwd()` by the caller) wins; otherwise the default
 * `<projectRoot>/.llm-wiki/index.db` is used.
 */
export function resolveDbPath(projectRoot: string, dbPath?: string): string {
  if (dbPath && dbPath.length > 0) {
    return nodePath.isAbsolute(dbPath) ? dbPath : nodePath.resolve(process.cwd(), dbPath);
  }
  return nodePath.resolve(projectRoot, KB_DIR_NAME, DB_FILE_NAME);
}

/**
 * Opens the knowledge-base database.
 *
 * @throws If the SQLite file cannot be opened (e.g. corrupt, locked). Does NOT
 *   throw on vector-extension failure — that is reported via `vectorEnabled`
 *   and the optional `warn` callback.
 */
export function openDatabase(options: OpenOptions = {}): KbConnection {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dbPath = resolveDbPath(projectRoot, options.dbPath);

  const db = new Database(dbPath, {
    readonly: options.readonly ?? false,
    // better-sqlite3 default WAL gives concurrent reads; we keep defaults.
  });

  // FTS5 is compiled into the SQLite builds bundled with better-sqlite3 by
  // default; enable foreign keys for the `chunks.file_id` ON DELETE CASCADE.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  let vectorEnabled = false;
  if (options.loadVector ?? true) {
    vectorEnabled = tryLoadVecExtension(db, options.warn);
  }

  return { db, dbPath, vectorEnabled };
}

/**
 * Attempts to load the `sqlite-vec` extension. Returns `true` on success.
 *
 * sqlite-vec ships a native loadable extension whose `loadable_path` export
 * points at the platform-specific `.dylib`/`.so`/`.dll`. We resolve it lazily
 * and tolerate any failure mode (module missing, path resolution, SQL error).
 */
function tryLoadVecExtension(db: DatabaseType, warn?: (m: string) => void): boolean {
  try {
    // `sqlite-vec` exposes a `load(db)` convenience that resolves the platform
    // binary and calls `db.loadExtension(...)` for us, plus `getLoadablePath()`
    // for manual loading. Prefer `load`, fall back to the explicit path.
    const sqliteVec = require("sqlite-vec") as {
      load?: (db: DatabaseType) => void;
      getLoadablePath?: () => string;
      loadable_path?: () => string;
      default?: { load?: (db: DatabaseType) => void; getLoadablePath?: () => string };
    };
    const mod = sqliteVec.default ?? sqliteVec;
    if (typeof mod.load === "function") {
      mod.load(db);
    } else if (typeof sqliteVec.load === "function") {
      sqliteVec.load(db);
    } else {
      const loadablePath = mod.getLoadablePath?.() ?? sqliteVec.getLoadablePath?.();
      if (!loadablePath) {
        throw new Error("sqlite-vec did not expose a loadable extension path");
      }
      db.loadExtension(loadablePath);
    }

    // Confirm the vec0 module is actually registered by probing for a known
    // scalar function. A failed load would have thrown already, but we
    // double-check defensively.
    const row = db.prepare("SELECT vec_version() AS v").get() as { v?: string } | undefined;
    if (!row || typeof row.v !== "string") {
      throw new Error("vec_version() did not return a version string");
    }
    return true;
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    warn?.(
      `sqlite-vec extension could not be loaded; vector search is disabled (FTS-only). Reason: ${reason}`,
    );
    return false;
  }
}

/** Closes the connection, ignoring double-close errors. */
export function closeConnection(conn: KbConnection): void {
  try {
    conn.db.close();
  } catch {
    // ignore — already closed or closing
  }
}

/**
 * Runs a callback against a fresh read-only connection and closes it
 * afterwards. Mirrors the reference system's `withDb` (open → query → close).
 */
export function withReadonlyDb<T>(
  options: Omit<OpenOptions, "readonly">,
  fn: (conn: KbConnection) => T,
): T {
  const conn = openDatabase({ ...options, readonly: true });
  try {
    return fn(conn);
  } finally {
    closeConnection(conn);
  }
}
