"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input, Button } from "@heroui/react";
import type { KnowledgeBaseSummary } from "./AppShell";
import KnowledgeBaseSwitcher from "./KnowledgeBaseSwitcher";

/**
 * Persistent top navigation bar.
 *
 * Shows the wiki title on the left and a search box that, on submit, pushes
 * to `/?q=<query>` so the home route can render `<SearchResults />` in the
 * content area. Kept intentionally lightweight — the heavy lifting (fetching
 * results) lives in `SearchResults`.
 */
export default function TopNav({
  title,
  kbId,
  knowledgeBases,
  canAdd,
}: {
  title: string;
  kbId: string;
  knowledgeBases: KnowledgeBaseSummary[];
  canAdd: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const q = query.trim();
    if (q.length === 0) {
      router.push(`/kbs/${encodeURIComponent(kbId)}`);
    } else {
      router.push(`/kbs/${encodeURIComponent(kbId)}?q=${encodeURIComponent(q)}`);
    }
  };

  return (
    <header className="wiki-header sticky top-0 z-30 flex h-16 shrink-0 items-center gap-4 px-4 md:px-6">
      <a
        href={`/kbs/${encodeURIComponent(kbId)}`}
        className="wiki-brand flex shrink-0 items-center gap-3 text-foreground"
        aria-label={`${title} — home`}
      >
        <span
          aria-hidden
          className="wiki-logo inline-flex h-9 w-9 items-center justify-center text-sm font-bold"
        >
          {title.charAt(0).toUpperCase()}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-48 truncate text-sm font-semibold leading-tight">
            {title}
          </span>
          <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
            Knowledge base
          </span>
        </span>
      </a>

      <KnowledgeBaseSwitcher kbId={kbId} knowledgeBases={knowledgeBases} canAdd={canAdd} />

      <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-2xl items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documents…"
          aria-label="Search query"
          className="wiki-search h-10 flex-1 text-sm"
        />
        <Button type="submit" variant="primary" size="sm" isDisabled={query.trim().length === 0}>
          Search
        </Button>
      </form>
      <a
        href={`/kbs/${encodeURIComponent(kbId)}/relations/review`}
        className="hidden shrink-0 text-xs font-semibold text-slate-500 hover:text-indigo-700 sm:block"
      >
        Review relations
      </a>
    </header>
  );
}
