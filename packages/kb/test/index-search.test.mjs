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
  getDocumentRelations,
  getDocumentNeighborhood,
  createRelationProposals,
  approveRelationProposal,
  rejectRelationProposal,
  listRelationDiagnostics,
  listRelationProposals,
  getFileContent,
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
  assert.throws(() => searchKnowledgeBase("   ", { dimensions: 1536 }), /must not be empty/);
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

test("an unavailable include root preserves deterministic relations", () => {
  const projectRoot = makeProject(
    "---\nrelations:\n  - type: depends_on\n    target: ./target.md\n---\n# Welcome\n",
  );
  writeFileSync(path.join(projectRoot, "wiki", "target.md"), "# Target\n", "utf8");
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  const source = listFiles({ projectRoot, pageSize: 10 }).files.find(
    (file) => file.path === "wiki/welcome.md",
  );
  assert.ok(source);
  assert.equal(getDocumentRelations(source.id, { projectRoot }).length, 1);

  renameSync(path.join(projectRoot, "wiki"), path.join(projectRoot, "wiki-offline"));
  indexFiles({ projectRoot, config });
  assert.equal(getDocumentRelations(source.id, { projectRoot }).length, 1);
});

test("indexes frontmatter, markdown links, wikilinks, tags, sections, and exact document body", () => {
  const projectRoot = makeProject(
    [
      "---",
      "title: Welcome Architecture",
      "tags: [architecture, SQLite]",
      "relations:",
      "  - type: depends_on",
      "    target: ./storage.md",
      "  - type: domain specific relation",
      "    target: ./missing.md",
      "---",
      "# Welcome",
      "",
      "See [Storage](./storage.md#schema) and [[Operations]].",
    ].join("\n"),
  );
  writeFileSync(
    path.join(projectRoot, "wiki", "storage.md"),
    "---\ntags: [architecture]\n---\n# Storage\n\nSQLite schema.\n",
    "utf8",
  );
  writeFileSync(
    path.join(projectRoot, "wiki", "ops.md"),
    "---\ntitle: Operations\n---\n# Ops\n",
    "utf8",
  );
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });

  const files = listFiles({ projectRoot, pageSize: 10 }).files;
  const welcome = files.find((file) => file.path === "wiki/welcome.md");
  assert.ok(welcome);
  const body = getFileContent(welcome.id, { projectRoot });
  assert.equal(body.content.startsWith("# Welcome"), true);
  assert.equal(body.content.includes("title: Welcome Architecture"), false);

  const relations = getDocumentRelations(welcome.id, { projectRoot, direction: "outgoing" });
  assert.deepEqual(
    new Set(relations.map((relation) => relation.relationType)),
    new Set(["depends_on", "references"]),
  );
  const storageReferences = relations.filter(
    (relation) => relation.targetPath === "wiki/storage.md",
  );
  assert.equal(storageReferences.length, 2);
  assert.ok(
    storageReferences.some((relation) => relation.evidence[0]?.sourceKind === "frontmatter"),
  );
  assert.ok(
    storageReferences.some((relation) => relation.evidence[0]?.sourceKind === "markdown_link"),
  );

  const graph = getDocumentNeighborhood(welcome.id, 1, { projectRoot });
  assert.ok(graph);
  assert.deepEqual(graph.center.tags, ["SQLite", "architecture"]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.tagRelated[0]?.path, "wiki/storage.md");
  assert.deepEqual(graph.tagRelated[0]?.sharedTags, ["architecture"]);

  const diagnostics = listRelationDiagnostics({ projectRoot });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].relationType, "domain_specific_relation");
  assert.equal(diagnostics[0].reason, "target_not_found");
});

test("agent proposals require review and approved edges participate in graph search", () => {
  const projectRoot = makeProject("# Welcome\n\nSearchable release checklist.\n");
  writeFileSync(
    path.join(projectRoot, "wiki", "release.md"),
    "# Release\n\nDeployment contract.\n",
    "utf8",
  );
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  const files = listFiles({ projectRoot, pageSize: 10 }).files;
  const source = files.find((file) => file.path === "wiki/welcome.md");
  const target = files.find((file) => file.path === "wiki/release.md");
  assert.ok(source && target);

  const [proposal] = createRelationProposals(
    {
      version: 1,
      proposals: [
        {
          source: source.path,
          target: target.path,
          type: "implements",
          confidence: 0.9,
          rationale: "The checklist governs the release contract.",
          evidence: {
            path: source.path,
            startLine: 3,
            endLine: 3,
            text: "Searchable release checklist.",
          },
        },
      ],
    },
    { projectRoot },
  );
  assert.ok(proposal);
  assert.equal(getDocumentRelations(source.id, { projectRoot }).length, 0);
  assert.equal(listRelationProposals("pending", { projectRoot }).length, 1);

  approveRelationProposal(proposal.id, { projectRoot });
  const relations = getDocumentRelations(source.id, { projectRoot });
  assert.equal(relations.length, 1);
  assert.equal(relations[0].evidence[0].sourceKind, "agent");
  const result = searchKnowledgeBase("release", {
    projectRoot,
    dimensions: config.embedding.dimensions,
    graph: true,
  });
  assert.ok(result.graphContext?.some((context) => context.relatedFileId === target.id));
  assert.throws(() => approveRelationProposal(proposal.id, { projectRoot }), /already approved/);

  const [rejected] = createRelationProposals(
    {
      version: 1,
      proposals: [
        {
          source: source.path,
          target: target.path,
          type: "extends",
          confidence: 0.7,
          rationale: "Alternative relationship for review.",
          evidence: { path: source.path, startLine: 1, endLine: 1 },
        },
      ],
    },
    { projectRoot },
  );
  rejectRelationProposal(rejected.id, { projectRoot });
  assert.equal(listRelationProposals("rejected", { projectRoot }).length, 1);
});

