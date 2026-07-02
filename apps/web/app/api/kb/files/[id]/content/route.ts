import { NextResponse, type NextRequest } from "next/server";
import { getFileContent } from "@llm-wiki/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/kb/files/:id/content
 *
 * Returns a file's full content, reassembled from its chunks (in order),
 * plus per-chunk line ranges. Used by the doc viewer to render the page.
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
    const content = getFileContent(fileId);
    if (!content) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    return NextResponse.json(content);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
