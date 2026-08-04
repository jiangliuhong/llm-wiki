import { NextResponse, type NextRequest } from "next/server";
import { MAX_SEARCH_LIMIT, searchKnowledgeBase } from "@llm-wiki/kb";
import { loadKbContext } from "../../_lib/kb-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;

/**
 * GET /api/kb/search?q=<query>&limit=<n>
 *
 * Runs a hybrid (vector + FTS) search and returns ranked hits.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length === 0) {
    return NextResponse.json({ error: "Missing required query parameter 'q'." }, { status: 400 });
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    if (!/^[1-9]\d*$/.test(limitParam)) {
      return NextResponse.json(
        { error: `'limit' must be an integer between 1 and ${MAX_SEARCH_LIMIT}.` },
        { status: 400 },
      );
    }
    const parsed = Number(limitParam);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_SEARCH_LIMIT) {
      return NextResponse.json(
        { error: `'limit' must be an integer between 1 and ${MAX_SEARCH_LIMIT}.` },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  try {
    const context = loadKbContext();
    const result = searchKnowledgeBase(q, {
      projectRoot: context.root,
      dbPath: context.dbPath,
      dimensions: context.dimensions,
      enableVector: context.enabled,
      limit,
      graph: { enabled: true, perSeedLimit: 3 },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
