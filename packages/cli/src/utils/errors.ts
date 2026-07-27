import { logger } from "./logger.js";

/**
 * Stable error protocol for machine consumers (pi-agents).
 *
 * Historically the CLI only distinguished success (0) from failure (1) and
 * emitted human-readable text on stderr. An orchestrator driving
 * "index → validate → swap" needs to tell *why* a run failed without parsing
 * logs. We therefore:
 *
 *   - Reserve a small, stable set of exit codes (see {@link ExitCode}).
 *   - When a command is invoked with `--json`, write a structured
 *     `{ "error": { "code", "message" } }` object to stderr (the success body
 *     still goes to stdout, so `2>` parsing is enough to detect failure).
 *
 * The codes are intentionally coarse: a handful of categories is enough for
 * branching, and finer-grained detail lives in `message`/`code` strings that
 * callers may surface to humans but should not branch on.
 */

/** Stable process exit codes. Keep in sync with docs/cli-usage.md. */
export const ExitCode = {
  /** Success. */
  OK: 0,
  /** Unexpected/internal error (backwards-compatible default). */
  UNKNOWN: 1,
  /** Configuration problem: missing file, invalid JSON, failed validation. */
  CONFIG: 2,
  /** Database/index problem: cannot open, corrupt, busy, schema mismatch. */
  DB: 3,
  /** Argument problem: bad flag value, empty query, out-of-range limit. */
  ARGS: 4,
} as const;

/** A typed CLI error carrying a stable exit code and machine-readable code. */
export class CliError extends Error {
  /** Machine-readable error code (e.g. `CONFIG_ENOENT`, `DB_OPEN_FAILED`). */
  readonly code: string;
  /** Stable exit code to set on `process.exitCode`. */
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number = ExitCode.UNKNOWN) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface EmitOptions {
  /** When true, emit a structured JSON error object to stderr. */
  json?: boolean;
}

/**
 * Emits an error (human or JSON form) and sets `process.exitCode`. Does not
 * throw or force-exit, letting the process drain naturally — consistent with
 * the existing CLI convention of never calling `process.exit()`.
 */
export function emitError(error: CliError, opts: EmitOptions = {}): void {
  if (opts.json) {
    process.stderr.write(
      JSON.stringify({ error: { code: error.code, message: error.message } }) + "\n",
    );
  } else {
    logger.error(error.message);
  }
  process.exitCode = error.exitCode;
}
