import { NextResponse, type NextRequest } from "next/server";
import { listFiles } from "@llm-wiki/kb";
import { loadKbContext } from "../../_lib/kb-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/kb/files?page=<n>&pageSize=<n>&q=<path-filter>
 *
 * Returns a paginated list of indexed files.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const pageParam = params.get("page");
  const pageSizeParam = params.get("pageSize");
  const q = params.get("q") ?? undefined;

  let page = 1;
  let pageSize = 50;
  if (pageParam !== null) {
    const parsed = Number.parseInt(pageParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json({ error: "'page' must be a positive integer." }, { status: 400 });
    }
    page = parsed;
  }
  if (pageSizeParam !== null) {
    const parsed = Number.parseInt(pageSizeParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "'pageSize' must be a positive integer." },
        { status: 400 },
      );
    }
    pageSize = parsed;
  }

  try {
    const context = loadKbContext();
    const result = listFiles({
      projectRoot: context.root,
      dbPath: context.dbPath,
      page,
      pageSize,
      q,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