test("reset rebinds approved proposals and restores their Agent evidence", () => {
  const projectRoot = makeProject("# Welcome\n");
  writeFileSync(path.join(projectRoot, "wiki", "target.md"), "# Target\n", "utf8");
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  const files = listFiles({ projectRoot, pageSize: 10 }).files;
  const source = files.find((file) => file.path === "wiki/welcome.md");
  const target = files.find((file) => file.path === "wiki/target.md");
  assert.ok(source && target);
  const [proposal] = createRelationProposals(
    {
      version: 1,
      proposals: [
        {
          source: source.path,
          target: target.path,
          type: "implements",
          confidence: 0.92,
          rationale: "Approved evidence must survive a reset.",
          evidence: { path: source.path, startLine: 1, endLine: 1, text: "Welcome" },
        },
      ],
    },
    { projectRoot },
  );
  approveRelationProposal(proposal.id, { projectRoot });

  indexFiles({ projectRoot, config, reset: true });
  const rebound = listRelationProposals("approved", { projectRoot })[0];
  assert.ok(rebound?.sourceFileId && rebound.targetFileId);
  const relations = getDocumentRelations(rebound.sourceFileId, { projectRoot });
  assert.equal(relations.length, 1);
  assert.equal(relations[0].evidence[0].sourceKind, "agent");
});

test("approving an existing edge merges Agent and explicit evidence", () => {
  const projectRoot = makeProject(
    "---\nrelations:\n  - type: depends_on\n    target: ./target.md\n---\n# Welcome\n",
  );
  writeFileSync(path.join(projectRoot, "wiki", "target.md"), "# Target\n", "utf8");
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  const files = listFiles({ projectRoot, pageSize: 10 }).files;
  const source = files.find((file) => file.path === "wiki/welcome.md");
  const target = files.find((file) => file.path === "wiki/target.md");
  assert.ok(source && target);
  const [proposal] = createRelationProposals(
    {
      version: 1,
      proposals: [
        {
          source: source.path,
          target: target.path,
          type: "depends_on",
          confidence: 0.86,
          rationale: "Adds Agent rationale to the explicit dependency.",
          evidence: { path: source.path, startLine: 6, endLine: 6, text: "Welcome" },
        },
      ],
    },
    { projectRoot },
  );
  approveRelationProposal(proposal.id, { projectRoot });
  const [relation] = getDocumentRelations(source.id, { projectRoot });
  assert.deepEqual(
    new Set(relation.evidence.map((evidence) => evidence.sourceKind)),
    new Set(["frontmatter", "agent"]),
  );
});

test("an unresolved explicit relation resolves when its target is later added", () => {
  const projectRoot = makeProject(
    "---\nrelations:\n  - type: depends_on\n    target: ./later.md\n---\n# Welcome\n",
  );
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  assert.equal(listRelationDiagnostics({ projectRoot }).length, 1);
  writeFileSync(path.join(projectRoot, "wiki", "later.md"), "# Later\n", "utf8");
  indexFiles({ projectRoot, config });
  assert.equal(listRelationDiagnostics({ projectRoot }).length, 0);
  const source = listFiles({ projectRoot, pageSize: 10 }).files.find(
    (file) => file.path === "wiki/welcome.md",
  );
  assert.ok(source);
  assert.equal(getDocumentRelations(source.id, { projectRoot, direction: "outgoing" }).length, 1);
});

test("proposal import rejects paths outside the repository", () => {
  const projectRoot = makeProject();
  indexFiles({ projectRoot, config: getDefaultKbConfig() });
  assert.throws(
    () =>
      createRelationProposals(
        {
          version: 1,
          proposals: [
            {
              source: "../secret.md",
              target: "wiki/welcome.md",
              type: "references",
              confidence: 0.8,
              rationale: "Unsafe path.",
              evidence: { path: "wiki/welcome.md", startLine: 1, endLine: 1 },
            },
          ],
        },
        { projectRoot },
      ),
    /repository-relative/,
  );
});

test("an existing pre-graph database upgrades without rebuilding chunks", () => {
  const projectRoot = makeProject();
  const config = getDefaultKbConfig();
  indexFiles({ projectRoot, config });
  const conn = openDatabase({ projectRoot, loadVector: false });
  try {
    conn.db.exec(`
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
    closeConnection(conn);
  }
  const upgraded = indexFiles({ projectRoot, config });
  assert.equal(upgraded.skipped, 1);
  const file = listFiles({ projectRoot }).files[0];
  assert.ok(file);
  assert.match(getFileContent(file.id, { projectRoot }).content, /Welcome/);
});
