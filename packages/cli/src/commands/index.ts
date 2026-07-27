import { Command } from "commander";
import nodeFs from "node:fs";
import nodePath from "node:path";
import {
  indexFiles,
  readIndexMetadata,
  openDatabase,
  closeConnection,
  type IndexStats,
} from "@llm-wiki/kb";
import { loadConfigFromPath, ConfigError } from "../utils/config.js";
import { resolveKbConfig } from "../utils/kb-config.js";
import { logger } from "../utils/logger.js";
import { resolveGlobalOptions, type RawGlobalOptions } from "../utils/global-options.js";
import { CliError, emitError, ExitCode } from "../utils/errors.js";

/**
 * `llm-wiki-cli index [--reset] [--json] [--source-revision <sha>]
 *                     [--source-branch <name>] [--output-db <path>]
 *                     [--seed-db <previous.db>]`
 *
 * Scans the configured `kb.include` directories, chunks new/changed files,
 * generates embeddings (when sqlite-vec is available), and writes everything
 * to the index DB. Incremental by default; `--reset` wipes first.
 *
 * `--output-db` builds into a throwaway file so an orchestrator can validate
 * it and swap it in atomically, leaving the active index untouched during the
 * build. `--seed-db` copies a previous index first for a faster incremental
 * rebuild of large knowledge bases.
 */
export function makeIndexCommand(): Command {
  const command = new Command("index");

  command
    .description("Index wiki/ content into the local knowledge base (.llm-wiki/index.db)")
    .option("--reset", "Wipe the existing index before re-indexing everything", false)
    .option("--json", "Output a machine-readable result object", false)
    .option("--source-revision <sha>", "Record this revision (e.g. merged commit sha) in index metadata")
    .option("--source-branch <name>", "Record this source branch label in index metadata")
    .option("--output-db <path>", "Build into this DB file instead of the active index")
    .option("--seed-db <path>", "Copy this previous DB before indexing (incremental rebuild)")
    .action((options: IndexOptions, command: Command) => {
      void runIndex(options, command);
    });

  return command;
}

interface IndexOptions {
  reset?: boolean;
  json?: boolean;
  sourceRevision?: string;
  sourceBranch?: string;
  outputDb?: string;
  seedDb?: string;
}

async function runIndex(options: IndexOptions, command: Command): Promise<void> {
  const json = options.json ?? false;
  const startedAt = Date.now();

  const ctx = resolveGlobalOptions(command.optsWithGlobals() as RawGlobalOptions);
  const targetDb =
    options.outputDb && options.outputDb.length > 0
      ? resolveAbsolutePath(options.outputDb)
      : ctx.dbPath;

  let config;
  try {
    config = loadConfigFromPath(ctx.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      emitError(
        new CliError(`CONFIG_${err.code}`, err.message, ExitCode.CONFIG),
        { json },
      );
      return;
    }
    throw err;
  }

  const kbConfig = resolveKbConfig(config);

  // Seed: copy a previous index so this run is an incremental update rather
  // than a full rebuild. The orchestrator owns the previous-DB lifecycle.
  if (options.seedDb && options.seedDb.length > 0) {
    const seedPath = resolveAbsolutePath(options.seedDb);
    try {
      nodeFs.mkdirSync(nodePath.dirname(targetDb), { recursive: true });
      nodeFs.copyFileSync(seedPath, targetDb);
    } catch (err) {
      emitError(
        new CliError(
          "DB_SEED_FAILED",
          `Failed to seed index from ${seedPath}: ${(err as Error).message}`,
          ExitCode.DB,
        ),
        { json },
      );
      return;
    }
  }

  let stats: IndexStats;
  try {
    stats = indexFiles({
      projectRoot: ctx.root,
      dbPath: targetDb,
      config: kbConfig,
      reset: options.reset ?? false,
      sourceRevision: options.sourceRevision,
      sourceBranch: options.sourceBranch,
      onProgress: json ? () => {} : (message) => logger.raw(message),
    });
  } catch (err) {
    emitError(
      new CliError(
        "DB_INDEX_FAILED",
        `Indexing failed: ${(err as Error).message}`,
        ExitCode.DB,
      ),
      { json },
    );
    return;
  }

  // Read back the metadata the indexer just wrote so the JSON result carries
  // the exact provenance snapshot stored in the DB.
  const metadata = readMetadataSafe(targetDb, kbConfig.embedding.enabled);
  const durationMs = Date.now() - startedAt;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          db: targetDb,
          stats,
          metadata,
          durationMs,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  logger.success("Indexing complete");
  logger.info(
    `Scanned ${stats.scanned}  Added ${stats.added}  Updated ${stats.updated}  ` +
      `Skipped ${stats.skipped}  Deleted ${stats.deleted}  Chunks ${stats.chunks}`,
  );
  if (!kbConfig.embedding.enabled) {
    logger.info("Vector indexing is disabled by configuration; FTS indexing is active.");
  } else if (!stats.vectorEnabled) {
    logger.warn("Vector search disabled (sqlite-vec unavailable); only FTS is indexed.");
  }
  if (metadata) {
    const rev = metadata.sourceRevision ? ` ${metadata.sourceRevision}` : "";
    logger.info(`Index${rev} (built ${metadata.builtAt || "unknown"}) → ${targetDb}`);
  }
}

/** Reads index metadata from the freshly built DB, tolerating open failures. */
function readMetadataSafe(
  dbPath: string,
  loadVector: boolean,
): ReturnType<typeof readIndexMetadata> {
  const conn = openDatabase({ dbPath, loadVector, readonly: true });
  try {
    return readIndexMetadata(conn.db);
  } finally {
    closeConnection(conn);
  }
}

function resolveAbsolutePath(value: string): string {
  return nodePath.isAbsolute(value) ? value : nodePath.resolve(process.cwd(), value);
}
