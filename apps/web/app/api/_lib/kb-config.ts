import nodeFs from "node:fs";
import nodePath from "node:path";

/**
 * Server-only helper to read embedding dimensions from `.llm-wiki/config.json`.
 *
 * The web app does NOT depend on `@llm-wiki/cli` (the CLI locates the web app
 * by path, not the reverse). Instead it reads the same config file the CLI
 * writes, in the current working directory — which, when `serve` runs the CLI,
 * is the project root containing `.llm-wiki/`.
 */

interface RawKbConfig {
  kb?: {
    embedding?: { dimensions?: number };
  };
}

const DEFAULT_DIMENSIONS = 1536;

/** Resolves the embedding dimensionality from the local config. */
export function loadDimensions(): number {
  const configPath = nodePath.resolve(process.cwd(), ".llm-wiki", "config.json");
  try {
    const raw = nodeFs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as RawKbConfig;
    const dims = parsed.kb?.embedding?.dimensions;
    return typeof dims === "number" && dims > 0 ? dims : DEFAULT_DIMENSIONS;
  } catch {
    return DEFAULT_DIMENSIONS;
  }
}
