import { Command } from "commander";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getDefaultConfig, saveConfig, hasConfig, loadConfig } from "../utils/config.js";
import { getConfigPath, getWorkspaceManifestPath } from "../utils/paths.js";
import type { WorkspaceManifest } from "../types/config.js";
import { logger } from "../utils/logger.js";

/**
 * `llm-wiki init`
 *
 * Scaffolds a fresh Wiki project in the current working directory:
 *   - creates `.llm-wiki/`
 *   - writes `.llm-wiki/config.json` with the default config (incl. `kb`)
 *   - creates a `wiki/` content directory with a placeholder file
 *   - installs the bundled project skills under `.agents/skills/`
 *   - refuses to clobber an existing config or skill
 *
 * Returns the program so it can be composed by `index.ts`.
 */
export function makeInitCommand(): Command {
  const command = new Command("init");

  command
    .description("Initialize a new LLM Wiki workspace in the current directory")
    .option(
      "--title <title>",
      "Wiki title written to .llm-wiki/config.json",
      getDefaultConfig().title,
    )
    .option(
      "--port <port>",
      "Port written to .llm-wiki/config.json",
      (value: string) => parsePort(value),
      getDefaultConfig().port,
    )
    .action((options: InitOptions, cmd: Command) => {
      runInit(options, cmd);
    });

  return command;
}

interface InitOptions {
  title: string;
  port: number;
}

function runInit(options: InitOptions, cmd: Command): void {
  // --root overrides the default cwd-based scaffold location. init still
  // treats the target as a project directory (it creates .llm-wiki/, wiki/,
  // .agents/ there), so we resolve the global root and pass it down as cwd.
  const root = (cmd.optsWithGlobals().root as string | undefined) ?? process.cwd();

  if (hasConfig(root)) {
    // Config exists: still install any missing skills, rendered against the
    // existing config's content directory so they reflect the real layout.
    const existing = loadExistingConfigSafe(root);
    createWorkspaceManifest(root, existing?.title ?? options.title);
    const createdSkills = createSkills(root, existing?.kb?.include ?? []);
    logger.warn(
      `A config already exists at ${getConfigPath(root)}.\n` +
        `The existing config was not changed.`,
    );
    logCreatedSkills(createdSkills, root);
    return;
  }

  const defaultConfig = getDefaultConfig();
  const config = { title: options.title, port: options.port, kb: defaultConfig.kb };

  createWorkspaceManifest(root, options.title);

  // Install skills rendered against the config we are about to write, so the
  // placeholder substitution matches the real content directory.
  const createdSkills = createSkills(root, config.kb?.include ?? ["wiki"]);

  saveConfig(config, root);

  // Create a wiki/ content directory so `index` has something to chew on
  // immediately. Only create if missing — never clobber existing content.
  createContentDir(root);

  logger.success(`Wiki initialized successfully`);
  logger.info(`Created ${getConfigPath(root)}`);
  logCreatedSkills(createdSkills, root);
  logger.info(`Title: "${config.title}"  Port: ${config.port}`);
  logger.info(`Next: add files to wiki/ and run "llm-wiki index".`);
}

/** Loads the existing config without throwing on parse errors (best-effort). */
function loadExistingConfigSafe(
  cwd: string,
): { title?: string; kb?: { include?: string[] } } | null {
  try {
    return loadConfig(cwd) as { title?: string; kb?: { include?: string[] } };
  } catch {
    return null;
  }
}

const BUNDLED_SKILLS = ["kb-write-docs", "kb-search-docs", "kb-infer-relations"] as const;

/** Placeholder substituted into SKILL.md during install. */
const KB_INCLUDE_PLACEHOLDER = "{{KB_INCLUDE}}";
const KB_STAGING_PLACEHOLDER = "{{KB_STAGING}}";

/**
 * Installs missing bundled skills without changing user-customized copies.
 *
 * SKILL.md files contain `{{KB_INCLUDE}}` / `{{KB_STAGING}}` placeholders that
 * are rendered against the project's configured content directory so the
 * installed skill text reflects the real layout instead of a hardcoded
 * `wiki/`. Non-SKILL.md files (e.g. `agents/openai.yaml`) are copied verbatim.
 */
function createSkills(cwd: string, includeRoots: readonly string[]): string[] {
  const sourceRoot = nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "skills",
  );
  const targetRoot = nodePath.resolve(cwd, ".agents", "skills");
  const created: string[] = [];
  const includeRoot = includeRoots[0] ?? "wiki";

  for (const skill of BUNDLED_SKILLS) {
    const source = nodePath.join(sourceRoot, skill);
    const target = nodePath.join(targetRoot, skill);
    if (nodeFs.existsSync(target)) {
      logger.info(`Kept existing ${nodePath.relative(cwd, target)}`);
      continue;
    }
    nodeFs.mkdirSync(targetRoot, { recursive: true });
    nodeFs.cpSync(source, target, { recursive: true, errorOnExist: true });
    // Render placeholders in SKILL.md after the verbatim copy.
    const skillFile = nodePath.join(target, "SKILL.md");
    if (nodeFs.existsSync(skillFile)) {
      const rendered = nodeFs
        .readFileSync(skillFile, "utf8")
        .replaceAll(KB_INCLUDE_PLACEHOLDER, includeRoot)
        .replaceAll(KB_STAGING_PLACEHOLDER, "temp");
      nodeFs.writeFileSync(skillFile, rendered, "utf8");
    }
    created.push(nodePath.relative(cwd, target));
  }

  return created;
}

function logCreatedSkills(skills: string[], cwd: string = process.cwd()): void {
  for (const skill of skills) {
    // Prefer the absolute path when the relative form collapses to "" (i.e.
    // the target equals cwd), so the log line is never empty.
    logger.info(`Created ${skill || nodePath.resolve(cwd)}`);
  }
}

/** Creates the default `wiki/` dir with a placeholder Markdown file. */
function createContentDir(cwd: string = process.cwd()): void {
  const wikiDir = nodePath.resolve(cwd, "wiki");
  if (nodeFs.existsSync(wikiDir)) {
    return;
  }
  nodeFs.mkdirSync(wikiDir, { recursive: true });
  const placeholder = nodePath.join(wikiDir, "welcome.md");
  nodeFs.writeFileSync(
    placeholder,
    [
      `# Welcome to your wiki`,
      ``,
      `This directory is scanned by \`llm-wiki index\`. Replace this file`,
      `with your own Markdown, code, or text files and re-index to make them`,
      `searchable from the web UI.`,
      ``,
    ].join("\n"),
    "utf8",
  );
  logger.info(`Created ${nodePath.relative(cwd, placeholder) || placeholder}`);
}

function createWorkspaceManifest(root: string, title: string): void {
  const manifestPath = getWorkspaceManifestPath(root);
  if (nodeFs.existsSync(manifestPath)) return;
  const manifest: WorkspaceManifest = {
    version: 1,
    id: randomUUID(),
    title,
    root: nodePath.resolve(root),
    createdAt: new Date().toISOString(),
  };
  nodeFs.mkdirSync(nodePath.dirname(manifestPath), { recursive: true });
  nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  logger.info(`Created ${nodePath.relative(root, manifestPath) || manifestPath}`);
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port "${value}". Expected an integer between 0 and 65535.`);
  }
  return parsed;
}
