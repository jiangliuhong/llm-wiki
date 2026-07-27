import { Command } from "commander";
import {
  openDatabase,
  closeConnection,
  readIndexMetadata,
  EXPECTED_SCHEMA_VERSION,
  TABLE_NAMES,
  type KbConnection,
} from "@llm-wiki/kb";
import { logger } from "../utils/logger.js";
import { ExitCode } from "../utils/errors.js";

/**
 * `llm-wiki-cli validate --db <path> [--json]`
 *
 * Checks a candidate index DB for integrity before an orchestrator swaps it
 * in as the active index. Runs `PRAGMA integrity_check`, verifies the
 * required tables exist, confirms the schema version matches what the current
 * code expects, and reports row counts.
 *
 * `--db` is required: validate always inspects an explicit file (typically a
 * `--output-db` from a just-finished index run) rather than the active index.
 *
 * Exits non-zero (DB, code 3) when any check fails so a caller can gate the
 * atomic swap on a clean validate.
 */
export function makeValidateCommand(): Command {
  const command = new Command("validate");

  command
    .description("Validate a candidate index DB before swapping it in")
    .option("--json", "Output a machine-readable result object", false)
    .action((options: ValidateOptions, cmd: Command) => {
      runValidate(options, cmd);
    });

  return command;
}

interface ValidateOptions {
  json?: boolean;
}

interface ValidateChecks {
  integrity: { ok: boolean; detail: string };
  tables: { ok: boolean; missing: string[] };
  schemaVersion: { ok: boolean; actual: number; expected: number };
  rowStats: { files: number; chunks: number; ftsRecords: number };
}

function runValidate(options: ValidateOptions, cmd: Command): void {
  const json = options.json ?? false;
  // --db is the global option (shared with the rest of the CLI); validate
  // always inspects an explicit DB rather than the active index, so we require
  // it and emit a structured JSON error when missing.
  const dbPath = cmd.optsWithGlobals().db as string | undefined;
  if (!dbPath || dbPath.length === 0) {
    process.stderr.write(
      JSON.stringify({
        error: { code: "ARGS_DB_REQUIRED", message: "validate requires --db <path>" },
      }) + "\n",
    );
    process.exitCode = 4; // EXIT_ARGS
    return;
  }

  let conn: KbConnection | null = null;
  const checks: ValidateChecks = {
    integrity: { ok: false, detail: "not run" },
    tables: { ok: false, missing: [] },
    schemaVersion: { ok: false, actual: 0, expected: EXPECTED_SCHEMA_VERSION },
    rowStats: { files: 0, chunks: 0, ftsRecords: 0 },
  };

  try {
    conn = openDatabase({ dbPath, loadVector: false, readonly: true });
    const db = conn.db;

    // 1. integrity_check — SQLite's built-in physical consistency probe.
    const integrityRow = db.pragma("integrity_check", { simple: true }) as string | string[];
    const detail = Array.isArray(integrityRow) ? integrityRow.join("; ") : String(integrityRow);
    checks.integrity = { ok: detail === "ok", detail };

    // 2. Required base tables.
    const missing: string[] = [];
    for (const name of [TABLE_NAMES.files, TABLE_NAMES.chunks, TABLE_NAMES.fts]) {
      if (!tableExists(db, name)) missing.push(name);
    }
    checks.tables = { ok: missing.length === 0, missing };

    // 3. Schema version vs. what the current code expects.
    const metadata = readIndexMetadata(db);
    const actualVersion = metadata?.schemaVersion ?? 0;
    checks.schemaVersion = {
      ok: actualVersion === EXPECTED_SCHEMA_VERSION,
      actual: actualVersion,
      expected: EXPECTED_SCHEMA_VERSION,
    };

    // 4. Row counts (only meaningful when tables exist).
    checks.rowStats = {
      files: countRows(db, TABLE_NAMES.files),
      chunks: countRows(db, TABLE_NAMES.chunks),
      ftsRecords: countRows(db, TABLE_NAMES.fts),
    };
  } catch (err) {
    if (conn) closeConnection(conn);
    const message = `Validation failed: ${(err as Error).message}`;
    if (json) {
      // Still emit the partial checks so the caller can see how far we got.
      process.stderr.write(JSON.stringify({ error: { code: "DB_VALIDATE_FAILED", message } }) + "\n");
      process.stdout.write(JSON.stringify({ ok: false, db: dbPath, checks }, null, 2) + "\n");
    } else {
      logger.error(message);
    }
    process.exitCode = ExitCode.DB;
    return;
  }
  closeConnection(conn);

  const ok = checks.integrity.ok && checks.tables.ok && checks.schemaVersion.ok;
  const payload = { ok, db: dbPath, checks };

  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (ok) {
    logger.success(`Valid: ${dbPath}`);
    logger.info(`  integrity: ok`);
    logger.info(
      `  schema version: ${checks.schemaVersion.actual} (expected ${checks.schemaVersion.expected})`,
    );
    logger.info(
      `  rows: files=${checks.rowStats.files} chunks=${checks.rowStats.chunks} fts=${checks.rowStats.ftsRecords}`,
    );
  } else {
    logger.error(`Invalid: ${dbPath}`);
    if (!checks.integrity.ok) logger.error(`  integrity: ${checks.integrity.detail}`);
    if (!checks.tables.ok) logger.error(`  missing tables: ${checks.tables.missing.join(", ")}`);
    if (!checks.schemaVersion.ok)
      logger.error(
        `  schema version: got ${checks.schemaVersion.actual}, expected ${checks.schemaVersion.expected}`,
      );
  }

  if (!ok) {
    process.exitCode = ExitCode.DB;
  }
}

function tableExists(db: KbConnection["db"], name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function countRows(db: KbConnection["db"], table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
