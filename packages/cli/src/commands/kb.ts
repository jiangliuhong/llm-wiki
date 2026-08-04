import { Command } from "commander";
import nodePath from "node:path";
import { logger } from "../utils/logger.js";
import {
  assertKnowledgeBaseId,
  createRegistryEntry,
  getRegistryPath,
  loadRegistry,
  resolveRegistryEntry,
  saveRegistry,
} from "../utils/registry.js";

export function makeKbCommand(): Command {
  const command = new Command("kb").description("Manage registered knowledge bases");

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

interface AddOptions {
  config?: string;
  db?: string;
  force?: boolean;
}
