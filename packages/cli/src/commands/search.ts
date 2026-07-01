import { Command } from "commander";
import { searchKnowledgeBase } from "@llm-wiki/kb";
import { loadConfig, ConfigError } from "../utils/config.js";
import { resolveKbConfig } from "../utils/kb-config.js";
import { logger } from "../utils/logger.js";

/**
 * `llm-wiki-cli search <query> [--limit 8] [--json]`
 *
 * Runs a hybrid (vector + FTS) search against the local knowledge base and
 * prints results to the terminal. `--json` emits a machine-readable result.
 */
export function makeSearchCommand(): Command {
  const command = new Command("search");

  command
    .description("Search the local knowledge base")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results", (value: string) => parseLimit(value), 8)
    .option("--json", "Output results as JSON", false)
    .action((query: string, options: SearchOptions) => {
      void runSearch(query, options);
    });

  return command;
}

interface SearchOptions {
  limit: number;
  json?: boolean;
}

async function runSearch(query: string, options: SearchOptions): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const kbConfig = resolveKbConfig(config);
  const result = searchKnowledgeBase(query, {
    dimensions: kbConfig.embedding.dimensions,
    limit: options.limit,
  });

  if (options.json) {
    // Raw JSON to stdout (no logger decoration) for piping.
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (result.warning) {
    logger.warn(result.warning);
  }
  if (!result.vectorEnabled) {
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
}

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit "${value}". Expected a positive integer.`);
  }
  return parsed;
}
