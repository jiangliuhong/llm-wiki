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
export default function SearchResults({ query }: { query: string }): React.ReactElement {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/kb/search?q=${encodeURIComponent(query)}`)
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
  }, [query]);

  if (loading) {
    return <p className="px-6 py-12 text-center text-default-400">Searching…</p>;
  }
  if (error) {
    return <p className="px-6 py-12 text-center text-danger">{error}</p>;
  }
  if (!result || result.hits.length === 0) {
    return (
      <p className="px-6 py-12 text-center text-default-500">No results for “{query}”.</p>
    );
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-xl font-semibold">
        {result.hits.length} result(s) for “{query}”
      </h1>
      {result.warning ? (
        <p className="mb-4 text-sm text-warning">⚠ {result.warning}</p>
      ) : null}
      <ul className="mt-4 flex flex-col gap-3">
        {result.hits.map((hit) => (
          <li key={hit.chunkId}>
            <HitCard hit={hit} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HitCard({ hit }: { hit: SearchHit }): React.ReactElement {
  const color =
    hit.source === "vector+fts" ? "success" : hit.source === "fts" ? "accent" : "default";
  return (
    <Card className="border border-default-200 bg-content1/60 backdrop-blur">
      <Card.Content className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={`/files/${hit.fileId}`}
            className="font-mono text-sm text-primary hover:underline"
          >
            {hit.path}
            <span className="text-default-400">
              :{hit.startLine}-{hit.endLine}
            </span>
          </Link>
          <Chip size="sm" color={color}>
            {hit.source}
          </Chip>
        </div>
        <p className="text-sm text-default-700">{hit.preview}</p>
        <div className="flex gap-4 font-mono text-xs text-default-400">
          {hit.distance !== undefined ? <span>distance {hit.distance.toFixed(4)}</span> : null}
          {hit.bm25 !== undefined ? <span>bm25 {hit.bm25.toFixed(4)}</span> : null}
        </div>
      </Card.Content>
    </Card>
  );
}
