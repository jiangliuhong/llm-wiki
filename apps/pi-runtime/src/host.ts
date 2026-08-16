import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ReadOnlyTool } from "./protocol.js";

interface WorkspaceManifest {
  version: 1;
  id: string;
  title: string;
  root: string;
  createdAt: string;
}

export interface HostToolContext {
  workspaceId: string;
  workspaceRoot: string;
}

export type HostToolHandler = (
  input: Record<string, unknown>,
  context: HostToolContext,
) => Promise<unknown> | unknown;

export type HostToolRegistry = Partial<Record<ReadOnlyTool, HostToolHandler>>;

export function createDefaultHostTools(): HostToolRegistry {
  return {
    workspace_get: (_input, context) => {
      const manifest = readManifest(context.workspaceRoot);
      return manifest ? { ...manifest, root: context.workspaceRoot } : { id: context.workspaceId, root: context.workspaceRoot };
    },
    workspace_status: (_input, context) => ({
      workspaceId: context.workspaceId,
      runtime: "pi-runtime",
      core: "rust-contract-ready",
      storage: "sqlite-adapter-pending",
    }),
    document_list: (input, context) => withDb(context.workspaceRoot, (db) => {
      const limit = Number(input.limit ?? 50);
      return db
        .prepare(
          `SELECT f.id AS fileId, f.path, f.language, d.title, d.slug
             FROM files f LEFT JOIN documents d ON d.file_id = f.id
            ORDER BY f.path LIMIT ?`,
        )
        .all(limit);
    }),
    document_search: (input, context) => withDb(context.workspaceRoot, (db) => {
      const query = String(input.query ?? "").trim();
      if (!query) throw new Error("query must not be empty");
      const limit = Number(input.limit ?? 20);
      const terms = query
        .split(/\s+/)
        .map((term) => term.replace(/["*()]/g, ""))
        .filter(Boolean)
        .map((term) => `"${term}"*`);
      if (terms.length === 0) throw new Error("query has no usable terms");
      const rows = db
        .prepare(
          `SELECT c.id AS chunkId, c.file_id AS fileId, f.path, d.title,
                  c.start_line, c.end_line, c.content, bm25(chunks_fts) AS rank
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             JOIN files  f ON f.id = c.file_id
             LEFT JOIN documents d ON d.file_id = f.id
            WHERE chunks_fts MATCH ?
            ORDER BY rank LIMIT ?`,
        )
        .all(terms.join(" OR "), limit);
      return rows.map((row) => ({ ...row, preview: makePreview(String(row.content), query) }));
    }),
    document_read: (input, context) => withDb(context.workspaceRoot, (db) => {
      const file = requireFile(db, input);
      const doc = db
        .prepare("SELECT title, slug, summary, body FROM documents WHERE file_id = ?")
        .get(file.fileId) as { title: string; slug: string; summary: string | null; body: string } | undefined;
      const body =
        doc?.body ??
        (db.prepare("SELECT content FROM chunks WHERE file_id = ? ORDER BY chunk_index").all(file.fileId) as { content: string }[])
          .map((chunk) => chunk.content)
          .join("\n");
      return { ...file, title: doc?.title ?? null, summary: doc?.summary ?? null, content: body };
    }),
    document_read_range: (input, context) => withDb(context.workspaceRoot, (db) => {
      const file = requireFile(db, input);
      const start = Number(input.startLine ?? 1);
      const end = Number(input.endLine ?? start);
      return {
        ...file,
        startLine: start,
        endLine: end,
        content: (db
          .prepare(
            "SELECT content FROM chunks WHERE file_id = ? AND end_line >= ? AND start_line <= ? ORDER BY chunk_index",
          )
          .all(file.fileId, start, end) as { content: string }[])
          .map((chunk) => chunk.content)
          .join("\n"),
      };
    }),
    document_relations: (input, context) => withDb(context.workspaceRoot, (db) => {
      const file = requireFile(db, input);
      const rows = db
        .prepare(
          `SELECT r.relation_type, sf.path AS sourcePath, tf.path AS targetPath, r.updated_at
             FROM document_relations r
             JOIN files sf ON sf.id = r.source_file_id
             JOIN files tf ON tf.id = r.target_file_id
            WHERE r.source_file_id = ? OR r.target_file_id = ?`,
        )
        .all(file.fileId, file.fileId);
      return { ...file, relations: rows };
    }),
    document_neighborhood: (input, context) => withDb(context.workspaceRoot, (db) => {
      const file = requireFile(db, input);
      const depth = Math.min(Math.max(Number(input.depth ?? 1), 1), 3);
      let frontier = [file.fileId];
      const visited = new Set<number>(frontier);
      const edges: Array<{ relationType: string; sourcePath: string; targetPath: string; depth: number }> = [];
      for (let level = 1; level <= depth; level += 1) {
        if (frontier.length === 0) break;
        const placeholders = frontier.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT r.relation_type, r.source_file_id, r.target_file_id, sf.path AS sourcePath, tf.path AS targetPath
               FROM document_relations r
               JOIN files sf ON sf.id = r.source_file_id
               JOIN files tf ON tf.id = r.target_file_id
              WHERE r.source_file_id IN (${placeholders}) OR r.target_file_id IN (${placeholders})`,
          )
          .all(...frontier, ...frontier) as Array<{
            relation_type: string;
            source_file_id: number;
            target_file_id: number;
            sourcePath: string;
            targetPath: string;
          }>;
        const next: number[] = [];
        for (const row of rows) {
          edges.push({ relationType: row.relation_type, sourcePath: row.sourcePath, targetPath: row.targetPath, depth: level });
          for (const id of [row.source_file_id, row.target_file_id]) {
            if (!visited.has(id)) {
              visited.add(id);
              next.push(id);
            }
          }
        }
        frontier = next;
      }
      return { ...file, depth, edges, documentCount: visited.size };
    }),
  };
}

function indexDbPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".llm-wiki", "index.db");
}

function withDb<T>(workspaceRoot: string, run: (db: DatabaseSync) => T): T {
  const path = indexDbPath(workspaceRoot);
  if (!existsSync(path)) {
    throw new Error("工作区尚未建立索引（缺少 .llm-wiki/index.db）。请先在设置中运行索引。");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function requireFile(db: DatabaseSync, input: Record<string, unknown>): { fileId: number; path: string; language: string } {
  const row = input.fileId
    ? db.prepare("SELECT id, path, language FROM files WHERE id = ?").get(Number(input.fileId))
    : input.path
      ? db.prepare("SELECT id, path, language FROM files WHERE path = ?").get(String(input.path))
      : undefined;
  if (!row) throw new Error("未找到对应文档，请用 document_list/document_search 先定位 fileId 或 path。");
  const file = row as { id: number; path: string; language: string };
  return { fileId: file.id, path: file.path, language: file.language };
}

function makePreview(content: string, query: string, radius = 60): string {
  const index = content.indexOf(query.split(/\s+/)[0] ?? "");
  if (index < 0) return content.slice(0, radius * 2).trim();
  return content.slice(Math.max(0, index - radius), index + radius).trim();
}

function readManifest(root: string): WorkspaceManifest | null {
  const path = resolve(root, ".llm-wiki", "workspace.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkspaceManifest;
    return value.version === 1 && value.id && value.title ? value : null;
  } catch {
    return null;
  }
}
