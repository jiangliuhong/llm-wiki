import { Command } from "commander";
import { indexFiles } from "@llm-wiki/kb";
import { loadConfig, ConfigError } from "../utils/config.js";
import { resolveKbConfig } from "../utils/kb-config.js";
import { logger } from "../utils/logger.js";

/**
 * `llm-wiki-cli index [--reset]`
 *
 * Scans the configured `kb.include` directories, chunks new/changed files,
 * generates embeddings (when sqlite-vec is available), and writes everything to
 * `.llm-wiki/index.db`. Incremental by default; `--reset` wipes first.
 */
export function makeIndexCommand(): Command {
  const command = new Command("index");

  command
    .description("Index wiki/ content into the local knowledge base (.llm-wiki/index.db)")
    .option("--reset", "Wipe the existing index before re-indexing everything", false)
    .action((options: IndexOptions) => {
      void runIndex(options);
    });

  return command;
}

interface IndexOptions {
  reset?: boolean;
}

async function runIndex(options: IndexOptions): Promise<void> {
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

  const stats = indexFiles({
    config: kbConfig,
    reset: options.reset ?? false,
    onProgress: (message) => logger.raw(message),
  });

  logger.success("Indexing complete");
  logger.info(
    `Scanned ${stats.scanned}  Added ${stats.added}  Updated ${stats.updated}  ` +
      `Skipped ${stats.skipped}  Deleted ${stats.deleted}  Chunks ${stats.chunks}`,
  );
  if (!stats.vectorEnabled) {
    logger.warn("Vector search disabled (sqlite-vec unavailable); only FTS is indexed.");
  }
}
