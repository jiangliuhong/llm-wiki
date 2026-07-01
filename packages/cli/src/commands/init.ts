import { Command } from "commander";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { getDefaultConfig, saveConfig, hasConfig } from "../utils/config.js";
import { getConfigPath } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

/**
 * `llm-wiki-cli init`
 *
 * Scaffolds a fresh Wiki project in the current working directory:
 *   - creates `.llm-wiki/`
 *   - writes `.llm-wiki/config.json` with the default config (incl. `kb`)
 *   - creates a `wiki/` content directory with a placeholder file
 *   - refuses to clobber an existing config
 *
 * Returns the program so it can be composed by `index.ts`.
 */
export function makeInitCommand(): Command {
  const command = new Command("init");

  command
    .description("Initialize a new LLLM Wiki project in the current directory")
    .option(
      "--title <title>",
      "Wiki title written to .llm-wiki/config.json",
      getDefaultConfig().title,
    )
    .option(
      "--port <port>",
      "Port written to .llm-wiki/config.json",
      (value: string) => parsePort(value),
      getDefaultConfig().port,
    )
    .action((options: InitOptions) => {
      runInit(options);
    });

  return command;
}

interface InitOptions {
  title: string;
  port: number;
}

function runInit(options: InitOptions): void {
  if (hasConfig()) {
    logger.warn(
      `A config already exists at ${getConfigPath()}.\n` +
        `Remove it first if you want to reinitialize.`,
    );
    return;
  }

  const config = { title: options.title, port: options.port, kb: getDefaultConfig().kb };
  saveConfig(config);

  // Create a wiki/ content directory so `index` has something to chew on
  // immediately. Only create if missing — never clobber existing content.
  createContentDir();

  logger.success(`Wiki initialized successfully`);
  logger.info(`Created ${getConfigPath()}`);
  logger.info(`Title: "${config.title}"  Port: ${config.port}`);
  logger.info(`Next: add files to wiki/ and run "llm-wiki-cli index".`);
}

/** Creates the default `wiki/` dir with a placeholder Markdown file. */
function createContentDir(): void {
  const wikiDir = nodePath.resolve(process.cwd(), "wiki");
  if (nodeFs.existsSync(wikiDir)) {
    return;
  }
  nodeFs.mkdirSync(wikiDir, { recursive: true });
  const placeholder = nodePath.join(wikiDir, "welcome.md");
  nodeFs.writeFileSync(
    placeholder,
    [
      `# Welcome to your wiki`,
      ``,
      `This directory is scanned by \`llm-wiki-cli index\`. Replace this file`,
      `with your own Markdown, code, or text files and re-index to make them`,
      `searchable from the web UI.`,
      ``,
    ].join("\n"),
    "utf8",
  );
  logger.info(`Created ${nodePath.relative(process.cwd(), placeholder) || placeholder}`);
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port "${value}". Expected an integer between 0 and 65535.`);
  }
  return parsed;
}
