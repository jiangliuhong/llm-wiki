import nodeFs from "node:fs";
import nodePath from "node:path";
import { DEFAULT_CONFIG, type WikiConfig } from "../types/config.js";
import { getConfigPath, getWikiDir, configExists } from "./paths.js";

/**
 * Config management for `.llm-wiki/config.json`.
 *
 * `loadConfig` / `saveConfig` are the only functions commands need to touch.
 * Both are strict: invalid JSON or a shape that doesn't match {@link WikiConfig}
 * throws a typed {@link ConfigError}, which commands surface to the user.
 */

/** Error thrown when a config file cannot be read or fails validation. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code: "ENOENT" | "EJSON" | "ESHAPE",
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Ensures a plain object parsed from JSON matches {@link WikiConfig}.
 * Throws {@link ConfigError} (code `ESHAPE`) on any mismatch.
 *
 * `kb` is optional: when absent the config is valid (defaults are filled in by
 * {@link loadConfig}); when present it must itself be a valid kb config.
 */
function assertWikiConfig(value: unknown): asserts value is WikiConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("Config must be a JSON object.", "ESHAPE");
  }

  const record = value as Record<string, unknown>;
  const { title, port, kb } = record;

  if (typeof title !== "string" || title.trim().length === 0) {
    throw new ConfigError(`Invalid config: "title" must be a non-empty string.`, "ESHAPE");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(
      `Invalid config: "port" must be an integer between 0 and 65535.`,
      "ESHAPE",
    );
  }
  if (kb !== undefined) {
    assertKb(kb);
  }
}

/** Validates the optional `kb` sub-config. */
function assertKb(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`Invalid config: "kb" must be an object.`, "ESHAPE");
  }
  const kb = value as Record<string, unknown>;

  if (kb.include !== undefined) assertStringArray(kb.include, "kb.include");
  if (kb.exclude !== undefined) assertStringArray(kb.exclude, "kb.exclude");

  if (kb.chunk !== undefined) {
    if (typeof kb.chunk !== "object" || kb.chunk === null) {
      throw new ConfigError(`Invalid config: "kb.chunk" must be an object.`, "ESHAPE");
    }
    const chunk = kb.chunk as Record<string, unknown>;
    if (chunk.maxChars !== undefined) assertPositiveInt(chunk.maxChars, "kb.chunk.maxChars");
    if (chunk.overlap !== undefined) assertNonNegInt(chunk.overlap, "kb.chunk.overlap");
  }

  if (kb.embedding !== undefined) {
    if (typeof kb.embedding !== "object" || kb.embedding === null) {
      throw new ConfigError(`Invalid config: "kb.embedding" must be an object.`, "ESHAPE");
    }
    const embedding = kb.embedding as Record<string, unknown>;
    if (embedding.enabled !== undefined && typeof embedding.enabled !== "boolean") {
      throw new ConfigError(
        `Invalid config: "kb.embedding.enabled" must be a boolean.`,
        "ESHAPE",
      );
    }
    if (embedding.dimensions !== undefined) {
      assertPositiveInt(embedding.dimensions, "kb.embedding.dimensions");
    }
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`Invalid config: "${field}" must be an array of strings.`, "ESHAPE");
  }
}

function assertPositiveInt(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`Invalid config: "${field}" must be a positive integer.`, "ESHAPE");
  }
}

function assertNonNegInt(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`Invalid config: "${field}" must be a non-negative integer.`, "ESHAPE");
  }
}

/**
 * Loads and validates the wiki config from the current working directory.
 *
 * @param cwd Working directory to resolve `.llm-wiki/config.json` from.
 * @returns The validated {@link WikiConfig}.
 * @throws {ConfigError} If the file is missing, malformed, or invalid.
 */
export function loadConfig(cwd?: string): WikiConfig {
  return loadConfigFromPath(getConfigPath(cwd));
}

/**
 * Loads and validates the wiki config from an explicit file path.
 *
 * Used by commands that honor the global `--config` / `LLM_WIKI_CONFIG`
 * option, decoupling the config location from the project root.
 *
 * @param configPath Absolute path to a `config.json` file.
 * @returns The validated {@link WikiConfig}.
 * @throws {ConfigError} If the file is missing, malformed, or invalid.
 */
export function loadConfigFromPath(configPath: string): WikiConfig {
  if (!nodeFs.existsSync(configPath)) {
    throw new ConfigError(
      `Config file not found at ${configPath}.\n` + `Run "llm-wiki-cli init" first to create one.`,
      "ENOENT",
    );
  }

  let raw: string;
  try {
    raw = nodeFs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Failed to read config at ${configPath}: ${(err as Error).message}`,
      "ENOENT",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${(err as Error).message}`, "EJSON");
  }

  assertWikiConfig(parsed);
  // Fill in any missing `kb` fields with defaults so downstream code never has
  // to handle undefined sub-config. Older configs (title/port only) are still
  // valid and get a full default `kb`.
  return {
    title: parsed.title,
    port: parsed.port,
    kb: mergeKb(parsed.kb),
  };
}

/** Merges a (possibly partial) kb config over the defaults from DEFAULT_CONFIG. */
function mergeKb(partial: WikiConfig["kb"]): NonNullable<WikiConfig["kb"]> {
  const base = DEFAULT_CONFIG.kb;
  if (!base) {
    // Should never happen (DEFAULT_CONFIG.kb is always defined), but keep the
    // type checker happy.
    throw new ConfigError("Default kb config is missing.", "ESHAPE");
  }
  if (!partial) {
    return structuredClone(base);
  }
  return {
    include: partial.include && partial.include.length > 0 ? [...partial.include] : [...base.include],
    exclude: partial.exclude && partial.exclude.length > 0 ? [...partial.exclude] : [...base.exclude],
    chunk: {
      maxChars: partial.chunk?.maxChars ?? base.chunk.maxChars,
      overlap: partial.chunk?.overlap ?? base.chunk.overlap,
    },
    embedding: {
      enabled: partial.embedding?.enabled ?? base.embedding.enabled,
      dimensions: partial.embedding?.dimensions ?? base.embedding.dimensions,
    },
  };
}

/**
 * Writes a validated {@link WikiConfig} to `.llm-wiki/config.json`,
 * creating the directory if needed.
 *
 * @param config The config to persist.
 * @param cwd Working directory to resolve `.llm-wiki/` from.
 */
export function saveConfig(config: WikiConfig, cwd?: string): void {
  assertWikiConfig(config);

  const wikiDir = getWikiDir(cwd);
  nodeFs.mkdirSync(wikiDir, { recursive: true });

  const configPath = getConfigPath(cwd);
  nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Convenience for the `init` command: returns the default config.
 * Exposed separately so the default stays in one place (`types/config.ts`).
 */
export function getDefaultConfig(): WikiConfig {
  // Deep clone so callers can't mutate the shared DEFAULT_CONFIG.
  return structuredClone(DEFAULT_CONFIG);
}

/** True if a config file exists for the given (or current) working directory. */
export function hasConfig(cwd?: string): boolean {
  return configExists(cwd);
}

/** Join two path segments while staying platform-correct. Exported for tests. */
export function joinPath(...segments: string[]): string {
  return nodePath.join(...segments);
}
