import { Command } from "commander";
import { ConfigError, loadConfigFromPath } from "../utils/config.js";
import type { WikiConfig } from "../types/config.js";
import { startNextServer } from "../services/next-server.js";
import { logger } from "../utils/logger.js";
import { closeConnection, initSchema, openDatabase } from "@llm-wiki/kb";
import { resolveKbConfig } from "../utils/kb-config.js";
import { resolveGlobalOptions, type RawGlobalOptions } from "../utils/global-options.js";
import { getRegistryPath, loadRegistry } from "../utils/registry.js";

/**
 * `llm-wiki-cli serve`
 *
 * Loads `.llm-wiki/config.json` and boots the bundled Next.js app in-process
 * (no shell, no child_process).
 */
export function makeServeCommand(): Command {
  const command = new Command("serve");

  command
    .description("Serve the LLLM Wiki web app locally")
    .option("-p, --port <port>", "Override the port from .llm-wiki/config.json", (value: string) =>
      parsePort(value),
    )
    .option("--prod", "Run the built app instead of dev mode", false)
    .option("--all", "Serve every registered knowledge base", false)
    .action(async (options: ServeOptions, cmd: Command) => {
      await runServe(options, cmd);
    });

  return command;
}

interface ServeOptions {
  port?: number;
  prod?: boolean;
  all?: boolean;
}

async function runServe(options: ServeOptions, cmd: Command): Promise<void> {
  if (options.all) {
    await runServeAll(options);
    return;
  }
  const ctx = resolveGlobalOptions(cmd.optsWithGlobals() as RawGlobalOptions);
  let config: WikiConfig;
  try {
    config = loadConfigFromPath(ctx.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err; // Unexpected — let it bubble.
  }

  // CLI override takes precedence over the config file.
  if (options.port !== undefined) {
    config = { ...config, port: options.port };
  }

  try {
    migrateKbSchema(config, ctx.root, ctx.dbPath);
    await startNextServer({
      config,
      context: ctx,
      knowledgeBases: [{ config, context: ctx }],
      dev: !options.prod,
    });
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  }
}

async function runServeAll(options: ServeOptions): Promise<void> {
  const registry = loadRegistry();
  const entries = Object.entries(registry.knowledgeBases);
  if (entries.length === 0) {
    logger.error('No registered knowledge bases. Run "llm-wiki-cli kb add <id> <root>" first.');
    process.exitCode = 1;
    return;
  }
  const knowledgeBases = entries.map(([kbId, entry]) => {
    const config = loadConfigFromPath(entry.configPath);
    const context = {
      kbId,
      root: entry.root,
      configPath: entry.configPath,
      dbPath: entry.dbPath,
    };
    migrateKbSchema(config, context.root, context.dbPath);
    return { config, context };
  });
  const primary =
    knowledgeBases.find((item) => item.context.kbId === registry.defaultKb) ?? knowledgeBases[0];
  if (!primary) return;
  const config =
    options.port === undefined ? primary.config : { ...primary.config, port: options.port };
  await startNextServer({
    config,
    context: primary.context,
    knowledgeBases,
    registryPath: getRegistryPath(),
    dev: !options.prod,
  });
}

/** Applies additive base-schema migrations before the read-only Web app starts. */
export function migrateKbSchema(
  config: WikiConfig,
  projectRoot: string = process.cwd(),
  dbPath?: string,
): void {
  const kb = resolveKbConfig(config);
  const conn = openDatabase({ projectRoot, dbPath, loadVector: false });
  try {
    initSchema(conn, kb.embedding.dimensions);
  } finally {
    closeConnection(conn);
  }
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port "${value}". Expected an integer between 0 and 65535.`);
  }
  return parsed;
}
