import { Command, InvalidArgumentError } from "commander";
import nodeFs from "node:fs";
import {
  MAX_SEARCH_LIMIT,
  searchKnowledgeBase,
  openDatabase,
  closeConnection,
  readIndexMetadata,
} from "@llm-wiki/kb";
import { loadConfigFromPath, ConfigError } from "../utils/config.js";
import { resolveKbConfig } from "../utils/kb-config.js";
import { logger } from "../utils/logger.js";
import { resolveGlobalOptions, type RawGlobalOptions } from "../utils/global-options.js";
import { CliError, emitError, ExitCode } from "../utils/errors.js";

/**
 * `llm-wiki search <query> [--limit 8] [--json] [--graph] [--read-only]`
 *
 * Runs a hybrid (vector + FTS) search against the local knowledge base and
 * prints results to the terminal. `--json` emits a machine-readable result.
 *
 * `--read-only` guarantees the command never creates or migrates the DB. When
 * the DB does not yet exist under `--read-only`, the command returns an empty
 * result (exit 0) instead of erroring — useful for orchestrators that probe
 * an index before it has been built.
 */
export function makeSearchCommand(): Command {
  const command = new Command("search");

  command
    .description("Search the local knowledge base")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results", (value: string) => parseLimit(value), 8)
    .option("--json", "Output results as JSON", false)
    .option("--graph", "Expand results through approved one-hop document relations", false)
    .option(
      "--read-only",
      "Never create/migrate the DB; return empty results when it is missing",
      false,
    )
    .action((query: string, options: SearchOptions, cmd: Command) => {
      void runSearch(query, options, cmd);
    });

  return command;
}

interface SearchOptions {
  limit: number;
  json?: boolean;
  graph?: boolean;
  readOnly?: boolean;
}

async function runSearch(query: string, options: SearchOptions, cmd: Command): Promise<void> {
  const json = options.json ?? false;
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    emitError(new CliError("ARGS_EMPTY_QUERY", "Search query must not be empty.", ExitCode.ARGS), {
      json,
    });
    return;
  }

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

  // Read-only + missing DB ⇒ empty result, not an error. This lets an
  // orchestrator run search before the first index without special-casing.
  if (options.readOnly && !nodeFs.existsSync(ctx.dbPath)) {
    const empty = {
      query: normalizedQuery,
      limit: options.limit,
      hits: [],
      vectorEnabled: false,
      index: null,
    };
    if (json) {
      process.stdout.write(JSON.stringify(empty, null, 2) + "\n");
      return;
    }
    logger.info(`No index at ${ctx.dbPath}; returning no results for "${query}".`);
    return;
  }

  let result;
  try {
    result = searchKnowledgeBase(normalizedQuery, {
      projectRoot: ctx.root,
      dbPath: ctx.dbPath,
      dimensions: kbConfig.embedding.dimensions,
      enableVector: kbConfig.embedding.enabled,
      limit: options.limit,
      graph: options.graph ?? false,
    });
  } catch (err) {
    emitError(new CliError("DB_QUERY_FAILED", (err as Error).message, ExitCode.DB), { json });
    return;
  }

  // Attach the index provenance snapshot so answers can cite which commit the
  // knowledge came from. Read on a short-lived read-only connection.
  result.index = readIndexMetadataSafe(ctx.dbPath, kbConfig.embedding.enabled);

  if (json) {
    // Raw JSON to stdout (no logger decoration) for piping.
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (result.warning) {
    logger.warn(result.warning);
  }
  if (kbConfig.embedding.enabled && !result.vectorEnabled) {
    logger.warn("Vector search disabled (sqlite-vec unavailable); showing FTS results only.");
  }

  if (result.hits.length === 0) {
    logger.info(`No results for "${query}".`);
    return;
  }

  logger.info(`Found ${result.hits.length} result(s) for "${query}":`);
  for (const hit of result.hits) {
    logger.raw("");
    logger.success(`${hit.path}:${hit.startLine}-${hit.endLine}  [${hit.source}]`);
    logger.raw(`  ${hit.preview}`);
    if (hit.distance !== undefined) {
      logger.raw(`  distance: ${hit.distance.toFixed(4)}`);
    }
    if (hit.bm25 !== undefined) {
      logger.raw(`  bm25: ${hit.bm25.toFixed(4)}`);
    }
  }
  if (result.graphContext?.length) {
    logger.info("Related documents:");
    for (const related of result.graphContext) {
      logger.raw(
        `  ${related.seedPath} --${related.relationType} (${related.direction})--> ${related.relatedPath}`,
      );
    }
  }
  if (result.index) {
    const rev = result.index.sourceRevision ? ` ${result.index.sourceRevision}` : "";
    logger.info(`Index${rev} (built ${result.index.builtAt || "unknown"})`);
  }
}

/** Reads index metadata on a short-lived read-only connection. */
function readIndexMetadataSafe(
  dbPath: string,
  loadVector: boolean,
): ReturnType<typeof readIndexMetadata> {
  if (!nodeFs.existsSync(dbPath)) return null;
  const conn = openDatabase({ dbPath, loadVector, readonly: true });
  try {
    return readIndexMetadata(conn.db);
  } finally {
    closeConnection(conn);
  }
}

function parseLimit(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError(
      `Invalid limit "${value}". Expected an integer between 1 and ${MAX_SEARCH_LIMIT}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SEARCH_LIMIT) {
    throw new InvalidArgumentError(
      `Invalid limit "${value}". Expected an integer between 1 and ${MAX_SEARCH_LIMIT}.`,
    );
  }
  return parsed;
}
