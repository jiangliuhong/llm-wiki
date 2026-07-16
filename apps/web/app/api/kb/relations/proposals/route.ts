import { NextResponse, type NextRequest } from "next/server";
import { listRelationProposals, type RelationProposalStatus } from "@llm-wiki/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "rejected", "invalid"].includes(status))
    return NextResponse.json({ error: "Invalid proposal status." }, { status: 400 });
  try {
    return NextResponse.json(listRelationProposals(status as RelationProposalStatus));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
