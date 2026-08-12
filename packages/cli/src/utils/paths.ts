import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import nodeFs from "node:fs";
import {
  CONFIG_FILE_NAME,
  WORKSPACE_FILE_NAME,
  WIKI_DIR_NAME,
  type WorkspaceManifest,
} from "../types/config.js";

/**
 * Resolves paths used across the CLI: where the user's wiki lives (current
 * working directory) and where the bundled Next.js web app lives (relative
 * to this compiled CLI).
 *
 * All functions are pure and synchronous; they never perform IO beyond
 * `fs.realpathSync`/`fs.existsSync` lookups.
 */

/** Returns the user's current working directory as an absolute path. */
export function getCwd(): string {
  return process.cwd();
}

/** Absolute path to the `.llm-wiki` directory in the current working directory. */
export function getWikiDir(cwd: string = getCwd()): string {
  return nodePath.resolve(cwd, WIKI_DIR_NAME);
}

/** Absolute path to `.llm-wiki/config.json` in the current working directory. */
export function getConfigPath(cwd: string = getCwd()): string {
  return nodePath.resolve(getWikiDir(cwd), CONFIG_FILE_NAME);
}

/** Absolute path to the workspace identity manifest. */
export function getWorkspaceManifestPath(cwd: string = getCwd()): string {
  return nodePath.resolve(getWikiDir(cwd), WORKSPACE_FILE_NAME);
}

/** Reads a valid workspace manifest, returning null for missing/invalid data. */
export function readWorkspaceManifest(cwd: string = getCwd()): WorkspaceManifest | null {
  const manifestPath = getWorkspaceManifestPath(cwd);
  if (!nodeFs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(manifestPath, "utf8")) as Partial<WorkspaceManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.root !== "string" ||
      typeof parsed.createdAt !== "string"
    ) return null;
    return parsed as WorkspaceManifest;
  } catch {
    return null;
  }
}

/** Finds the nearest workspace manifest while walking from cwd toward / . */
export function findWorkspaceManifest(cwd: string = getCwd()): {
  root: string;
  manifest: WorkspaceManifest;
} | null {
  let current = nodePath.resolve(cwd);
  while (true) {
    const manifest = readWorkspaceManifest(current);
    if (manifest) return { root: current, manifest };
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Whether the `.llm-wiki` directory already exists. */
export function wikiDirExists(cwd: string = getCwd()): boolean {
  return nodeFs.existsSync(getWikiDir(cwd));
}

/** Whether a config file already exists in the `.llm-wiki` directory. */
export function configExists(cwd: string = getCwd()): boolean {
  return nodeFs.existsSync(getConfigPath(cwd));
}

/**
 * Resolves the bundled Next.js web application directory.
 *
 * Layout when published: `<cli>/dist/index.js` and `<cli>/web` (sibling of dist).
 * Layout when running from source via tsx: `<cli>/src/utils/paths.ts`, so the
 * web app lives at `<cli>/../apps/web` (the monorepo workspace).
 *
 * This function handles both layouts and throws a helpful error if the web
 * directory cannot be located.
 */
export function getWebAppDir(): string {
  // `paths.ts` is compiled to `dist/utils/paths.js`; `paths.ts` lives in
  // `src/utils/`. fileURLToPath(import.meta.url) points at whichever copy is
  // actually executing.
  const thisFile = fileURLToPath(import.meta.url);

  const distCandidates = [
    // Published layout: <cli>/dist/utils/paths.js -> <cli>/web
    nodePath.resolve(nodePath.dirname(thisFile), "..", "..", "web"),
    // Monorepo layout (tsx / src): packages/cli/src/utils/paths.ts
    //   -> apps/web
    nodePath.resolve(nodePath.dirname(thisFile), "..", "..", "..", "..", "apps", "web"),
  ];

  for (const candidate of distCandidates) {
    if (hasPackageJsonName(candidate)) {
      try {
        return nodeFs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }

  throw new Error(
    `Could not locate the bundled Next.js web app.\n` +
      `Looked in:\n${distCandidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

/** Returns true if `dir` contains a `package.json` with a `name` field. */
function hasPackageJsonName(dir: string): boolean {
  const pkgPath = nodePath.join(dir, "package.json");
  if (!nodeFs.existsSync(pkgPath)) {
    return false;
  }
  try {
    const content = nodeFs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(content) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0;
  } catch {
    return false;
  }
}
