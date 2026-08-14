import { Command } from "commander";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDefaultConfig, saveConfig } from "../utils/config.js";
import { getWorkspaceManifestPath } from "../utils/paths.js";
import type { WorkspaceManifest } from "../types/config.js";
import { WIKI_DIR_NAME, WORKSPACE_FILE_NAME } from "../types/config.js";
import { logger } from "../utils/logger.js";
import {
  assertKnowledgeBaseId,
  createRegistryEntry,
  getRegistryPath,
  loadRegistry,
  resolveRegistryEntry,
  saveRegistry,
} from "../utils/registry.js";
import { findWorkspaceManifest } from "../utils/paths.js";

export function makeWorkspaceCommand(): Command {
  const command = new Command("workspace")
    .alias("kb")
    .description("Manage registered workspaces");

  command
    .command("create")
    .description("Create a managed workspace with wiki and local metadata")
    .argument("<title>", "Workspace title")
    .requiredOption("--path <path>", "Workspace directory")
    .action((title: string, options: { path: string }) => {
      const root = nodePath.resolve(options.path);
      nodeFs.mkdirSync(root, { recursive: true });
      const wikiDir = nodePath.join(root, "wiki");
      nodeFs.mkdirSync(wikiDir, { recursive: true });
      const configPath = nodePath.join(root, ".llm-wiki", "config.json");
      if (!nodeFs.existsSync(configPath)) saveConfig({ ...getDefaultConfig(), title }, root);
      const manifestPath = getWorkspaceManifestPath(root);
      let manifest: WorkspaceManifest;
      if (!nodeFs.existsSync(manifestPath)) {
        manifest = {
          version: 1,
          id: randomUUID(),
          title,
          root,
          createdAt: new Date().toISOString(),
        };
        nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      } else {
        manifest = JSON.parse(nodeFs.readFileSync(manifestPath, "utf8")) as WorkspaceManifest;
      }
      const registry = loadRegistry();
      registry.knowledgeBases[manifest.id] = createRegistryEntry({ root });
      saveRegistry(registry);
      logger.success(`Created workspace "${title}" → ${root}`);
    });

  command
    .command("add")
    .description("Register an initialized knowledge-base directory")
    .argument("<id>", "Stable knowledge-base id")
    .argument("<root>", "Knowledge-base root directory")
    .option("--config <path>", "Explicit config.json path")
    .option("--db <path>", "Explicit SQLite index path")
    .option("--force", "Replace an existing entry", false)
    .action((id: string, root: string, options: AddOptions) => {
      assertKnowledgeBaseId(id);
      const registry = loadRegistry();
      if (registry.knowledgeBases[id] && !options.force) {
        throw new Error(`Knowledge base "${id}" is already registered; use --force to replace it.`);
      }
      registry.knowledgeBases[id] = createRegistryEntry({
        root: nodePath.resolve(root),
        configPath: options.config,
        dbPath: options.db,
      });
      ensureWorkspaceManifest(registry.knowledgeBases[id].root, id, registry.knowledgeBases[id].title);
      saveRegistry(registry);
      logger.success(`Registered "${id}" → ${registry.knowledgeBases[id].root}`);
    });

  command
    .command("list")
    .description("List registered knowledge bases")
    .option("--json", "Output the registry as JSON", false)
    .action((options: { json?: boolean }) => {
      const registry = loadRegistry();
      if (options.json) {
        process.stdout.write(JSON.stringify(registry, null, 2) + "\n");
        return;
      }
      const entries = Object.entries(registry.knowledgeBases);
      if (entries.length === 0) {
        logger.info(`No registered knowledge bases. Registry: ${getRegistryPath()}`);
        return;
      }
      for (const [id, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const marker = registry.defaultKb === id ? "*" : " ";
        logger.raw(`${marker} ${id}\t${entry.title}\t${entry.root}`);
      }
    });

  command
    .command("show")
    .description("Show one registered knowledge base")
    .argument("<id>")
    .option("--json", "Output as JSON", false)
    .action((id: string, options: { json?: boolean }) => {
      const entry = resolveRegistryEntry(id);
      if (options.json) process.stdout.write(JSON.stringify({ id, ...entry }, null, 2) + "\n");
      else {
        logger.success(`${id}: ${entry.title}`);
        logger.info(`  root:   ${entry.root}`);
        logger.info(`  config: ${entry.configPath}`);
        logger.info(`  db:     ${entry.dbPath}`);
      }
    });

  command
    .command("current")
    .description("Show the workspace resolved from the current directory or --workspace")
    .option("--json", "Output as JSON", false)
    .action((options: { json?: boolean }, cmd: Command) => {
      const raw = cmd.optsWithGlobals() as {
        workspace?: string;
        kb?: string;
      };
      const requested = raw.workspace ?? raw.kb ?? process.env.LLM_WIKI_WORKSPACE ?? process.env.LLM_WIKI_KB;
      const registry = loadRegistry();
      const discovered = findWorkspaceManifest();
      const requestedPath = requested && (requested === "." || requested === ".." || requested.startsWith("./") || requested.startsWith("../") || nodePath.isAbsolute(requested))
        ? nodePath.resolve(process.cwd(), requested)
        : undefined;
      const pathWorkspace = requestedPath ? findWorkspaceManifest(requestedPath) : undefined;
      if (pathWorkspace) {
        const payload = {
          id: pathWorkspace.manifest.id,
          title: pathWorkspace.manifest.title,
          root: pathWorkspace.root,
          resolvedBy: requestedPath ? "path" : "cwd",
        };
        if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        else {
          logger.success(`Workspace: ${payload.title}`);
          logger.info(`  ID: ${payload.id}`);
          logger.info(`  Root: ${payload.root}`);
          logger.info(`  Resolved by: ${payload.resolvedBy}`);
        }
        return;
      }
      if (!requested && discovered) {
        const payload = {
          id: discovered.manifest.id,
          title: discovered.manifest.title,
          root: discovered.root,
          resolvedBy: "cwd",
        };
        if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
        else {
          logger.success(`Workspace: ${payload.title}`);
          logger.info(`  ID: ${payload.id}`);
          logger.info(`  Root: ${payload.root}`);
          logger.info(`  Resolved by: ${payload.resolvedBy}`);
        }
        return;
      }
      const id = requested;
      const candidates = Object.entries(registry.knowledgeBases).filter(([, entry]) => {
        const cwd = nodePath.resolve(process.cwd());
        return cwd === entry.root || cwd.startsWith(`${entry.root}${nodePath.sep}`);
      });
      const resolvedId = id ?? candidates.sort((a, b) => b[1].root.length - a[1].root.length)[0]?.[0];
      if (!resolvedId) throw new Error("No workspace could be resolved from the current directory.");
      const entry = resolveRegistryEntry(resolvedId, registry);
      const payload = { id: resolvedId, title: entry.title, root: entry.root, resolvedBy: id ? "flag" : "cwd" };
      if (options.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      else {
        logger.success(`Workspace: ${payload.title}`);
        logger.info(`  ID: ${payload.id}`);
        logger.info(`  Root: ${payload.root}`);
        logger.info(`  Resolved by: ${payload.resolvedBy}`);
      }
    });

  command
    .command("remove")
    .description("Remove a registry entry without deleting its files")
    .argument("<id>")
    .action((id: string) => {
      const registry = loadRegistry();
      resolveRegistryEntry(id, registry);
      delete registry.knowledgeBases[id];
      if (registry.defaultKb === id) delete registry.defaultKb;
      saveRegistry(registry);
      logger.success(`Removed registry entry "${id}"; knowledge-base files were not deleted.`);
    });

  command
    .command("purge")
    .description("Delete a workspace's on-disk metadata and remove its registry entry")
    .argument("<id>")
    .option("--include-wiki", "Also delete the wiki/ document directory", false)
    .option("--force", "Skip the interactive confirmation prompt", false)
    .action(async (id: string, options: PurgeOptions) => {
      const registry = loadRegistry();
      const entry = resolveRegistryEntry(id, registry);
      const metadataDir = nodePath.join(entry.root, WIKI_DIR_NAME);
      const manifestPath = nodePath.join(metadataDir, WORKSPACE_FILE_NAME);
      if (!nodeFs.existsSync(manifestPath)) {
        throw new Error(
          `Workspace manifest not found at ${manifestPath}; nothing was deleted. Use "llm-wiki workspace remove ${id}" to drop the registry entry.`,
        );
      }

      const targets = [metadataDir];
      if (options.includeWiki) targets.push(nodePath.join(entry.root, "wiki"));

      if (!options.force) {
        const summary = targets.map((target) => `  - ${target}`).join("\n");
        logger.warn(`About to delete:\n${summary}`);
        const rl = readline.createInterface({ input, output });
        let answer: string;
        try {
          answer = await rl.question(`Type "yes" to purge workspace "${id}": `);
        } finally {
          rl.close();
        }
        if (answer.trim().toLowerCase() !== "yes") {
          logger.info("Aborted; nothing was deleted.");
          return;
        }
      }

      for (const target of targets) {
        nodeFs.rmSync(target, { recursive: true, force: true });
      }
      delete registry.knowledgeBases[id];
      if (registry.defaultKb === id) delete registry.defaultKb;
      saveRegistry(registry);
      logger.success(
        `Purged workspace "${id}"; deleted ${targets.length} path(s) under ${entry.root}.`,
      );
    });

  command
    .command("default")
    .description("Choose the default knowledge base for multi-library serving")
    .argument("<id>")
    .action((id: string) => {
      const registry = loadRegistry();
      resolveRegistryEntry(id, registry);
      registry.defaultKb = id;
      saveRegistry(registry);
      logger.success(`Default knowledge base set to "${id}".`);
    });

  return command;
}

function ensureWorkspaceManifest(root: string, id: string, title: string): void {
  const path = getWorkspaceManifestPath(root);
  if (nodeFs.existsSync(path)) return;
  const manifest: WorkspaceManifest = {
    version: 1,
    id,
    title,
    root: nodePath.resolve(root),
    createdAt: new Date().toISOString(),
  };
  nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
  nodeFs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

interface AddOptions {
  config?: string;
  db?: string;
  force?: boolean;
}

interface PurgeOptions {
  includeWiki?: boolean;
  force?: boolean;
}
