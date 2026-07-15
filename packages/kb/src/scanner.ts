import nodeFs from "node:fs";
import nodePath from "node:path";

/**
 * File scanner.
 *
 * Recursively walks every directory in `include` (relative to the project
 * root), keeping only supported text file types, skipping `exclude` directory
 * names anywhere in the tree, and normalizing all paths to POSIX style so the
 * stored paths are stable across operating systems.
 *
 * Ported from the reference system's `scripts/kb/index-files.mjs` scan logic.
 */

/** File extensions that are indexed (code, markup, config, text). */
export const SUPPORTED_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".md",
  ".mdx",
  ".json",
  ".txt",
  ".yml",
  ".yaml",
] as const;

export interface ScanOptions {
  /** Project root the `include` dirs are resolved against. */
  projectRoot: string;
  /** Directories to scan recursively. */
  include: string[];
  /** Directory names to skip anywhere in the tree. */
  exclude: string[];
}

/** A discovered file ready for indexing. */
export interface ScannedFile {
  /** Repo-relative path, POSIX-normalized (e.g. `wiki/guide.md`). */
  relPath: string;
  /** Absolute filesystem path. */
  absPath: string;
  /** Inferred language tag (derived from extension). */
  language: string;
}

/** Detailed scan outcome used by the indexer to make stale cleanup safe. */
export interface ScanResult {
  files: ScannedFile[];
  /** Include roots whose contents could not be scanned completely. */
  unavailableRoots: string[];
}

/** Lowercased extension set for O(1) membership checks. */
const SUPPORTED_EXT_SET = new Set<string>(SUPPORTED_EXTENSIONS);

/** Maps a file extension to a coarse language tag. */
export function languageFromExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".md":
    case ".mdx":
      return "markdown";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".txt":
      return "text";
    default:
      return "other";
  }
}

/**
 * Scans `include` directories and returns all indexable files.
 *
 * Non-existent include directories are skipped silently (they may simply not
 * exist yet in a fresh project). Hidden files/dirs (leading `.`) are skipped
 * except where the whole directory is one of the configured include roots.
 */
export function scanFiles(options: ScanOptions): ScannedFile[] {
  return scanFilesDetailed(options).files;
}

/**
 * Scans files and reports roots that were missing or only partially readable.
 * Callers performing destructive stale cleanup should skip that cleanup when
 * this list is non-empty, because an unavailable tree is not evidence that its
 * previously indexed files were deleted.
 */
export function scanFilesDetailed(options: ScanOptions): ScanResult {
  const excludeSet = new Set(options.exclude);
  const results: ScannedFile[] = [];
  const unavailableRoots: string[] = [];

  for (const root of options.include) {
    const absRoot = nodePath.resolve(options.projectRoot, root);
    let isDirectory = false;
    try {
      isDirectory = nodeFs.statSync(absRoot).isDirectory();
    } catch {
      // Missing and inaccessible roots are both unsafe for stale cleanup.
    }
    if (!isDirectory) {
      unavailableRoots.push(root);
      continue;
    }
    if (!walk(absRoot, options.projectRoot, excludeSet, results)) {
      unavailableRoots.push(root);
    }
  }

  // Stable, deterministic order for reproducible indexes.
  results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files: results, unavailableRoots };
}

function walk(
  dirAbs: string,
  projectRoot: string,
  excludeSet: Set<string>,
  out: ScannedFile[],
): boolean {
  let entries: nodeFs.Dirent[];
  try {
    entries = nodeFs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return false;
  }

  let complete = true;

  for (const entry of entries) {
    const name = entry.name;

    // Skip excluded directory names anywhere in the tree.
    if (excludeSet.has(name)) {
      continue;
    }
    // Skip hidden entries (leading dot), e.g. `.DS_Store`, `.git`.
    if (name.startsWith(".")) {
      continue;
    }

    const abs = nodePath.join(dirAbs, name);
    if (entry.isDirectory()) {
      if (!walk(abs, projectRoot, excludeSet, out)) {
        complete = false;
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const ext = nodePath.extname(name).toLowerCase();
    if (!SUPPORTED_EXT_SET.has(ext)) {
      continue;
    }

    out.push({
      relPath: toPosix(nodePath.relative(projectRoot, abs)),
      absPath: abs,
      language: languageFromExtension(ext),
    });
  }
  return complete;
}

/** Normalizes a path to forward-slash POSIX style. */
export function toPosix(p: string): string {
  return p.split(nodePath.sep).join("/");
}
