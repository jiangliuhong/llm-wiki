import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_SEARCH_LIMIT,
  approveRelationProposal,
  getChunkDetail,
  getDocumentNeighborhood,
  getDocumentRelations,
  getFileContent,
  getFileDetail,
  getKbStats,
  listFiles,
  listRelationProposals,
  rejectRelationProposal,
  searchKnowledgeBase,
  type RelationProposalStatus,
} from "@llm-wiki/kb";
import { loadKbContext } from "@/app/api/_lib/kb-config";
import { guardSameOriginJson } from "@/app/api/_lib/mutation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = Promise<{ kbId: string; resource: string[] }>;

export async function GET(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<Response> {
  const { kbId, resource } = await params;
  try {
    const context = loadKbContext(kbId);
    const db = { projectRoot: context.root, dbPath: context.dbPath };
    const [kind, id, child] = resource;

    if (kind === "search" && resource.length === 1) {
      const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
      if (!query)
        return NextResponse.json(
          { error: "Missing required query parameter 'q'." },
          { status: 400 },
        );
      const limit = parseBoundedInt(request.nextUrl.searchParams.get("limit"), 8, MAX_SEARCH_LIMIT);
      if (limit === null)
        return NextResponse.json(
          { error: `'limit' must be an integer between 1 and ${MAX_SEARCH_LIMIT}.` },
          { status: 400 },
        );
      return NextResponse.json(
        searchKnowledgeBase(query, {
          ...db,
          dimensions: context.dimensions,
          enableVector: context.enabled,
          limit,
          graph: { enabled: true, perSeedLimit: 3 },
        }),
      );
    }

    if (kind === "stats" && resource.length === 1) {
      return NextResponse.json(getKbStats({ ...db, loadVector: context.enabled }));
    }

    if (kind === "files" && resource.length === 1) {
      const page = parseBoundedInt(request.nextUrl.searchParams.get("page"), 1, 1_000_000);
      const pageSize = parseBoundedInt(request.nextUrl.searchParams.get("pageSize"), 50, 500);
      if (page === null || pageSize === null)
        return NextResponse.json(
          { error: "page and pageSize must be positive integers." },
          { status: 400 },
        );
      return NextResponse.json(
        listFiles({ ...db, page, pageSize, q: request.nextUrl.searchParams.get("q") ?? undefined }),
      );
    }

    const numericId = parsePositiveId(id);
    if (kind === "files" && numericId !== null && resource.length === 2) {
      const detail = getFileDetail(numericId, db);
      return detail
        ? NextResponse.json(detail)
        : NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    if (kind === "files" && numericId !== null && child === "content") {
      const content = getFileContent(numericId, db);
      return content
        ? NextResponse.json(content)
        : NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    if (kind === "files" && numericId !== null && child === "relations") {
      const direction = request.nextUrl.searchParams.get("direction") ?? "both";
      if (!isDirection(direction))
        return NextResponse.json({ error: "Invalid relation direction." }, { status: 400 });
      return NextResponse.json(
        getDocumentRelations(numericId, {
          ...db,
          direction,
          type: request.nextUrl.searchParams.get("type") ?? undefined,
        }),
      );
    }
    if (kind === "chunks" && numericId !== null && resource.length === 2) {
      const chunk = getChunkDetail(numericId, db);
      return chunk
        ? NextResponse.json(chunk)
        : NextResponse.json({ error: "Chunk not found." }, { status: 404 });
    }
    if (kind === "graph" && resource.length === 1) {
      const fileId = parsePositiveId(request.nextUrl.searchParams.get("fileId"));
      const depth = parseBoundedInt(request.nextUrl.searchParams.get("depth"), 1, 3);
      if (fileId === null || depth === null)
        return NextResponse.json({ error: "fileId and depth are invalid." }, { status: 400 });
      const graph = getDocumentNeighborhood(fileId, depth, db);
      return graph
        ? NextResponse.json(graph)
        : NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
    if (kind === "relations" && id === "proposals" && resource.length === 2) {
      const status = request.nextUrl.searchParams.get("status") ?? "pending";
      if (!isProposalStatus(status))
        return NextResponse.json({ error: "Invalid proposal status." }, { status: 400 });
      return NextResponse.json(listRelationProposals(status, db));
    }
    return NextResponse.json({ error: "Knowledge-base endpoint not found." }, { status: 404 });
  } catch (error) {
    const status = (error as Error).message.startsWith("Unknown knowledge base") ? 404 : 500;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<Response> {
  const blocked = guardSameOriginJson(request);
  if (blocked) return blocked;
  const { kbId, resource } = await params;
  try {
    const context = loadKbContext(kbId);
    const db = { projectRoot: context.root, dbPath: context.dbPath };
    const [relations, proposals, rawId, action] = resource;
    const id = parsePositiveId(rawId);
    if (relations !== "relations" || proposals !== "proposals" || id === null) {
      return NextResponse.json({ error: "Knowledge-base endpoint not found." }, { status: 404 });
    }
    if (action === "approve") return NextResponse.json(approveRelationProposal(id, db));
    if (action === "reject") return NextResponse.json(rejectRelationProposal(id, db));
    return NextResponse.json({ error: "Unknown proposal action." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}

function parsePositiveId(value: string | null | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoundedInt(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  const parsed = parsePositiveId(value);
  return parsed !== null && parsed <= max ? parsed : null;
}

function isDirection(value: string): value is "incoming" | "outgoing" | "both" {
  return ["incoming", "outgoing", "both"].includes(value);
}

function isProposalStatus(value: string): value is RelationProposalStatus {
  return ["pending", "approved", "rejected", "invalid"].includes(value);
}
