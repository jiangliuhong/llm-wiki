import nodeFs from "node:fs";
import nodePath from "node:path";
import { closeConnection, initSchema, openDatabase } from "@llm-wiki/kb";
import { loadServeManifest, saveServeManifest, type ServeManifestEntry } from "./kb-config";

interface RegistryFile {
  version: 1;
  defaultKb?: string;
  knowledgeBases: Record<
    string,
    { title: string; root: string; configPath: string; dbPath: string }
  >;
}

export class RegistryMutationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RegistryMutationError";
  }
}

export function addKnowledgeBaseFromPath(input: {
  id?: string;
  root: string;
  title?: string;
  initialize?: boolean;
}): ServeManifestEntry {
  const manifest = loadServeManifest();
  if (!manifest?.registryPath) {
    throw new RegistryMutationError(
      'Adding paths is available only when the server is started with "serve --all".',
      403,
    );
  }
  if (!nodePath.isAbsolute(input.root)) {
    throw new RegistryMutationError("Knowledge-base path must be absolute.", 400);
  }

  let root: string;
  try {
    if (!nodeFs.existsSync(input.root)) {
      if (!input.initialize) throw new Error("Directory does not exist.");
      nodeFs.mkdirSync(input.root, { recursive: true });
    }
    root = nodeFs.realpathSync(input.root);
    if (!nodeFs.statSync(root).isDirectory()) throw new Error("Path is not a directory.");
  } catch (error) {
    throw new RegistryMutationError(
      `Knowledge-base directory is not accessible: ${(error as Error).message}`,
      400,
    );
  }

  const configPath = nodePath.join(root, ".llm-wiki", "config.json");
  const dbPath = nodePath.join(root, ".llm-wiki", "index.db");
  if (!nodeFs.existsSync(configPath)) {
    if (!input.initialize) {
      throw new RegistryMutationError(
        `No llm-wiki project config found at ${configPath}. Enable initialization to create it.`,
        400,
      );
    }
    initializeProject(root, configPath, input.title);
  }
  const config = readProjectConfig(configPath);
  const registry = readRegistry(manifest.registryPath);
  const duplicate = Object.entries(registry.knowledgeBases).find(
    ([, entry]) => entry.root === root,
  );
  if (duplicate) {
    throw new RegistryMutationError(`This path is already registered as "${duplicate[0]}".`, 409);
  }

  const id = chooseId(input.id, root, registry.knowledgeBases);
  if (registry.knowledgeBases[id]) {
    throw new RegistryMutationError(`Knowledge base "${id}" already exists.`, 409);
  }

  const entry: ServeManifestEntry = {
    id,
    title: config.title,
    root,
    configPath,
    dbPath,
    embedding: config.embedding,
  };
  registry.knowledgeBases[id] = {
    title: entry.title,
    root,
    configPath,
    dbPath,
  };
  registry.defaultKb ??= id;

  prepareDatabase(entry);
  writeJsonAtomic(manifest.registryPath, registry);
  saveServeManifest({
    ...manifest,
    defaultKb: manifest.defaultKb || id,
    knowledgeBases: [...manifest.knowledgeBases, entry],
  });
  return entry;
}

function initializeProject(root: string, configPath: string, requestedTitle?: string): void {
  const title = requestedTitle?.trim() || nodePath.basename(root).trim() || "My Wiki";
  const config = {
    title,
    port: 3000,
    kb: {
      include: ["wiki", "docs"],
      exclude: ["node_modules", ".git", ".llm-wiki", "dist", "build", "out"],
      chunk: { maxChars: 1200, overlap: 200 },
      embedding: { enabled: false, dimensions: 1536 },
    },
  };
  nodeFs.mkdirSync(nodePath.dirname(configPath), { recursive: true });
  writeJsonAtomic(configPath, config);

  const wikiDir = nodePath.join(root, "wiki");
  nodeFs.mkdirSync(wikiDir, { recursive: true });
  const welcomePath = nodePath.join(wikiDir, "welcome.md");
  if (!nodeFs.existsSync(welcomePath)) {
    nodeFs.writeFileSync(
      welcomePath,
      [
        `# Welcome to ${title}`,
        "",
        "This knowledge base was initialized from the llm-wiki Web UI.",
        "Add Markdown, code, or text files under this directory, then run the index command.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

function readProjectConfig(configPath: string): {
  title: string;
  embedding: { enabled: boolean; dimensions: number };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(nodeFs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new RegistryMutationError(
      `No valid llm-wiki project config found at ${configPath}: ${(error as Error).message}`,
      400,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RegistryMutationError("Knowledge-base config must be a JSON object.", 400);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new RegistryMutationError('Knowledge-base config requires a non-empty "title".', 400);
  }
  const kb = typeof record.kb === "object" && record.kb !== null ? record.kb : {};
  const rawEmbedding =
    typeof (kb as Record<string, unknown>).embedding === "object" &&
    (kb as Record<string, unknown>).embedding !== null
      ? ((kb as Record<string, unknown>).embedding as Record<string, unknown>)
      : {};
  const dimensions = rawEmbedding.dimensions;
  return {
    title: record.title.trim(),
    embedding: {
      enabled: rawEmbedding.enabled === true,
      dimensions:
        typeof dimensions === "number" && Number.isInteger(dimensions) && dimensions > 0
          ? dimensions
          : 1536,
    },
  };
}

function readRegistry(registryPath: string): RegistryFile {
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(registryPath, "utf8")) as RegistryFile;
    if (parsed.version !== 1 || typeof parsed.knowledgeBases !== "object") {
      throw new Error("Unsupported registry shape.");
    }
    return parsed;
  } catch (error) {
    throw new RegistryMutationError(
      `Unable to read the global knowledge-base registry: ${(error as Error).message}`,
      500,
    );
  }
}

function chooseId(
  requested: string | undefined,
  root: string,
  existing: RegistryFile["knowledgeBases"],
): string {
  if (requested?.trim()) {
    const id = requested.trim();
    if (!isValidId(id)) {
      throw new RegistryMutationError(
        "ID must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens.",
        400,
      );
    }
    return id;
  }
  const base =
    nodePath
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "knowledge-base";
  let candidate = base;
  let suffix = 2;
  while (existing[candidate]) candidate = `${base}-${suffix++}`;
  return candidate;
}

function isValidId(id: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._-]*$/.test(id) && !["__proto__", "prototype", "constructor"].includes(id)
  );
}

function prepareDatabase(entry: ServeManifestEntry): void {
  const connection = openDatabase({
    projectRoot: entry.root,
    dbPath: entry.dbPath,
    loadVector: false,
  });
  try {
    initSchema(connection, entry.embedding.dimensions);
  } finally {
    closeConnection(connection);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    nodeFs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    nodeFs.renameSync(temporary, path);
  } finally {
    if (nodeFs.existsSync(temporary)) nodeFs.unlinkSync(temporary);
  }
}
