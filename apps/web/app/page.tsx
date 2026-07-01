import KbSearch from "@/components/KbSearch";

/**
 * Home page — knowledge-base search.
 *
 * The CLI sets `NEXT_PUBLIC_WIKI_TITLE` before booting Next.js (see
 * `packages/cli/src/services/next-server.ts`); we fall back to a sensible
 * default when the app is run standalone (e.g. `pnpm --filter web dev`).
 */
const wikiTitle = process.env.NEXT_PUBLIC_WIKI_TITLE ?? "LLLM Wiki";

export default function HomePage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col items-center gap-3 text-center">
        <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
          {wikiTitle}
        </span>
        <h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          Knowledge Base Search
        </h1>
        <p className="text-balance text-default-500">
          Search your local wiki with hybrid full-text + vector retrieval.
        </p>
      </header>

      <KbSearch />

      <footer className="mt-auto pt-8 text-center text-sm text-default-400">
        Next.js 16 · HeroUI v3 · SQLite FTS5 + sqlite-vec
      </footer>
    </main>
  );
}
