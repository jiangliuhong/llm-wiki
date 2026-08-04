import { NextResponse } from "next/server";

/** Rejects cross-origin or form-compatible writes to the local Wiki. */
export function guardSameOriginJson(request: Request): Response | null {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const requestHost = request.headers.get("host") ?? requestUrl.host;
  const sameOrigin = (() => {
    try {
      const originUrl = new URL(origin ?? "");
      return originUrl.protocol === requestUrl.protocol && originUrl.host === requestHost;
    } catch {
      return false;
    }
  })();
  if (!sameOrigin) {
    return NextResponse.json(
      { error: "Cross-origin relation updates are not allowed." },
      { status: 403 },
    );
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return NextResponse.json(
      { error: "Relation updates require application/json." },
      { status: 415 },
    );
  }
  return null;
}
