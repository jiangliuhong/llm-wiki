import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import TopNav from "@/components/TopNav";
import FileTree from "@/components/FileTree";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <html lang="en" className={`${inter.variable} light`} suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex min-h-screen flex-col">
          <TopNav title={wikiTitle} />
          <div className="flex flex-1 overflow-hidden">
            <aside className="hidden w-64 shrink-0 border-r border-default-200 bg-content1/40 md:block">
              <FileTree />
            </aside>
            <div className="flex-1 overflow-hidden">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
