/**
 * Shape of the `.llm-wiki/config.json` file written by `llm-wiki init`
 * and read by `llm-wiki serve` / `index` / `search`.
 *
 * `kb` is optional: older configs written before the knowledge-base feature
 * exist will simply omit it, and `loadConfig` fills in the defaults.
 */
export interface WikiKbChunkConfig {
  maxChars: number;
  overlap: number;
}

export interface WikiKbEmbeddingConfig {
  /** Enable the experimental deterministic-vector retrieval path. */
  enabled: boolean;
  dimensions: number;
}

export interface WikiKbConfig {
  /** Directories to scan recursively (relative to the project root). */
  include: string[];
  /** Directory names to skip while scanning. */
  exclude: string[];
  chunk: WikiKbChunkConfig;
  embedding: WikiKbEmbeddingConfig;
}

export interface WikiConfig {
  /** Title shown in the web UI / document title. */
  title: string;
  /** Port the local Next.js server listens on. */
  port: number;
  /** Knowledge-base indexing/search settings. Optional for backward compat. */
  kb?: WikiKbConfig;
}

/** The default config used by `init` when no existing config is present. */
export const DEFAULT_CONFIG: Readonly<WikiConfig> = {
  title: "My Wiki",
  port: 3000,
  kb: {
    include: ["wiki"],
    exclude: ["node_modules", ".git", ".llm-wiki", "dist", "build", "out"],
    chunk: { maxChars: 1200, overlap: 200 },
    embedding: { enabled: false, dimensions: 1536 },
  },
};

/** Directory name (relative to the user's working directory) for wiki data. */
export const WIKI_DIR_NAME = ".llm-wiki";

/** Stable workspace identity stored inside each workspace root. */
export const WORKSPACE_FILE_NAME = "workspace.json";

export interface WorkspaceManifest {
  version: 1;
  id: string;
  title: string;
  root: string;
  createdAt: string;
}

/** Config file name inside {@link WIKI_DIR_NAME}. */
export const CONFIG_FILE_NAME = "config.json";
