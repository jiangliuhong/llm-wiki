import type { Database as DatabaseType } from "better-sqlite3";
import {
  closeConnection,
  openDatabase,
  withReadonlyDb,
  type OpenOptions,
} from "./db/connection.js";
import { initSchema } from "./db/init.js";
import { normalizeRelationType } from "./document-parser.js";
import type {
  DocumentGraphNode,
  DocumentNeighborhood,
  DocumentRelation,
  GraphSearchContext,
  RelationDiagnostic,
  RelationDirection,
  RelationEvidence,
  RelationProposal,
  RelationProposalStatus,
} from "./types.js";

interface RelationRow {
  id: number;
  sourceFileId: number;
  sourcePath: string;
  sourceTitle: string;
  targetFileId: number;
  targetPath: string;
  targetTitle: string;
  relationType: string;
  symmetric: number;
}

export interface GetRelationsOptions extends OpenOptions {
  direction?: RelationDirection;
  type?: string;
}

export function getDocumentRelations(
  fileId: number,
  options: GetRelationsOptions = {},
): DocumentRelation[] {
  assertPositiveId(fileId, "fileId");
  return withReadonlyDb(options, (conn) =>
    queryRelations(conn.db, fileId, options.direction ?? "both", options.type),
  );
}

export function getDocumentNeighborhood(
  fileId: number,
  depth = 1,
  options: OpenOptions = {},
): DocumentNeighborhood | null {
  assertPositiveId(fileId, "fileId");
  if (!Number.isInteger(depth) || depth < 1 || depth > 3)
    throw new Error("Graph depth must be between 1 and 3.");
  return withReadonlyDb(options, (conn) => {
    const center = queryNode(conn.db, fileId);
    if (!center) return null;
    const nodes = new Map<number, DocumentGraphNode>([[fileId, center]]);
    const relations = new Map<number, DocumentRelation>();
    let frontier = new Set([fileId]);
    for (let level = 0; level < depth; level++) {
      const next = new Set<number>();
      for (const current of frontier) {
        for (const relation of queryRelations(conn.db, current, "both")) {
          relations.set(relation.id, relation);
          for (const relatedId of [relation.sourceFileId, relation.targetFileId]) {
            if (!nodes.has(relatedId)) {
              const node = queryNode(conn.db, relatedId);
              if (node) nodes.set(relatedId, node);
              next.add(relatedId);
            }
          }
        }
      }
      frontier = next;
    }
    const tagRelated = queryTagRelated(conn.db, center);
    return {
      center,
      nodes: [...nodes.values()],
      relations: [...relations.values()],
      tagRelated,
      depth,
    };
  });
}

export interface RelationProposalInput {
  source: string;
  target: string;
  type: string;
  confidence: number;
  rationale: string;
  evidence: { path: string; startLine: number; endLine: number; text?: string };
}

export interface RelationProposalFile {
  version: 1;
  proposals: RelationProposalInput[];
}

export function createRelationProposals(
  input: RelationProposalFile,
  options: OpenOptions = {},
): RelationProposal[] {
  if (input.version !== 1 || !Array.isArray(input.proposals))
    throw new Error("Proposal file must use version 1 and contain a proposals array.");
  const conn = openDatabase({ ...options, readonly: false, loadVector: false });
  try {
    initSchema(conn, 1536);
    const insert = conn.db.prepare(
      `INSERT INTO relation_proposals
       (source_file_id, target_file_id, source_path, target_path, relation_type, confidence,
        rationale, evidence_path, evidence_start_line, evidence_end_line, evidence_text, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`,
    );
    const find = conn.db.prepare<[string], { id: number }>("SELECT id FROM files WHERE path = ?");
    const ids: number[] = [];
    const tx = conn.db.transaction(() => {
      for (const proposal of input.proposals) {
        validateProposal(proposal);
        const sourceId = find.get(proposal.source)?.id ?? null;
        const targetId = find.get(proposal.target)?.id ?? null;
        const row = insert.get(
          sourceId,
          targetId,
          proposal.source,
          proposal.target,
          normalizeRelationType(proposal.type),
          proposal.confidence,
          proposal.rationale.trim(),
          proposal.evidence.path,
          proposal.evidence.startLine,
          proposal.evidence.endLine,
          proposal.evidence.text?.trim() || null,
          new Date().toISOString(),
        ) as { id: number } | undefined;
        if (row) ids.push(row.id);
      }
    });
    tx();
    return listRelationProposals(undefined, { ...options }).filter((proposal) =>
      ids.includes(proposal.id),
    );
  } finally {
    closeConnection(conn);
  }
}

