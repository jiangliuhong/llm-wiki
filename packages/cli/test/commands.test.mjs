import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { closeConnection, getDefaultKbConfig, indexFiles, openDatabase } from "@llm-wiki/kb";
import { migrateKbSchema } from "../dist/commands/serve.js";

const cli = path.resolve("dist/index.js");

function makeProject() {
  const cwd = mkdtempSync(path.join(tmpdir(), "llm-wiki-test-"));
  const initialized = run(cwd, ["init", "--title", "Test"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  return cwd;
}

function run(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
  });
}

test("init installs the bundled project skills", () => {
  const cwd = makeProject();

  const manifest = JSON.parse(readFileSync(path.join(cwd, ".llm-wiki", "workspace.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.title, "Test");
  assert.match(manifest.id, /^[0-9a-f-]{36}$/);

  for (const skill of ["kb-write-docs", "kb-search-docs", "kb-infer-relations"]) {
    const skillFile = path.join(cwd, ".agents", "skills", skill, "SKILL.md");
    const metadataFile = path.join(cwd, ".agents", "skills", skill, "agents", "openai.yaml");
    assert.equal(existsSync(skillFile), true);
    assert.equal(existsSync(metadataFile), true);
    assert.match(readFileSync(skillFile, "utf8"), new RegExp(`name: ${skill}`));
  }
});

test("workspace current resolves the nearest manifest and canonical workspace command", () => {
  const cwd = makeProject();
  const result = run(cwd, ["workspace", "current", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(result.stdout);
  assert.equal(current.title, "Test");
  assert.equal(current.root, realpathSync(cwd));
  assert.equal(current.resolvedBy, "cwd");
});

test("init adds missing skills without overwriting existing skills or config", () => {
  const cwd = makeProject();
  const skillFile = path.join(cwd, ".agents", "skills", "kb-search-docs", "SKILL.md");
  const missingSkill = path.join(cwd, ".agents", "skills", "kb-write-docs");
  const configFile = path.join(cwd, ".llm-wiki", "config.json");
  const configBefore = readFileSync(configFile, "utf8");
  writeFileSync(skillFile, "custom skill\n", "utf8");
  rmSync(missingSkill, { recursive: true });

  const initialized = run(cwd, ["init", "--title", "Changed"]);

  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(readFileSync(skillFile, "utf8"), "custom skill\n");
  assert.equal(existsSync(path.join(missingSkill, "SKILL.md")), true);
  assert.equal(readFileSync(configFile, "utf8"), configBefore);
});

test("search before index is handled without an unhandled stack trace", () => {
  const cwd = makeProject();
  const result = run(cwd, ["search", "anything"]);
  // A never-built index reads as empty (connection-level fallback), matching
  // the --read-only behavior below instead of a DB error.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No results for "anything"/);
  assert.doesNotMatch(result.stderr, /at openDatabase/);
});

test("search --read-only returns empty results when the DB does not exist", () => {
  const cwd = makeProject();
  const result = run(cwd, ["search", "anything", "--read-only", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hits.length, 0);
  assert.equal(parsed.index, null);
});

test("search rejects malformed limits and empty queries", () => {
  const cwd = makeProject();
  for (const value of ["1.5", "2abc", "0", "51"]) {
    const result = run(cwd, ["search", "anything", "--limit", value]);
    // Argument errors now exit with code 4 (EXIT_ARGS).
    assert.equal(result.status, 4, `limit ${value} should fail`);
    assert.match(result.stderr, /Expected an integer between 1 and 50/);
  }

  const empty = run(cwd, ["search", ""]);
  assert.equal(empty.status, 4);
  assert.match(empty.stderr, /must not be empty/);
});

test("config errors exit with code 2 and emit structured JSON under --json", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "llm-wiki-test-"));
  // No init → no config.
  const human = run(cwd, ["search", "anything"]);
  assert.equal(human.status, 2);
  const json = run(cwd, ["search", "anything", "--json"]);
  assert.equal(json.status, 2);
  const parsed = JSON.parse(json.stderr);
  assert.equal(typeof parsed.error, "object");
  assert.match(parsed.error.code, /^CONFIG_/);
});

test("relations commands import, list, approve, and expose graph search context", () => {
  const cwd = makeProject();
  writeFileSync(path.join(cwd, "wiki", "target.md"), "# Target\n\nGraph destination.\n", "utf8");
  const indexed = run(cwd, ["index"]);
  assert.equal(indexed.status, 0, indexed.stderr);
  const proposalFile = path.join(cwd, "proposals.json");
  writeFileSync(
    proposalFile,
    JSON.stringify({
      version: 1,
      proposals: [
        {
          source: "wiki/welcome.md",
          target: "wiki/target.md",
          type: "depends_on",
          confidence: 0.88,
          rationale: "Welcome depends on the graph destination.",
          evidence: { path: "wiki/welcome.md", startLine: 1, endLine: 1, text: "Welcome" },
        },
      ],
    }),
    "utf8",
  );

  const proposed = run(cwd, ["relations", "propose", "--input", proposalFile]);
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.match(proposed.stdout, /Imported 1 pending relation proposal/);
  const pending = run(cwd, ["relations", "list", "--status", "pending", "--json"]);
  assert.equal(pending.status, 0, pending.stderr);
  const proposals = JSON.parse(pending.stdout);
  assert.equal(proposals.length, 1);

  const approved = run(cwd, ["relations", "approve", String(proposals[0].id)]);
  assert.equal(approved.status, 0, approved.stderr);
  const searched = run(cwd, ["search", "Welcome", "--graph", "--json"]);
  assert.equal(searched.status, 0, searched.stderr);
  const result = JSON.parse(searched.stdout);
  assert.ok(result.graphContext.some((item) => item.relatedPath === "wiki/target.md"));
});

test("serve schema preparation upgrades a pre-graph database", () => {
  const cwd = makeProject();
  const kb = getDefaultKbConfig();
  indexFiles({ projectRoot: cwd, config: kb });
  const legacy = openDatabase({ projectRoot: cwd, loadVector: false });
  try {
    legacy.db.exec(`
      DROP TABLE document_tags;
      DROP TABLE tags;
      DROP TABLE unresolved_relation_refs;
      DROP TABLE relation_proposals;
      DROP TABLE relation_evidence;
      DROP TABLE document_relations;
      DROP TABLE relation_types;
      DROP TABLE document_sections;
      DROP TABLE documents;
      DROP TABLE schema_meta;
    `);
  } finally {
    closeConnection(legacy);
  }

  migrateKbSchema({ title: "Test", port: 0, kb }, cwd);
  const migrated = openDatabase({ projectRoot: cwd, loadVector: false });
  try {
    const row = migrated.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='documents'")
      .get();
    assert.equal(row.ok, 1);
  } finally {
    closeConnection(migrated);
  }
});

// --- P0: server-side index pipeline support -------------------------------

test("--root points the CLI at a knowledge base outside the cwd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "llm-wiki-root-"));
  // init writes config + content dir under --root, not under cwd.
  const initialized = run(tmpdir(), ["--root", root, "init", "--title", "Remote"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(existsSync(path.join(root, ".llm-wiki", "config.json")), true);
  assert.equal(existsSync(path.join(root, "wiki")), true);

  writeFileSync(path.join(root, "wiki", "note.md"), "# Note\n\nA refund rule document.\n", "utf8");
  const indexed = run(tmpdir(), ["--root", root, "index"]);
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.equal(existsSync(path.join(root, ".llm-wiki", "index.db")), true);
});

test("index --json --source-revision records provenance metadata", () => {
  const cwd = makeProject();
  writeFileSync(path.join(cwd, "wiki", "a.md"), "# A\n\nalpha content\n", "utf8");
  const result = run(cwd, [
    "index",
    "--json",
    "--source-revision",
    "deadbeef",
    "--source-branch",
    "knowledge",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.metadata.sourceRevision, "deadbeef");
  assert.equal(parsed.metadata.sourceBranch, "knowledge");
  assert.equal(parsed.metadata.schemaVersion, 3);
  assert.ok(parsed.metadata.configHash.length > 0);
  assert.ok(parsed.metadata.fileCount >= 1);
});

test("index --output-db leaves the active index untouched", () => {
  const cwd = makeProject();
  writeFileSync(path.join(cwd, "wiki", "a.md"), "# A\n\nalpha\n", "utf8");
  // Build the active index first.
  run(cwd, ["index"]);
  const activeDb = path.join(cwd, ".llm-wiki", "index.db");
  const activeMtime = statMtime(activeDb);

  // Build into a throwaway file.
  const outDb = path.join(cwd, "tmp", "candidate.db");
  const result = run(cwd, ["index", "--output-db", outDb, "--source-revision", "c0ffee", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(outDb), true);
  // Active DB was not rewritten.
  assert.equal(statMtime(activeDb), activeMtime);

  // The candidate DB is searchable and carries the recorded revision.
  const searchResult = run(cwd, ["--db", outDb, "search", "alpha", "--json"]);
  assert.equal(searchResult.status, 0, searchResult.stderr);
  const parsed = JSON.parse(searchResult.stdout);
  assert.equal(parsed.index.sourceRevision, "c0ffee");
  assert.ok(parsed.hits.length >= 1);
});

test("index --seed-db copies a previous index before incrementing", () => {
  const cwd = makeProject();
  writeFileSync(path.join(cwd, "wiki", "a.md"), "# A\n\nalpha\n", "utf8");
  run(cwd, ["index"]);
  const previous = path.join(cwd, ".llm-wiki", "index.db");

  const outDb = path.join(cwd, "tmp", "seeded.db");
  const result = run(cwd, ["index", "--seed-db", previous, "--output-db", outDb, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.metadata.fileCount >= 1);
});

test("status reports db_missing, up-to-date, and revision drift", () => {
  // Missing DB → exists:false, exit 0.
  const cwd = makeProject();
  const missing = run(cwd, ["status", "--json"]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).exists, false);

  // After indexing with a revision, status --target-revision matches.
  writeFileSync(path.join(cwd, "wiki", "a.md"), "# A\n\nalpha\n", "utf8");
  run(cwd, ["index", "--source-revision", "rev1"]);
  const current = run(cwd, ["status", "--json", "--target-revision", "rev1"]);
  assert.equal(current.status, 0, current.stderr);
  const currentParsed = JSON.parse(current.stdout);
  assert.equal(currentParsed.exists, true);
  assert.equal(currentParsed.upToDate, true);
  assert.deepEqual(currentParsed.mismatches, []);

  // A different target revision reports drift.
  const drifted = run(cwd, ["status", "--json", "--target-revision", "rev2"]);
  const driftedParsed = JSON.parse(drifted.stdout);
  assert.equal(driftedParsed.upToDate, false);
  assert.ok(driftedParsed.mismatches.includes("sourceRevision"));
});

test("validate accepts a good DB and rejects a bad one with exit code 3", () => {
  const cwd = makeProject();
  writeFileSync(path.join(cwd, "wiki", "a.md"), "# A\n\nalpha\n", "utf8");
  run(cwd, ["index"]);
  const goodDb = path.join(cwd, ".llm-wiki", "index.db");

  const good = run(cwd, ["validate", "--db", goodDb, "--json"]);
  assert.equal(good.status, 0, good.stderr);
  const goodParsed = JSON.parse(good.stdout);
  assert.equal(goodParsed.ok, true);
  assert.equal(goodParsed.checks.integrity.ok, true);
  assert.equal(goodParsed.checks.schemaVersion.actual, 3);

  // A non-DB file fails integrity and exits 3.
  const junk = path.join(cwd, "junk.db");
  writeFileSync(junk, "this is not sqlite", "utf8");
  const bad = run(cwd, ["validate", "--db", junk, "--json"]);
  assert.equal(bad.status, 3);
});

test("validate --db is required", () => {
  const cwd = makeProject();
  const result = run(cwd, ["validate", "--json"]);
  assert.notEqual(result.status, 0);
});

test("init renders skill placeholders against the configured content directory", () => {
  const cwd = makeProject();
  const writeSkill = path.join(cwd, ".agents", "skills", "kb-write-docs", "SKILL.md");
  const content = readFileSync(writeSkill, "utf8");
  // Default include is ["wiki"], so placeholders are replaced.
  assert.doesNotMatch(content, /\{\{KB_INCLUDE\}\}/);
  assert.match(content, /Organize documentation under `wiki\/` by business domain/);
});

test("kb registry resolves commands from any working directory and keeps indexes isolated", () => {
  const alpha = makeProject();
  const beta = makeProject();
  writeFileSync(path.join(alpha, "wiki", "alpha.md"), "# Alpha\n\nalphauniqueword\n", "utf8");
  writeFileSync(path.join(beta, "wiki", "beta.md"), "# Beta\n\nbetauniqueword\n", "utf8");
  run(alpha, ["index"]);
  run(beta, ["index"]);

  const registryDir = mkdtempSync(path.join(tmpdir(), "llm-wiki-registry-test-"));
  const registryPath = path.join(registryDir, "registry.json");
  const env = { LLM_WIKI_REGISTRY: registryPath };
  const addAlpha = run(tmpdir(), ["kb", "add", "alpha", alpha], env);
  const addBeta = run(tmpdir(), ["kb", "add", "beta", beta], env);
  assert.equal(addAlpha.status, 0, addAlpha.stderr);
  assert.equal(addBeta.status, 0, addBeta.stderr);

  const alphaSearch = run(tmpdir(), ["--kb", "alpha", "search", "alphauniqueword", "--json"], env);
  assert.equal(alphaSearch.status, 0, alphaSearch.stderr);
  assert.ok(JSON.parse(alphaSearch.stdout).hits.some((hit) => hit.path === "wiki/alpha.md"));

  const isolated = run(tmpdir(), ["--kb", "beta", "search", "alphauniqueword", "--json"], env);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.equal(JSON.parse(isolated.stdout).hits.length, 0);

  const validate = run(tmpdir(), ["--kb", "alpha", "validate", "--json"], env);
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).ok, true);
});

test("kb list/default/remove manage registry metadata without deleting knowledge-base files", () => {
  const root = makeProject();
  const registryDir = mkdtempSync(path.join(tmpdir(), "llm-wiki-registry-test-"));
  const env = { LLM_WIKI_REGISTRY: path.join(registryDir, "registry.json") };
  assert.equal(run(tmpdir(), ["kb", "add", "docs", root], env).status, 0);
  assert.equal(run(tmpdir(), ["kb", "default", "docs"], env).status, 0);

  const listed = run(tmpdir(), ["kb", "list", "--json"], env);
  assert.equal(listed.status, 0, listed.stderr);
  const registry = JSON.parse(listed.stdout);
  assert.equal(registry.defaultKb, "docs");
  assert.equal(registry.knowledgeBases.docs.root, root);

  const removed = run(tmpdir(), ["kb", "remove", "docs"], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(path.join(root, ".llm-wiki", "config.json")), true);
  const after = JSON.parse(run(tmpdir(), ["kb", "list", "--json"], env).stdout);
  assert.deepEqual(after.knowledgeBases, {});
  assert.equal(after.defaultKb, undefined);
});

function statMtime(file) {
  return statSync(file).mtimeMs;
}
