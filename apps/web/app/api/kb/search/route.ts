import { NextResponse, type NextRequest } from "next/server";
import { searchKnowledgeBase } from "@llm-wiki/kb";
import { loadDimensions } from "../../_lib/kb-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/**
 * GET /api/kb/search?q=<query>&limit=<n>
 *
 * Runs a hybrid (vector + FTS) search and returns ranked hits.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length === 0) {
    return NextResponse.json(
      { error: "Missing required query parameter 'q'." },
      { status: 400 },
    );
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "'limit' must be a positive integer." },
        { status: 400 },
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const result = searchKnowledgeBase(q, { dimensions: loadDimensions(), limit });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
