import { NextResponse, type NextRequest } from "next/server";
import { getFileDetail } from "@llm-wiki/kb";
import { loadKbContext } from "../../../_lib/kb-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/kb/files/:id
 *
 * Returns a file's metadata plus a summary list of its chunks.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const fileId = Number.parseInt(id, 10);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    return NextResponse.json({ error: "File id must be a positive integer." }, { status: 400 });
  }

  try {
    const context = loadKbContext();
    const detail = getFileDetail(fileId, { projectRoot: context.root, dbPath: context.dbPath });
    if (!detail) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
