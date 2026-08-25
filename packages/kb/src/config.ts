import type { KbConfig } from "./types.js";

/**
 * KB configuration defaults.
 *
 * Ported from the reference system's `kbConfig`:
 *   - `include`: directories to scan (here `wiki/` rather than `docs/`).
 *   - `exclude`: deps, build artifacts, git metadata, and the index DB itself.
 *   - `chunk.maxChars` / `chunk.overlap`: char-based chunking (1200 / 200).
 *   - `embedding.dimensions`: 1536 — MUST match the `vec_chunks` schema.
 */
export const DEFAULT_KB_CONFIG: Readonly<KbConfig> = {
  include: ["wiki"],
  exclude: ["node_modules", ".git", ".llm-wiki", "dist", "build", "out"],
  chunk: {
    maxChars: 1200,
    overlap: 200,
  },
  embedding: {
    enabled: false,
    dimensions: 1536,
  },
};

/** Returns a fresh copy of the default KB config. */
export function getDefaultKbConfig(): KbConfig {
  return structuredClone(DEFAULT_KB_CONFIG);
}

/**
 * Validates a raw value as {@link KbConfig}, throwing a descriptive `Error` on
 * any mismatch. Used when loading config that may have been hand-edited.
 *
 * Validation is intentionally permissive about *missing* fields (they are
 * merged with defaults by {@link mergeKbConfig}); it only rejects values that
 * are present but malformed.
 */
export function assertKbConfig(value: unknown): asserts value is KbConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid kb config: must be an object.");
  }
  const record = value as Record<string, unknown>;

  if (record.include !== undefined) {
    assertStringArray(record.include, "include");
  }
  if (record.exclude !== undefined) {
    assertStringArray(record.exclude, "exclude");
  }
  if (record.chunk !== undefined) {
    if (typeof record.chunk !== "object" || record.chunk === null) {
      throw new Error('Invalid kb config: "chunk" must be an object.');
    }
    const chunk = record.chunk as Record<string, unknown>;
    if (chunk.maxChars !== undefined) {
      assertPositiveInt(chunk.maxChars, "chunk.maxChars");
    }
    if (chunk.overlap !== undefined) {
      assertNonNegativeInt(chunk.overlap, "chunk.overlap");
    }
  }
  if (record.embedding !== undefined) {
    if (typeof record.embedding !== "object" || record.embedding === null) {
      throw new Error('Invalid kb config: "embedding" must be an object.');
    }
    const embedding = record.embedding as Record<string, unknown>;
    if (embedding.enabled !== undefined && typeof embedding.enabled !== "boolean") {
      throw new Error('Invalid kb config: "embedding.enabled" must be a boolean.');
    }
    if (embedding.dimensions !== undefined) {
      assertPositiveInt(embedding.dimensions, "embedding.dimensions");
    }
  }
}

/**
 * Merges a (possibly partial) kb config from the user's config file over the
 * defaults. Any missing field falls back to its default. Hand-edited values
 * that pass {@link assertKbConfig} are preserved.
 */
export function mergeKbConfig(partial: unknown): KbConfig {
  assertKbConfig(partial);
  const base = getDefaultKbConfig();
  if (typeof partial !== "object" || partial === null) {
    return base;
  }
  const p = partial as Partial<KbConfig>;
  const merged: KbConfig = {
    include: p.include && p.include.length > 0 ? [...p.include] : base.include,
    exclude: p.exclude && p.exclude.length > 0 ? [...p.exclude] : base.exclude,
    chunk: {
      maxChars: p.chunk?.maxChars ?? base.chunk.maxChars,
      overlap: p.chunk?.overlap ?? base.chunk.overlap,
    },
    embedding: {
      enabled: p.embedding?.enabled ?? base.embedding.enabled,
      dimensions: p.embedding?.dimensions ?? base.embedding.dimensions,
    },
  };
  return merged;
}

function assertStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`Invalid kb config: "${field}" must be an array of strings.`);
  }
}

function assertPositiveInt(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid kb config: "${field}" must be a positive integer.`);
  }
}

function assertNonNegativeInt(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid kb config: "${field}" must be a non-negative integer.`);
  }
}
