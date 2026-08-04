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
  title?: string;
  kb?: {
    embedding?: { enabled?: boolean; dimensions?: number };
  };
}

const DEFAULT_DIMENSIONS = 1536;

export interface WebEmbeddingConfig {
  enabled: boolean;
  dimensions: number;
}

export interface WebKbContext extends WebEmbeddingConfig {
  id: string;
  title: string;
  root: string;
  dbPath: string;
  configPath: string;
}

export interface ServeManifestEntry {
  id: string;
  title: string;
  root: string;
  configPath: string;
  dbPath: string;
  embedding: WebEmbeddingConfig;
}

export interface ServeManifest {
  version: 1;
  defaultKb: string;
  registryPath?: string;
  knowledgeBases: ServeManifestEntry[];
}

/** Resolves vector enablement and dimensionality from the local config. */
export function loadEmbeddingConfig(): WebEmbeddingConfig {
  const context = loadKbContext();
  return { enabled: context.enabled, dimensions: context.dimensions };
}

/** Resolves the single knowledge base selected by the CLI serve command. */
export function loadKbContext(kbId?: string): WebKbContext {
  const manifest = loadServeManifest();
  if (manifest) {
    const selectedId = kbId ?? manifest.defaultKb;
    const selected = manifest.knowledgeBases.find((item) => item.id === selectedId);
    if (!selected) throw new Error(`Unknown knowledge base "${selectedId}".`);
    return { ...selected, ...selected.embedding };
  }
  const root = process.env.LLM_WIKI_ROOT
    ? nodePath.resolve(process.env.LLM_WIKI_ROOT)
    : process.cwd();
  const configPath = process.env.LLM_WIKI_CONFIG
    ? nodePath.resolve(process.env.LLM_WIKI_CONFIG)
    : nodePath.resolve(root, ".llm-wiki", "config.json");
  const dbPath = process.env.LLM_WIKI_DB
    ? nodePath.resolve(process.env.LLM_WIKI_DB)
    : nodePath.resolve(root, ".llm-wiki", "index.db");
  try {
    const raw = nodeFs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as RawKbConfig;
    const embedding = parsed.kb?.embedding;
    return {
      id: process.env.LLM_WIKI_KB_ID ?? "default",
      title: parsed.title ?? process.env.WIKI_TITLE ?? "LLM Wiki",
      root,
      configPath,
      dbPath,
      enabled: embedding?.enabled === true,
      dimensions:
        typeof embedding?.dimensions === "number" && embedding.dimensions > 0
          ? embedding.dimensions
          : DEFAULT_DIMENSIONS,
    };
  } catch {
    return {
      id: process.env.LLM_WIKI_KB_ID ?? "default",
      title: process.env.WIKI_TITLE ?? "LLM Wiki",
      root,
      configPath,
      dbPath,
      enabled: false,
      dimensions: DEFAULT_DIMENSIONS,
    };
  }
}

export function listKbContexts(): WebKbContext[] {
  const manifest = loadServeManifest();
  if (!manifest) return [loadKbContext()];
  return manifest.knowledgeBases.map((item) => ({ ...item, ...item.embedding }));
}

export function getDefaultKbId(): string {
  return loadServeManifest()?.defaultKb ?? process.env.LLM_WIKI_KB_ID ?? "default";
}

export function loadServeManifest(): ServeManifest | null {
  const manifestPath = process.env.LLM_WIKI_SERVE_MANIFEST;
  if (!manifestPath) return null;
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(manifestPath, "utf8")) as ServeManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.knowledgeBases)) {
      throw new Error("Unsupported manifest shape.");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Unable to load the knowledge-base serve manifest: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export function saveServeManifest(manifest: ServeManifest): void {
  const manifestPath = process.env.LLM_WIKI_SERVE_MANIFEST;
  if (!manifestPath) throw new Error("This server has no writable knowledge-base manifest.");
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  try {
    nodeFs.writeFileSync(temporary, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
    nodeFs.renameSync(temporary, manifestPath);
  } finally {
    if (nodeFs.existsSync(temporary)) nodeFs.unlinkSync(temporary);
  }
}

/** Resolves the embedding dimensionality from the local config. */
export function loadDimensions(): number {
  return loadEmbeddingConfig().dimensions;
}
