"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Input, Chip } from "@heroui/react";

/**
 * Knowledge-base search UI.
 *
 * A client component that:
 *   - loads index stats on mount (/api/kb/stats)
 *   - runs a hybrid search on submit (/api/kb/search)
 *   - renders results with a `source` badge, file:line, and a preview snippet
 *
 * HeroUI v3 is headless (React Aria), so no provider wrapper is needed.
 */

interface KbStats {
  dbPath: string;
  files: number;
  chunks: number;
  ftsRecords: number;
  vectorRecords: number;
  earliestIndexedAt: string | null;
  latestIndexedAt: string | null;
  tablesOk: boolean;
  vectorEnabled: boolean;
  byLanguage: { language: string; count: number }[];
  byRoot: { root: string; count: number }[];
}

interface SearchHit {
  chunkId: number;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  source: "vector+fts" | "fts" | "vector";
  distance?: number;
  bm25?: number;
  preview: string;
}

interface SearchResult {
  query: string;
  limit: number;
  hits: SearchHit[];
  vectorEnabled: boolean;
  warning?: string;
}

export default function KbSearch(): React.ReactElement {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<KbStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/kb/stats")
      .then((r) => r.json())
      .then((data: KbStats | { error: string }) => {
        if (cancelled) return;
        if ("error" in data) {
          setStatsError(data.error);
        } else {
          setStats(data);
        }
      })
      .catch((e: Error) => !cancelled && setStatsError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb/search?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as SearchResult | { error: string };
      if (!res.ok || "error" in data) {
        setError("error" in data ? data.error : "Search failed.");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const q = query.trim();
    if (q.length === 0) return;
    setSubmitted(q);
    void runSearch(q);
  };

  const hasResults = (result?.hits.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-8">
      <StatsCard stats={stats} error={statsError} />

      <Card className="border border-default-200 bg-content1/60 backdrop-blur">
        <Card.Content className="flex flex-col gap-4 p-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the knowledge base…"
              className="flex-1 px-3 py-2"
              disabled={loading}
              aria-label="Search query"
            />
            <Button type="submit" variant="primary" size="lg" isDisabled={loading || query.trim().length === 0}>
              {loading ? "Searching…" : "Search"}
            </Button>
          </form>

          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {result?.warning ? (
            <p className="text-sm text-warning">⚠ {result.warning}</p>
          ) : null}
        </Card.Content>
      </Card>

      {submitted && !loading && !hasResults && !error ? (
        <p className="text-center text-default-500">No results for “{submitted}”.</p>
      ) : null}

      {hasResults && result ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-default-500">
            {result.hits.length} result(s){submitted ? ` for “${submitted}”` : ""}
          </h2>
          <ul className="flex flex-col gap-3">
            {result.hits.map((hit) => (
              <li key={hit.chunkId}>
                <HitCard hit={hit} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function StatsCard({ stats, error }: { stats: KbStats | null; error: string | null }): React.ReactElement {
  return (
    <Card className="border border-default-200 bg-content1/40 backdrop-blur">
      <Card.Content className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Index status</h2>
          {stats ? (
            <div className="flex items-center gap-2">
              <Chip size="sm" color={stats.tablesOk ? "success" : "default"}>
                {stats.tablesOk ? "ready" : "empty"}
              </Chip>
              <Chip size="sm" color={stats.vectorEnabled ? "accent" : "warning"}>
                {stats.vectorEnabled ? "vector on" : "vector off"}
              </Chip>
            </div>
          ) : null}
        </div>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : stats ? (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Stat label="Files" value={stats.files} />
            <Stat label="Chunks" value={stats.chunks} />
            <Stat label="FTS rows" value={stats.ftsRecords} />
            <Stat label="Vectors" value={stats.vectorRecords} />
          </div>
        ) : (
          <p className="text-sm text-default-400">Loading…</p>
        )}
        {stats ? (
          <p className="truncate font-mono text-xs text-default-400" title={stats.dbPath}>
            {stats.dbPath}
          </p>
        ) : null}
        {stats && !stats.tablesOk ? (
          <p className="text-sm text-default-500">
            No index yet. Run <code className="rounded bg-default-100 px-1.5 py-0.5">llm-wiki-cli index</code> to
            populate it.
          </p>
        ) : null}
      </Card.Content>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="flex flex-col">
      <span className="text-xl font-semibold">{value}</span>
      <span className="text-xs text-default-400">{label}</span>
    </div>
  );
}

function HitCard({ hit }: { hit: SearchHit }): React.ReactElement {
  const color =
    hit.source === "vector+fts"
      ? "success"
      : hit.source === "fts"
        ? "accent"
        : "default";
  return (
    <Card className="border border-default-200 bg-content1/60 backdrop-blur">
      <Card.Content className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-sm text-default-600">
            {hit.path}
            <span className="text-default-400">
              :{hit.startLine}-{hit.endLine}
            </span>
          </span>
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
