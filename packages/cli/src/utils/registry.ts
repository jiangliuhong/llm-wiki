import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { loadConfigFromPath } from "./config.js";
import { resolveDbPath } from "@llm-wiki/kb";
import { CONFIG_FILE_NAME, WIKI_DIR_NAME } from "../types/config.js";

export const REGISTRY_VERSION = 1;
export const REGISTRY_ENV = "LLM_WIKI_REGISTRY";

export interface RegistryEntry {
  title: string;
  root: string;
  configPath: string;
  dbPath: string;
}

export interface KnowledgeBaseRegistry {
  version: typeof REGISTRY_VERSION;
  defaultKb?: string;
  knowledgeBases: Record<string, RegistryEntry>;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export function getRegistryPath(override?: string): string {
  const configured = override ?? process.env[REGISTRY_ENV];
  if (configured) {
    return nodePath.isAbsolute(configured)
      ? configured
      : nodePath.resolve(process.cwd(), configured);
  }
  const base =
    process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : process.env.XDG_CONFIG_HOME || nodePath.join(nodeOs.homedir(), ".config");
  return nodePath.join(base, "llm-wiki", "registry.json");
}

export function loadRegistry(registryPath: string = getRegistryPath()): KnowledgeBaseRegistry {
  if (!nodeFs.existsSync(registryPath)) {
    return { version: REGISTRY_VERSION, knowledgeBases: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(nodeFs.readFileSync(registryPath, "utf8"));
  } catch (err) {
    throw new RegistryError(
      `Registry at ${registryPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  assertRegistry(parsed, registryPath);
  return parsed;
}

export function saveRegistry(
  registry: KnowledgeBaseRegistry,
  registryPath: string = getRegistryPath(),
): void {
  assertRegistry(registry, registryPath);
  nodeFs.mkdirSync(nodePath.dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.tmp`;
  try {
    nodeFs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + "\n", "utf8");
    nodeFs.renameSync(temporary, registryPath);
  } finally {
    if (nodeFs.existsSync(temporary)) nodeFs.unlinkSync(temporary);
  }
}

export function resolveRegistryEntry(
  id: string,
  registry: KnowledgeBaseRegistry = loadRegistry(),
): RegistryEntry {
  assertKnowledgeBaseId(id);
  const entry = registry.knowledgeBases[id];
  if (!entry) {
    throw new RegistryError(
      `Workspace "${id}" is not registered. Run "llm-wiki workspace list" to see available entries.`,
    );
  }
  return entry;
}

export function createRegistryEntry(options: {
  root: string;
  configPath?: string;
  dbPath?: string;
}): RegistryEntry {
  const root = nodePath.resolve(options.root);
  const configPath = options.configPath
    ? nodePath.resolve(options.configPath)
    : nodePath.resolve(root, WIKI_DIR_NAME, CONFIG_FILE_NAME);
  const dbPath = options.dbPath ? nodePath.resolve(options.dbPath) : resolveDbPath(root);
  const config = loadConfigFromPath(configPath);
  return { title: config.title, root, configPath, dbPath };
}

export function assertKnowledgeBaseId(id: string): void {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(id) ||
    ["__proto__", "prototype", "constructor"].includes(id)
  ) {
    throw new RegistryError(
      `Invalid knowledge-base id "${id}". Use lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
}

function assertRegistry(value: unknown, path: string): asserts value is KnowledgeBaseRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistryError(`Registry at ${path} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== REGISTRY_VERSION) {
    throw new RegistryError(
      `Unsupported registry version at ${path}: expected ${REGISTRY_VERSION}.`,
    );
  }
  if (
    typeof record.knowledgeBases !== "object" ||
    record.knowledgeBases === null ||
    Array.isArray(record.knowledgeBases)
  ) {
    throw new RegistryError(`Registry at ${path} has an invalid "knowledgeBases" object.`);
  }
  const entries = record.knowledgeBases as Record<string, unknown>;
  for (const [id, raw] of Object.entries(entries)) {
    assertKnowledgeBaseId(id);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RegistryError(`Registry entry "${id}" must be an object.`);
    }
    const entry = raw as Record<string, unknown>;
    for (const field of ["title", "root", "configPath", "dbPath"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new RegistryError(`Registry entry "${id}" has an invalid "${field}".`);
      }
    }
    for (const field of ["root", "configPath", "dbPath"] as const) {
      if (!nodePath.isAbsolute(entry[field] as string)) {
        throw new RegistryError(`Registry entry "${id}" field "${field}" must be absolute.`);
      }
    }
  }
  if (record.defaultKb !== undefined) {
    if (typeof record.defaultKb !== "string" || !entries[record.defaultKb]) {
      throw new RegistryError(`Registry at ${path} references an unknown default knowledge base.`);
    }
  }
}
