import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";

import {
  closeConnection,
  getDefaultKbConfig,
  indexFiles,
  listFiles,
  openDatabase,
  searchKnowledgeBase,
} from "../dist/index.js";

function makeProject(content = "# Welcome\n\nSearchable release checklist.\n") {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "llm-wiki-kb-test-"));
  mkdirSync(path.join(projectRoot, "wiki"));
  writeFileSync(path.join(projectRoot, "wiki", "welcome.md"), content, "utf8");
  return projectRoot;
}

test("default search is FTS-only and does not return fake-vector matches", () => {
  const projectRoot = makeProject();
  const config = getDefaultKbConfig();

  const stats = indexFiles({ projectRoot, config });
  assert.equal(stats.vectorEnabled, false);

  const found = searchKnowledgeBase("release", {
    projectRoot,
    dimensions: config.embedding.dimensions,
  });
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0]?.source, "fts");

  const absent = searchKnowledgeBase("termthatdoesnotexist", {
    projectRoot,
    dimensions: config.embedding.dimensions,
  });
  assert.deepEqual(absent.hits, []);
});

test("search rejects empty queries and invalid limits", () => {
  assert.throws(
    () => searchKnowledgeBase("   ", { dimensions: 1536 }),
    /must not be empty/,
  );
  assert.throws(
    () => searchKnowledgeBase("valid", { dimensions: 1536, limit: 51 }),
    /between 1 and 50/,
  );
});

test("vector dimension changes require reset and reset recreates the table", () => {
  const projectRoot = makeProject();
  const base = getDefaultKbConfig();
  const config8 = { ...base, embedding: { enabled: true, dimensions: 8 } };
  const config16 = { ...base, embedding: { enabled: true, dimensions: 16 } };

  indexFiles({ projectRoot, config: config8, reset: true });
  assert.throws(
    () => indexFiles({ projectRoot, config: config16 }),
    /Run "llm-wiki-cli index --reset"/,
  );
  const rebuilt = indexFiles({ projectRoot, config: config16, reset: true });
  assert.equal(rebuilt.added, 1);
  assert.equal(rebuilt.vectorEnabled, true);
});

test("incremental indexing backfills missing vectors", () => {
  const projectRoot = makeProject();
  const base = getDefaultKbConfig();
  const config = { ...base, embedding: { enabled: true, dimensions: 8 } };
  indexFiles({ projectRoot, config });

  const conn = openDatabase({ projectRoot, loadVector: true });
  try {
    conn.db.exec("DELETE FROM vec_chunks");
  } finally {
    closeConnection(conn);
  }

  const backfill = indexFiles({ projectRoot, config });
  assert.equal(backfill.updated, 1);
  assert.equal(backfill.chunks, 1);
});

test("an unavailable include root does not trigger stale cleanup", () => {
  const projectRoot = makeProject();
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  renameSync(path.join(projectRoot, "wiki"), path.join(projectRoot, "wiki-offline"));

  const progress = [];
  const stats = indexFiles({ projectRoot, config, onProgress: (line) => progress.push(line) });
  assert.equal(stats.deleted, 0);
  assert.equal(listFiles({ projectRoot }).total, 1);
  assert.ok(progress.some((line) => line.includes("stale cleanup will be skipped")));
});
