import { NextResponse, type NextRequest } from "next/server";
import { getChunkDetail } from "@llm-wiki/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/kb/chunks/:id
 *
 * Returns the full content of a single chunk.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const chunkId = Number.parseInt(id, 10);
  if (!Number.isFinite(chunkId) || chunkId <= 0) {
    return NextResponse.json({ error: "Chunk id must be a positive integer." }, { status: 400 });
  }

  try {
    const chunk = getChunkDetail(chunkId);
    if (!chunk) {
      return NextResponse.json({ error: "Chunk not found." }, { status: 404 });
    }
    return NextResponse.json(chunk);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
