import nodePath from "node:path";
import { resolveDbPath } from "@llm-wiki/kb";
import { WIKI_DIR_NAME, CONFIG_FILE_NAME } from "../types/config.js";
import { resolveRegistryEntry } from "./registry.js";
import { findWorkspaceManifest } from "./paths.js";

/**
 * Global options that every subcommand inherits.
 *
 * `llm-wiki` is deliberately repo-agnostic: it operates on a *directory*
 * (`--root`), an explicit index DB (`--db`), and an explicit config file
 * (`--config`). All three can also be supplied via environment variables so an
 * orchestrator (e.g. pi-agents) can set them once for a whole pipeline run
 * instead of repeating them on every invocation.
 *
 * Resolution precedence (highest first):
 *   1. Command-line flag (`--root`, `--db`, `--config`)
 *   2. Environment variable (`LLM_WIKI_ROOT`, `LLM_WIKI_DB`, `LLM_WIKI_CONFIG`)
 *   3. Default derived from `--root` (or `process.cwd()` when `--root` is unset)
 */

/** Environment variable names matching the `--root` / `--db` / `--config` flags. */
export const ENV = {
  root: "LLM_WIKI_ROOT",
  db: "LLM_WIKI_DB",
  config: "LLM_WIKI_CONFIG",
  kb: "LLM_WIKI_KB",
  workspace: "LLM_WIKI_WORKSPACE",
} as const;

/** Resolved global context shared by all subcommands. */
export interface GlobalContext {
  /** Registered id, when the context came from --kb. */
  kbId?: string;
  /** Canonical workspace id. `kbId` is retained for migration callers. */
  workspaceId?: string;
  /** Absolute knowledge-base root directory. */
  root: string;
  /** Absolute SQLite DB path (explicit or derived from `root`). */
  dbPath: string;
  /** Absolute config.json path (explicit or derived from `root`). */
  configPath: string;
}

/** Raw option map as produced by commander's `program.opts()` / `cmd.optsWithGlobals()`. */
export interface RawGlobalOptions {
  root?: string;
  db?: string;
  config?: string;
  kb?: string;
  workspace?: string;
}

/**
 * Resolves the global context from CLI flags, environment variables, and
 * defaults. Flags win over env vars; env vars win over defaults. The DB and
 * config paths default to `<root>/.llm-wiki/index.db` and
 * `<root>/.llm-wiki/config.json` respectively.
 */
export function resolveGlobalOptions(raw: RawGlobalOptions = {}): GlobalContext {
  const discovered = findWorkspaceManifest();
  const requestedWorkspace =
    raw.workspace ?? process.env[ENV.workspace] ?? raw.kb ?? process.env[ENV.kb];
  const workspacePath =
    requestedWorkspace && looksLikePath(requestedWorkspace)
      ? nodePath.resolve(process.cwd(), requestedWorkspace)
      : undefined;
  const pathWorkspace = workspacePath ? findWorkspaceManifest(workspacePath) : undefined;
  const workspaceId = workspacePath
    ? pathWorkspace?.manifest.id
    : (requestedWorkspace ?? discovered?.manifest.id);
  const kbId = workspaceId;
  const registered = workspacePath
    ? workspaceId
      ? tryResolveRegistryEntry(workspaceId)
      : undefined
    : requestedWorkspace
      ? resolveRegistryEntry(requestedWorkspace)
      : workspaceId
        ? tryResolveRegistryEntry(workspaceId)
        : undefined;
  const root = resolveAbsolute(
    raw.root,
    process.env[ENV.root],
    pathWorkspace?.root ?? workspacePath ?? registered?.root ?? discovered?.root ?? process.cwd(),
  );
  const dbOverride = raw.db ?? process.env[ENV.db];
  const configOverride = raw.config ?? process.env[ENV.config];
  return {
    kbId,
    workspaceId,
    root,
    dbPath: dbOverride
      ? resolveDbPath(root, dbOverride)
      : (registered?.dbPath ?? resolveDbPath(root)),
    configPath: configOverride
      ? resolveConfigPath(root, configOverride)
      : (registered?.configPath ?? resolveConfigPath(root)),
  };
}

function looksLikePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith(`.${nodePath.sep}`) ||
    value.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(value)
  );
}

function tryResolveRegistryEntry(id: string): ReturnType<typeof resolveRegistryEntry> | undefined {
  try {
    return resolveRegistryEntry(id);
  } catch {
    // A workspace manifest is authoritative for local discovery even before
    // the workspace has been added to the global registry.
    return undefined;
  }
}

/** Resolves an absolute config.json path from an optional override + root. */
export function resolveConfigPath(root: string, configOverride?: string): string {
  if (configOverride && configOverride.length > 0) {
    return nodePath.isAbsolute(configOverride)
      ? configOverride
      : nodePath.resolve(process.cwd(), configOverride);
  }
  return nodePath.resolve(root, WIKI_DIR_NAME, CONFIG_FILE_NAME);
}

function resolveAbsolute(
  flag: string | undefined,
  env: string | undefined,
  fallback: string,
): string {
  const value = flag ?? env;
  if (!value || value.length === 0) return fallback;
  return nodePath.isAbsolute(value) ? value : nodePath.resolve(process.cwd(), value);
}
