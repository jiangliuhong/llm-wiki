"use client";

import { usePathname } from "next/navigation";
import TopNav from "./TopNav";
import FileTree from "./FileTree";

export interface KnowledgeBaseSummary {
  id: string;
  title: string;
}

export default function AppShell({
  children,
  knowledgeBases,
  defaultKb,
  canAdd,
}: {
  children: React.ReactNode;
  knowledgeBases: KnowledgeBaseSummary[];
  defaultKb: string;
  canAdd: boolean;
}): React.ReactElement {
  const pathname = usePathname();
  const routeKb = pathname?.match(/^\/kbs\/([^/]+)/)?.[1];
  const kbId = routeKb && knowledgeBases.some((item) => item.id === routeKb) ? routeKb : defaultKb;
  const selected = knowledgeBases.find((item) => item.id === kbId) ?? knowledgeBases[0];

  return (
    <div className="wiki-shell flex h-screen overflow-hidden flex-col">
      <TopNav
        title={selected?.title ?? "LLM Wiki"}
        kbId={kbId}
        knowledgeBases={knowledgeBases}
        canAdd={canAdd}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="wiki-sidebar hidden w-72 shrink-0 md:block">
          <FileTree kbId={kbId} />
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
