import type { Metadata, Viewport } from "next";
import AppShell from "@/components/AppShell";
import { getDefaultKbId, listKbContexts, loadServeManifest } from "@/app/api/_lib/kb-config";
import "./globals.css";

/**
 * Root layout for the LLM Wiki web app — a persistent three-panel doc viewer:
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ TopNav  (logo · search · status)              │
 *   ├───────────┬───────────────────────────────────┤
 *   │ FileTree  │  {children}  (doc content / TOC)  │
 *   └───────────┴───────────────────────────────────┘
 *
 * The CLI sets `NEXT_PUBLIC_WIKI_TITLE` before booting Next.js (see
 * `packages/cli/src/services/next-server.ts`); we fall back to a sensible
 * default when the app is run standalone (e.g. `pnpm --filter web dev`).
 *
 * The shell forces a light theme (`className="light"` on <html>) to match the
 * reference design. HeroUI v3 is headless (built on React Aria) and does not
 * require a provider wrapper.
 */
const wikiTitle = process.env.NEXT_PUBLIC_WIKI_TITLE ?? "LLM Wiki";

// The CLI injects the Wiki title at server startup. Keep the shell dynamic so
// routes such as the client-rendered relation review page do not freeze the
// build-time fallback title into their prerendered HTML.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: wikiTitle,
  description: "Local AI Wiki Platform — powered by Next.js and HeroUI.",
};

export const viewport: Viewport = {
  themeColor: "#f8fafc",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  const knowledgeBases = listKbContexts().map(({ id, title }) => ({ id, title }));
  const defaultKb = getDefaultKbId();
  const canAdd = Boolean(loadServeManifest()?.registryPath);
  return (
    <html lang="en" className="light" suppressHydrationWarning>
      <body className="h-screen overflow-hidden text-foreground antialiased">
        <AppShell knowledgeBases={knowledgeBases} defaultKb={defaultKb} canAdd={canAdd}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
