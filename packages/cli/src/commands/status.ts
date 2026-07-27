import { Command } from "commander";
import nodeFs from "node:fs";
import {
  getKbStats,
  openDatabase,
  closeConnection,
  readIndexMetadata,
  computeConfigHash,
} from "@llm-wiki/kb";
import { loadConfigFromPath, ConfigError } from "../utils/config.js";
import { resolveKbConfig } from "../utils/kb-config.js";
import { logger } from "../utils/logger.js";
import { resolveGlobalOptions, type RawGlobalOptions } from "../utils/global-options.js";
import { CliError, emitError, ExitCode } from "../utils/errors.js";

/**
 * `llm-wiki-cli status [--json] [--target-revision <sha>] [--no-config-check]`
 *
 * Reports the health and provenance of the current index DB. Designed for an
 * orchestrator (pi-agents) that needs to decide whether a rebuild is
 * necessary: it compares the stored `sourceRevision` against an expected
 * target revision, and the stored `configHash` against the hash of the current
 * config.
 *
 * A missing DB is a legitimate state (not an error): exit 0 with
 * `exists: false` so the caller can trigger a first-time build.
 */
export function makeStatusCommand(): Command {
  const command = new Command("status");

  command
    .description("Report index health, provenance, and whether a rebuild is needed")
    .option("--json", "Output a machine-readable status object", false)
    .option("--target-revision <sha>", "Expected source revision to compare against the index")
    .option(
      "--no-config-check",
      "Skip comparing the current config hash against the stored index",
    )
    .action((options: StatusOptions, cmd: Command) => {
      runStatus(options, cmd);
    });

  return command;
}

interface StatusOptions {
  json?: boolean;
  targetRevision?: string;
  configCheck: boolean;
}

function runStatus(options: StatusOptions, cmd: Command): void {
  const json = options.json ?? false;
  const ctx = resolveGlobalOptions(cmd.optsWithGlobals() as RawGlobalOptions);

  let config;
  try {
    config = loadConfigFromPath(ctx.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      emitError(new CliError(`CONFIG_${err.code}`, err.message, ExitCode.CONFIG), { json });
      return;
    }
    throw err;
  }
  const kbConfig = resolveKbConfig(config);

  // Missing DB: legitimate state, not an error.
  if (!nodeFs.existsSync(ctx.dbPath)) {
    const payload = { ok: false, reason: "db_missing", db: ctx.dbPath, exists: false };
    if (json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return;
    }
    logger.info(`No index at ${ctx.dbPath}.`);
    logger.info(`Run "llm-wiki-cli index" to build one.`);
    return;
  }

  let stats: ReturnType<typeof getKbStats>;
  let metadata: ReturnType<typeof readIndexMetadata>;
  try {
    const conn = openDatabase({
      dbPath: ctx.dbPath,
      projectRoot: ctx.root,
      loadVector: kbConfig.embedding.enabled,
      readonly: true,
    });
    try {
      stats = getKbStats({ dbPath: ctx.dbPath, projectRoot: ctx.root });
      metadata = readIndexMetadata(conn.db);
    } finally {
      closeConnection(conn);
    }
  } catch (err) {
    emitError(
      new CliError("DB_OPEN_FAILED", (err as Error).message, ExitCode.DB),
      { json },
    );
    return;
  }

  const mismatches: string[] = [];
  // Revision check is only meaningful when the caller supplies a target.
  const hasTargetRevision =
    options.targetRevision !== undefined && options.targetRevision.length > 0;
  const upToDate = hasTargetRevision
    ? (metadata?.sourceRevision ?? "") === options.targetRevision
    : true;
  if (hasTargetRevision && !upToDate) mismatches.push("sourceRevision");

  // Config drift check: compare the hash of the current config against what
  // the index was built with. Disabled with --no-config-check.
  const currentHash = options.configCheck ? computeConfigHash(kbConfig) : null;
  const configMatches = options.configCheck
    ? (metadata?.configHash ?? "") === (currentHash ?? "")
    : true;
  if (options.configCheck && !configMatches) mismatches.push("configHash");

  const payload = {
    ok: true,
    db: ctx.dbPath,
    exists: true,
    metadata,
    stats: {
      files: stats.files,
      chunks: stats.chunks,
      ftsRecords: stats.ftsRecords,
      vectorRecords: stats.vectorRecords,
      tablesOk: stats.tablesOk,
      vectorEnabled: stats.vectorEnabled,
      latestIndexedAt: stats.latestIndexedAt,
    },
    upToDate,
    configMatches,
    mismatches,
  };

  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  logger.success(`Index: ${ctx.dbPath}`);
  if (metadata) {
    logger.info(`  source revision: ${metadata.sourceRevision || "(none)"}`);
    logger.info(`  source branch:   ${metadata.sourceBranch || "(none)"}`);
    logger.info(`  built at:        ${metadata.builtAt || "(unknown)"}`);
    logger.info(`  schema version:  ${metadata.schemaVersion}`);
    logger.info(`  config hash:     ${metadata.configHash.slice(0, 12) || "(none)"}`);
  } else {
    logger.warn("  no provenance metadata recorded (older index).");
  }
  logger.info(
    `  files: ${stats.files}  chunks: ${stats.chunks}  fts: ${stats.ftsRecords}` +
      `  vectors: ${stats.vectorRecords}`,
  );
  if (mismatches.length > 0) {
    logger.warn(`  out of date: ${mismatches.join(", ")}`);
    logger.warn(`  consider running "llm-wiki-cli index" to rebuild.`);
  } else {
    logger.success("  index is up to date.");
  }
}
