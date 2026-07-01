# Architecture

The platform is a pnpm monorepo with three layers:

- `apps/web` — Next.js + HeroUI web UI.
- `packages/cli` — the `llm-wiki-cli` command-line tool (init, index, search, serve).
- `packages/kb` — the knowledge-base core: scanner, chunker, indexer, and search.

Search is hybrid: it combines BM25 full-text ranking with vector similarity.
The vector store uses sqlite-vec when the native extension is available;
otherwise it gracefully falls back to FTS only.