export function listRelationProposals(
  status?: RelationProposalStatus,
  options: OpenOptions = {},
): RelationProposal[] {
  if (status && !["pending", "approved", "rejected", "invalid"].includes(status))
    throw new Error(`Unknown proposal status: ${status}`);
  return withReadonlyDb(options, (conn) => {
    const where = status ? "WHERE status = ?" : "";
    return conn.db
      .prepare(
        `SELECT id, source_file_id AS sourceFileId, target_file_id AS targetFileId,
              source_path AS sourcePath, target_path AS targetPath, relation_type AS relationType,
              confidence, rationale, evidence_path AS evidencePath,
              evidence_start_line AS evidenceStartLine, evidence_end_line AS evidenceEndLine,
              evidence_text AS evidenceText, status, created_at AS createdAt, reviewed_at AS reviewedAt
         FROM relation_proposals ${where} ORDER BY id DESC`,
      )
      .all(...(status ? [status] : [])) as RelationProposal[];
  });
}

export function approveRelationProposal(id: number, options: OpenOptions = {}): RelationProposal {
  return reviewProposal(id, "approved", options);
}
export function rejectRelationProposal(id: number, options: OpenOptions = {}): RelationProposal {
  return reviewProposal(id, "rejected", options);
}

export function listRelationDiagnostics(options: OpenOptions = {}): RelationDiagnostic[] {
  return withReadonlyDb(
    options,
    (conn) =>
      conn.db
        .prepare(
          `SELECT u.id, u.source_file_id AS sourceFileId, u.source_path AS sourcePath,
            u.relation_type AS relationType, u.source_kind AS sourceKind,
            u.original_target AS originalTarget, u.start_line AS startLine, u.reason
       FROM unresolved_relation_refs u ORDER BY u.source_path, u.start_line`,
        )
        .all() as RelationDiagnostic[],
  );
}

export function getGraphSearchContext(
  seedFileIds: number[],
  options: OpenOptions & { perSeedLimit?: number } = {},
): GraphSearchContext[] {
  const limit = Math.max(1, Math.min(10, options.perSeedLimit ?? 3));
  return withReadonlyDb(options, (conn) => {
    const result: GraphSearchContext[] = [];
    for (const seedFileId of [...new Set(seedFileIds)]) {
      const relations = queryRelations(conn.db, seedFileId, "both").slice(0, limit);
      for (const relation of relations) {
        const outgoing = relation.sourceFileId === seedFileId;
        result.push({
          seedFileId,
          seedPath: outgoing ? relation.sourcePath : relation.targetPath,
          relatedFileId: outgoing ? relation.targetFileId : relation.sourceFileId,
          relatedPath: outgoing ? relation.targetPath : relation.sourcePath,
          relatedTitle: outgoing ? relation.targetTitle : relation.sourceTitle,
          relationType: relation.relationType,
          direction: outgoing ? "outgoing" : "incoming",
          evidence: relation.evidence,
        });
      }
    }
    return result;
  });
}

