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
    embedding?: { enabled?: boolean; dimensions?: number };
  };
}

const DEFAULT_DIMENSIONS = 1536;

export interface WebEmbeddingConfig {
  enabled: boolean;
  dimensions: number;
}

/** Resolves vector enablement and dimensionality from the local config. */
export function loadEmbeddingConfig(): WebEmbeddingConfig {
  const configPath = nodePath.resolve(process.cwd(), ".llm-wiki", "config.json");
  try {
    const raw = nodeFs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as RawKbConfig;
    const embedding = parsed.kb?.embedding;
    return {
      enabled: embedding?.enabled === true,
      dimensions:
        typeof embedding?.dimensions === "number" && embedding.dimensions > 0
          ? embedding.dimensions
          : DEFAULT_DIMENSIONS,
    };
  } catch {
    return { enabled: false, dimensions: DEFAULT_DIMENSIONS };
  }
}

/** Resolves the embedding dimensionality from the local config. */
export function loadDimensions(): number {
  return loadEmbeddingConfig().dimensions;
}
