import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  closeConnection,
  getDefaultKbConfig,
  indexFiles,
  openDatabase,
} from "@llm-wiki/kb";
import { migrateKbSchema } from "../dist/commands/serve.js";

const cli = path.resolve("dist/index.js");

function makeProject() {
  const cwd = mkdtempSync(path.join(tmpdir(), "llm-wiki-cli-test-"));
  const initialized = run(cwd, ["init", "--title", "Test"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("init installs the bundled project skills", () => {
  const cwd = makeProject();

  for (const skill of ["kb-write-docs", "kb-search-docs", "kb-infer-relations"]) {
    const skillFile = path.join(cwd, ".agents", "skills", skill, "SKILL.md");
    const metadataFile = path.join(cwd, ".agents", "skills", skill, "agents", "openai.yaml");
    assert.equal(existsSync(skillFile), true);
    assert.equal(existsSync(metadataFile), true);
    assert.match(readFileSync(skillFile, "utf8"), new RegExp(`name: ${skill}`));
  }
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
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unable to open database file/);
  assert.doesNotMatch(result.stderr, /at openDatabase/);
});

test("search rejects malformed limits and empty queries", () => {
  const cwd = makeProject();
  for (const value of ["1.5", "2abc", "0", "51"]) {
    const result = run(cwd, ["search", "anything", "--limit", value]);
    assert.equal(result.status, 1, `limit ${value} should fail`);
    assert.match(result.stderr, /Expected an integer between 1 and 50/);
  }

  const empty = run(cwd, ["search", ""]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /must not be empty/);
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
