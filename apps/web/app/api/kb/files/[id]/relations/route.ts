import { NextResponse, type NextRequest } from "next/server";
import { getDocumentRelations } from "@llm-wiki/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const fileId = Number(id);
  if (!Number.isInteger(fileId) || fileId <= 0)
    return NextResponse.json({ error: "File id must be a positive integer." }, { status: 400 });
  const direction = request.nextUrl.searchParams.get("direction") ?? "both";
  if (!["incoming", "outgoing", "both"].includes(direction))
    return NextResponse.json({ error: "Invalid relation direction." }, { status: 400 });
  try {
    return NextResponse.json(
      getDocumentRelations(fileId, {
        direction: direction as "incoming" | "outgoing" | "both",
        type: request.nextUrl.searchParams.get("type") ?? undefined,
      }),
    );
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
