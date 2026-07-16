import { NextResponse, type NextRequest } from "next/server";
import { getDocumentNeighborhood } from "@llm-wiki/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const fileId = Number(request.nextUrl.searchParams.get("fileId"));
  const depth = Number(request.nextUrl.searchParams.get("depth") ?? "1");
  if (!Number.isInteger(fileId) || fileId <= 0)
    return NextResponse.json({ error: "fileId must be a positive integer." }, { status: 400 });
  if (!Number.isInteger(depth) || depth < 1 || depth > 3)
    return NextResponse.json({ error: "depth must be between 1 and 3." }, { status: 400 });
  try {
    const graph = getDocumentNeighborhood(fileId, depth);
    return graph
      ? NextResponse.json(graph)
      : NextResponse.json({ error: "Document not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
