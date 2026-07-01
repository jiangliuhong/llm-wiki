import { Command } from "commander";
import { ConfigError, loadConfig } from "../utils/config.js";
import type { WikiConfig } from "../types/config.js";
import { startNextServer } from "../services/next-server.js";
import { logger } from "../utils/logger.js";

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
    .action(async (options: ServeOptions) => {
      await runServe(options);
    });

  return command;
}

interface ServeOptions {
  port?: number;
  prod?: boolean;
}

async function runServe(options: ServeOptions): Promise<void> {
  let config: WikiConfig;
  try {
    config = loadConfig();
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
    await startNextServer({ config, dev: !options.prod });
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  }
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port "${value}". Expected an integer between 0 and 65535.`);
  }
  return parsed;
}
