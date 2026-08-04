import { NextResponse, type NextRequest } from "next/server";
import { listKbContexts, loadServeManifest } from "@/app/api/_lib/kb-config";
import { addKnowledgeBaseFromPath, RegistryMutationError } from "@/app/api/_lib/registry-store";
import { guardSameOriginJson } from "@/app/api/_lib/mutation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const manifest = loadServeManifest();
  return NextResponse.json({
    knowledgeBases: listKbContexts().map(({ id, title, root }) => ({ id, title, root })),
    canAdd: Boolean(manifest?.registryPath),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const blocked = guardSameOriginJson(request);
  if (blocked) return blocked;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }
  const { id, path, title, initialize } = body as {
    id?: unknown;
    path?: unknown;
    title?: unknown;
    initialize?: unknown;
  };
  if (typeof path !== "string" || !path.trim()) {
    return NextResponse.json({ error: "Knowledge-base path is required." }, { status: 400 });
  }
  if (id !== undefined && typeof id !== "string") {
    return NextResponse.json({ error: "Knowledge-base ID must be a string." }, { status: 400 });
  }
  if (title !== undefined && typeof title !== "string") {
    return NextResponse.json({ error: "Knowledge-base title must be a string." }, { status: 400 });
  }
  if (initialize !== undefined && typeof initialize !== "boolean") {
    return NextResponse.json({ error: "initialize must be a boolean." }, { status: 400 });
  }
  try {
    const entry = addKnowledgeBaseFromPath({
      id: typeof id === "string" ? id : undefined,
      root: path.trim(),
      title: typeof title === "string" ? title : undefined,
      initialize: initialize ?? true,
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    const status = error instanceof RegistryMutationError ? error.status : 500;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}
