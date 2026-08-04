import { notFound } from "next/navigation";
import { getDocumentNeighborhood, getFileContent, getFileDetail } from "@llm-wiki/kb";
import DocContent from "@/components/DocContent";
import TableOfContents from "@/components/TableOfContents";
import RelationPanel from "@/components/RelationPanel";
import { loadKbContext } from "@/app/api/_lib/kb-config";

export default async function KnowledgeBaseFilePage({
  params,
}: {
  params: Promise<{ kbId: string; id: string }>;
}): Promise<React.ReactElement> {
  const { kbId, id } = await params;
  const fileId = Number.parseInt(id, 10);
  if (!Number.isFinite(fileId) || fileId <= 0) notFound();
  let context;
  try {
    context = loadKbContext(kbId);
  } catch {
    notFound();
  }
  const db = { projectRoot: context.root, dbPath: context.dbPath };
  const content = getFileContent(fileId, db);
  if (!content) notFound();
  const detail = getFileDetail(fileId, db);
  const graph = getDocumentNeighborhood(fileId, 1, db);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <DocContent
          path={content.path}
          language={content.language}
          indexedAt={detail?.file.indexedAt ?? null}
          content={content.content}
        />
        {graph ? (
          <div className="border-t border-slate-200 xl:hidden">
            <RelationPanel graph={graph} embedded kbId={kbId} />
          </div>
        ) : null}
      </div>
      <aside className="wiki-toc hidden w-72 shrink-0 overflow-hidden xl:flex xl:flex-col">
        <div className="max-h-1/2 overflow-hidden">
          <TableOfContents markdown={content.content} />
        </div>
        {graph ? (
          <div className="min-h-0 flex-1 border-t border-slate-200">
            <RelationPanel graph={graph} kbId={kbId} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}
