#!/usr/bin/env node
import { Command } from "commander";
import { makeInitCommand } from "./commands/init.js";
import { makeServeCommand } from "./commands/serve.js";
import { makeIndexCommand } from "./commands/index.js";
import { makeSearchCommand } from "./commands/search.js";
import { makeRelationsCommand } from "./commands/relations.js";
import { logger } from "./utils/logger.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

/**
 * CLI entrypoint. Compiles to `dist/index.js` with a `#!/usr/bin/env node`
 * shebang so the `llm-wiki-cli` bin works directly.
 */

function readVersion(): string {
  // When compiled, package.json sits two levels up from dist/index.js.
  // When run via tsx from src/, it sits three levels up.
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    nodePath.resolve(here, "..", "package.json"), // dist/index.js
    nodePath.resolve(here, "..", "..", "package.json"), // src/index.ts
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

const program = new Command();

program
  .name("llm-wiki-cli")
  .description("Index, search, and serve a local knowledge-base wiki (Next.js + HeroUI).")
  .version(readVersion(), "-v, --version", "Print the llm-wiki-cli version")
  .helpOption("-h, --help", "Show this help message");

program.addCommand(makeInitCommand());
program.addCommand(makeIndexCommand());
program.addCommand(makeSearchCommand());
program.addCommand(makeRelationsCommand());
program.addCommand(makeServeCommand());

// Friendly top-level error handling so we never dump an unhandled rejection.
program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error((err as Error)?.message ?? String(err));
  process.exitCode = 1;
});
