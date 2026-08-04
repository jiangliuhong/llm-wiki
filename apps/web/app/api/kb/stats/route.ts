import { NextResponse } from "next/server";
import { getKbStats } from "@llm-wiki/kb";
import { loadKbContext } from "../../_lib/kb-config";

// Native SQLite addons cannot run in the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/kb/stats
 *
 * Returns aggregated index health/volume metrics for the local knowledge base.
 * Safe before any index has run (returns zeros + tablesOk=false).
 */
export async function GET(): Promise<Response> {
  try {
    const context = loadKbContext();
    const stats = getKbStats({
      projectRoot: context.root,
      dbPath: context.dbPath,
      loadVector: context.enabled,
    });
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
