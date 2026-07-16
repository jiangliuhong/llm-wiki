import { notFound } from "next/navigation";
import { getDocumentNeighborhood, getFileContent, getFileDetail } from "@llm-wiki/kb";
import DocContent from "@/components/DocContent";
import TableOfContents from "@/components/TableOfContents";
import RelationPanel from "@/components/RelationPanel";

/**
 * Document viewer route: `/files/[id]`.
 *
 * Reads the file's full content server-side (the web app shares the KB
 * package, which opens a read-only SQLite connection in-process), then
 * renders the markdown in the center panel and a table of contents on the
 * right. The layout already provides the top nav + file tree.
 */
export default async function FilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const fileId = Number.parseInt(id, 10);
  if (!Number.isFinite(fileId) || fileId <= 0) notFound();

  const content = getFileContent(fileId);
  if (!content) notFound();

  // indexedAt lives on the file-detail row; fetch cheaply for the header.
  const detail = getFileDetail(fileId);
  const indexedAt = detail?.file.indexedAt ?? null;
  const graph = getDocumentNeighborhood(fileId, 1);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <DocContent
          path={content.path}
          language={content.language}
          indexedAt={indexedAt}
          content={content.content}
        />
        {graph ? (
          <div className="border-t border-slate-200 xl:hidden">
            <RelationPanel graph={graph} embedded />
          </div>
        ) : null}
      </div>
      <aside className="wiki-toc hidden w-72 shrink-0 overflow-hidden xl:flex xl:flex-col">
        <div className="max-h-1/2 overflow-hidden">
          <TableOfContents markdown={content.content} />
        </div>
        {graph ? (
          <div className="min-h-0 flex-1 border-t border-slate-200">
            <RelationPanel graph={graph} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}
