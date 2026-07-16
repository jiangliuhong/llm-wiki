import { NextResponse } from "next/server";
import { rejectRelationProposal } from "@llm-wiki/kb";
import { guardSameOriginJson } from "../../../../../_lib/mutation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const blocked = guardSameOriginJson(request);
  if (blocked) return blocked;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "Proposal id must be a positive integer." }, { status: 400 });
  try {
    return NextResponse.json(rejectRelationProposal(id));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}