function reviewProposal(
  id: number,
  status: "approved" | "rejected",
  options: OpenOptions,
): RelationProposal {
  assertPositiveId(id, "proposal id");
  const conn = openDatabase({ ...options, readonly: false, loadVector: false });
  try {
    initSchema(conn, 1536);
    let invalid = false;
    const tx = conn.db.transaction(() => {
      const proposal = conn.db.prepare("SELECT * FROM relation_proposals WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!proposal) throw new Error(`Relation proposal ${id} was not found.`);
      if (proposal.status !== "pending")
        throw new Error(`Relation proposal ${id} is already ${String(proposal.status)}.`);
      if (status === "rejected") {
        conn.db
          .prepare("UPDATE relation_proposals SET status='rejected', reviewed_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        return;
      }
      const sourceId = proposal.source_file_id as number | null;
      const targetId = proposal.target_file_id as number | null;
      if (!sourceId || !targetId) {
        conn.db
          .prepare("UPDATE relation_proposals SET status='invalid', reviewed_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        invalid = true;
        return;
      }
      const type = normalizeRelationType(String(proposal.relation_type));
      conn.db
        .prepare(
          `INSERT INTO relation_types(name, display_name, inverse_name, symmetric, core) VALUES (?, ?, NULL, 0, 0) ON CONFLICT(name) DO NOTHING`,
        )
        .run(type, type);
      const now = new Date().toISOString();
      const relation = conn.db
        .prepare(
          `INSERT INTO document_relations(source_file_id, target_file_id, relation_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_file_id, target_file_id, relation_type)
         DO UPDATE SET updated_at=excluded.updated_at RETURNING id`,
        )
        .get(sourceId, targetId, type, now, now) as { id: number };
      conn.db
        .prepare(
          `INSERT OR IGNORE INTO relation_evidence
         (relation_id, source_kind, original_target, source_path, start_line, end_line, evidence_text, rationale, confidence)
         VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relation.id,
          proposal.target_path,
          proposal.evidence_path,
          proposal.evidence_start_line,
          proposal.evidence_end_line,
          proposal.evidence_text,
          proposal.rationale,
          proposal.confidence,
        );
      conn.db
        .prepare("UPDATE relation_proposals SET status='approved', reviewed_at=? WHERE id=?")
        .run(now, id);
    });
    tx();
    if (invalid)
      throw new Error("Proposal source or target no longer exists; it was marked invalid.");
    const reviewed = listRelationProposals(undefined, options).find(
      (proposal) => proposal.id === id,
    );
    if (!reviewed) throw new Error(`Relation proposal ${id} disappeared after review.`);
    return reviewed;
  } finally {
    closeConnection(conn);
  }
}

function queryRelations(
  db: DatabaseType,
  fileId: number,
  direction: RelationDirection,
  type?: string,
): DocumentRelation[] {
  const clauses: string[] = [];
  const params: Array<number | string> = [];
  if (direction === "incoming") {
    clauses.push("r.target_file_id = ?");
    params.push(fileId);
  } else if (direction === "outgoing") {
    clauses.push("r.source_file_id = ?");
    params.push(fileId);
  } else {
    clauses.push("(r.source_file_id = ? OR r.target_file_id = ?)");
    params.push(fileId, fileId);
  }
  if (type) {
    clauses.push("r.relation_type = ?");
    params.push(normalizeRelationType(type));
  }
  const rows = db
    .prepare(
      `SELECT r.id, r.source_file_id AS sourceFileId, sf.path AS sourcePath, sd.title AS sourceTitle,
            r.target_file_id AS targetFileId, tf.path AS targetPath, td.title AS targetTitle,
            r.relation_type AS relationType, rt.symmetric
       FROM document_relations r
       JOIN files sf ON sf.id=r.source_file_id JOIN documents sd ON sd.file_id=sf.id
       JOIN files tf ON tf.id=r.target_file_id JOIN documents td ON td.file_id=tf.id
       JOIN relation_types rt ON rt.name=r.relation_type
      WHERE ${clauses.join(" AND ")} ORDER BY r.relation_type, sf.path, tf.path`,
    )
    .all(...params) as RelationRow[];
  return rows.map((row) => ({
    ...row,
    direction: row.sourceFileId === fileId ? "outgoing" : "incoming",
    symmetric: row.symmetric === 1,
    evidence: queryEvidence(db, row.id),
  }));
}

function queryEvidence(db: DatabaseType, relationId: number): RelationEvidence[] {
  return db
    .prepare(
      `SELECT id, source_kind AS sourceKind, original_target AS originalTarget, source_path AS sourcePath,
            start_line AS startLine, end_line AS endLine, evidence_text AS evidenceText,
            rationale, confidence FROM relation_evidence WHERE relation_id=? ORDER BY id`,
    )
    .all(relationId) as RelationEvidence[];
}

function queryNode(db: DatabaseType, fileId: number): DocumentGraphNode | null {
  const row = db
    .prepare(
      `SELECT f.id AS fileId, f.path, d.title, d.slug FROM files f JOIN documents d ON d.file_id=f.id WHERE f.id=?`,
    )
    .get(fileId) as Omit<DocumentGraphNode, "tags"> | undefined;
  if (!row) return null;
  const tags = db
    .prepare(
      `SELECT t.name FROM tags t JOIN document_tags dt ON dt.tag_id=t.id WHERE dt.file_id=? ORDER BY t.name`,
    )
    .all(fileId) as Array<{ name: string }>;
  return { ...row, tags: tags.map((tag) => tag.name) };
}

function validateProposal(value: RelationProposalInput): void {
  if (!value || typeof value !== "object") throw new Error("Each proposal must be an object.");
  if (!value.source?.trim() || !value.target?.trim() || !value.type?.trim())
    throw new Error("Proposal source, target, and type are required.");
  assertSafeProjectPath(value.source, "Proposal source");
  assertSafeProjectPath(value.target, "Proposal target");
  if (!(value.confidence > 0 && value.confidence <= 1))
    throw new Error("Proposal confidence must be greater than 0 and at most 1.");
  if (!value.rationale?.trim()) throw new Error("Proposal rationale is required.");
  if (
    !value.evidence?.path?.trim() ||
    !Number.isInteger(value.evidence.startLine) ||
    !Number.isInteger(value.evidence.endLine) ||
    value.evidence.startLine < 1 ||
    value.evidence.endLine < value.evidence.startLine
  )
    throw new Error("Proposal evidence must contain a path and valid line range.");
  assertSafeProjectPath(value.evidence.path, "Proposal evidence path");
}
function assertPositiveId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer.`);
}
function assertSafeProjectPath(value: string, label: string): void {
  if (value.includes("\\")) throw new Error(`${label} must use POSIX separators.`);
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    /^[A-Za-z]:\//.test(normalized)
  )
    throw new Error(`${label} must be a repository-relative path.`);
}

function queryTagRelated(
  db: DatabaseType,
  center: DocumentGraphNode,
): Array<DocumentGraphNode & { sharedTags: string[] }> {
  if (!center.tags.length) return [];
  const rows = db
    .prepare(
      `SELECT f.id AS fileId, f.path, d.title, d.slug, t.name AS tag
       FROM document_tags mine
       JOIN document_tags other ON other.tag_id=mine.tag_id AND other.file_id<>mine.file_id
       JOIN tags t ON t.id=mine.tag_id
       JOIN files f ON f.id=other.file_id JOIN documents d ON d.file_id=f.id
      WHERE mine.file_id=? ORDER BY f.path, t.name`,
    )
    .all(center.fileId) as Array<Omit<DocumentGraphNode, "tags"> & { tag: string }>;
  const grouped = new Map<number, DocumentGraphNode & { sharedTags: string[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.fileId);
    if (existing) {
      existing.tags.push(row.tag);
      existing.sharedTags.push(row.tag);
    } else
      grouped.set(row.fileId, {
        fileId: row.fileId,
        path: row.path,
        title: row.title,
        slug: row.slug,
        tags: [row.tag],
        sharedTags: [row.tag],
      });
  }
  return [...grouped.values()];
}
