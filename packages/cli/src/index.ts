#!/usr/bin/env node
import { Command, Option } from "commander";
import { makeInitCommand } from "./commands/init.js";
import { makeServeCommand } from "./commands/serve.js";
import { makeIndexCommand } from "./commands/index.js";
import { makeSearchCommand } from "./commands/search.js";
import { makeRelationsCommand } from "./commands/relations.js";
import { makeStatusCommand } from "./commands/status.js";
import { makeValidateCommand } from "./commands/validate.js";
import { makeWorkspaceCommand } from "./commands/workspace.js";
import { logger } from "./utils/logger.js";
import { ExitCode } from "./utils/errors.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

/**
 * CLI entrypoint. Compiles to `dist/index.js` with a `#!/usr/bin/env node`
 * shebang so the `llm-wiki` bin works directly.
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
  .name("llm-wiki")
  .description("Index, search, and serve a local knowledge-base wiki.")
  .version(readVersion(), "-v, --version", "Print the llm-wiki version")
  .helpOption("-h, --help", "Show this help message")
  // Global options, declared on the program and readable from every subcommand
  // via `cmd.optsWithGlobals()`. Each is also bound to an environment variable
  // so an orchestrator can set it once for a whole pipeline run.
  .addOption(new Option("--workspace <id>", "Registered workspace id.").env("LLM_WIKI_WORKSPACE"))
  // `--kb` remains a migration alias for scripts using the pre-V1
  // terminology. New integrations must use --workspace.
  .addOption(new Option("--kb <id>", "Legacy knowledge-base id.").env("LLM_WIKI_KB"))
  .addOption(
    new Option("--root <path>", "Knowledge-base root directory (default: current directory).").env(
      "LLM_WIKI_ROOT",
    ),
  )
  .addOption(
    new Option("--db <path>", "SQLite index file (default: <root>/.llm-wiki/index.db).").env(
      "LLM_WIKI_DB",
    ),
  )
  .addOption(
    new Option("--config <path>", "Config file (default: <root>/.llm-wiki/config.json).").env(
      "LLM_WIKI_CONFIG",
    ),
  );

// Register the exit override BEFORE adding subcommands: commander snapshots
// the program's `_exitCallback` onto each subcommand at addCommand time, so a
// later exitOverride would not reach them. This makes commander throw instead
// of calling process.exit, letting the catch handler below map errors onto the
// stable exit-code protocol.
program.exitOverride();

program.addCommand(makeInitCommand());
program.addCommand(makeIndexCommand());
program.addCommand(makeSearchCommand());
program.addCommand(makeRelationsCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeValidateCommand());
program.addCommand(makeWorkspaceCommand());
program.addCommand(makeServeCommand());

// Propagate the exit override to every subcommand (including nested ones like
// `relations propose`). Commander 15 snapshots `_exitCallback` at addCommand
// time, but factory-created commands need their own override for option-parse
// errors to surface as promise rejections on `parseAsync` rather than being
// swallowed by the subcommand's own (null) callback.
function applyExitOverrideRecursive(cmd: Command): void {
  cmd.exitOverride();
  for (const child of cmd.commands) {
    applyExitOverrideRecursive(child);
  }
}
for (const child of program.commands) {
  applyExitOverrideRecursive(child);
}

// Friendly top-level error handling so we never dump an unhandled rejection.
// - commander's --help / --version are success (exit 0) even though they throw.
// - commander usage/argument errors (bad flag values, missing required args)
//   map to the ARGS exit code (4).
// - a CliError carries its own exit code.
// - anything else is an unexpected failure and falls back to exit 1.
program.parseAsync(process.argv).catch((err: unknown) => {
  const code = (err as { code?: string })?.code;
  // --help / --version are surfaced by commander as throws; treat as success.
  if (
    code === "commander.helpDisplayed" ||
    code === "commander.version" ||
    code === "commander.help"
  ) {
    return;
  }
  logger.error((err as Error)?.message ?? String(err));
  let exitCode: number;
  if (code !== undefined && code.startsWith("commander.")) {
    // Commander usage/argument error (e.g. invalid --limit, unknown option).
    exitCode = ExitCode.ARGS;
  } else if (
    err &&
    typeof err === "object" &&
    "exitCode" in err &&
    typeof (err as { exitCode: number }).exitCode === "number"
  ) {
    exitCode = (err as { exitCode: number }).exitCode;
  } else {
    exitCode = ExitCode.UNKNOWN;
  }
  process.exitCode = exitCode;
});
