"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input, Button } from "@heroui/react";

/**
 * Persistent top navigation bar.
 *
 * Shows the wiki title on the left and a search box that, on submit, pushes
 * to `/?q=<query>` so the home route can render `<SearchResults />` in the
 * content area. Kept intentionally lightweight — the heavy lifting (fetching
 * results) lives in `SearchResults`.
 */
export default function TopNav({ title }: { title: string }): React.ReactElement {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const q = query.trim();
    if (q.length === 0) {
      router.push("/");
    } else {
      router.push(`/?q=${encodeURIComponent(q)}`);
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-default-200 bg-content1/80 px-4 backdrop-blur">
      <a
        href="/"
        className="flex shrink-0 items-center gap-2 font-semibold text-foreground"
        aria-label={`${title} — home`}
      >
        <span
          aria-hidden
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground"
        >
          {title.charAt(0).toUpperCase()}
        </span>
        <span className="hidden sm:inline">{title}</span>
      </a>

      <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-xl items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the knowledge base…"
          aria-label="Search query"
          className="flex-1 h-9 text-sm"
        />
        <Button type="submit" variant="primary" size="sm" isDisabled={query.trim().length === 0}>
          Search
        </Button>
      </form>
    </header>
  );
}
