import type { Metadata, Viewport } from "next";
import TopNav from "@/components/TopNav";
import FileTree from "@/components/FileTree";
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
  return (
    <html lang="en" className="light" suppressHydrationWarning>
      <body className="h-screen overflow-hidden text-foreground antialiased">
        <div className="wiki-shell flex h-screen overflow-hidden flex-col">
          <TopNav title={wikiTitle} />
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="wiki-sidebar hidden w-72 shrink-0 md:block">
              <FileTree />
            </aside>
            <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
