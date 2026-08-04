"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Chip } from "@heroui/react";
import type { SearchHit, SearchResult } from "@llm-wiki/kb";

/**
 * Search results view, rendered in the content area when the home route
 * receives a `?q=` query (triggered from `<TopNav />`).
 *
 * Fetches `/api/kb/search?q=<query>` and renders ranked hits. Hit cards link
 * to the file's doc view; the search leg is kept identical to the old
 * single-page search UI.
 */
export default function SearchResults({
  query,
  kbId,
}: {
  query: string;
  kbId: string;
}): React.ReactElement {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/kbs/${encodeURIComponent(kbId)}/search?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((data: SearchResult | { error: string }) => {
        if (cancelled) return;
        if ("error" in data) {
          setError(data.error);
          setResult(null);
        } else {
          setResult(data);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query, kbId]);

  if (loading) {
    return <p className="px-6 py-16 text-center text-slate-400">Searching…</p>;
  }
  if (error) {
    return <p className="px-6 py-12 text-center text-danger">{error}</p>;
  }
  if (!result || result.hits.length === 0) {
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xl text-slate-400">
          ⌕
        </div>
        <h1 className="font-semibold text-slate-800">No results found</h1>
        <p className="mt-1 text-sm text-slate-500">We couldn&apos;t find anything for “{query}”.</p>
      </div>
    );
  }

  return (
    <section className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8 lg:px-12">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">
        Search results
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">“{query}”</h1>
      <p className="mt-1 text-sm text-slate-500">{result.hits.length} matching passages</p>
      {result.warning ? <p className="mb-4 text-sm text-warning">⚠ {result.warning}</p> : null}
      <ul className="mt-7 flex flex-col gap-4">
        {result.hits.map((hit) => (
          <li key={hit.chunkId}>
            <HitCard hit={hit} kbId={kbId} />
          </li>
        ))}
      </ul>
      {result.graphContext?.length ? (
        <section className="mt-10 border-t border-slate-200 pt-7">
          <h2 className="text-sm font-semibold text-slate-800">
            Related through the document graph
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {result.graphContext.map((item, index) => (
              <li
                key={`${item.seedFileId}-${item.relatedFileId}-${item.relationType}-${index}`}
                className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3"
              >
                <Link
                  href={`/kbs/${encodeURIComponent(kbId)}/files/${item.relatedFileId}`}
                  className="text-sm font-medium text-indigo-700 hover:underline"
                >
                  {item.relatedTitle}
                </Link>
                <p className="mt-1 text-xs text-slate-500">
                  {item.seedPath} · {item.relationType} · {item.direction}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function HitCard({ hit, kbId }: { hit: SearchHit; kbId: string }): React.ReactElement {
  const color =
    hit.source === "vector+fts" ? "success" : hit.source === "fts" ? "accent" : "default";
  return (
    <Card className="search-card border border-slate-200/80 bg-white">
      <Card.Content className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={`/kbs/${encodeURIComponent(kbId)}/files/${hit.fileId}`}
            className="font-mono text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
          >
            {hit.path}
            <span className="text-slate-400">
              :{hit.startLine}-{hit.endLine}
            </span>
          </Link>
          <Chip size="sm" color={color}>
            {hit.source}
          </Chip>
        </div>
        <p className="text-sm leading-6 text-slate-600">{hit.preview}</p>
        <div className="flex gap-4 border-t border-slate-100 pt-3 font-mono text-[11px] text-slate-400">
          {hit.distance !== undefined ? <span>distance {hit.distance.toFixed(4)}</span> : null}
          {hit.bm25 !== undefined ? <span>bm25 {hit.bm25.toFixed(4)}</span> : null}
        </div>
      </Card.Content>
    </Card>
  );
}
