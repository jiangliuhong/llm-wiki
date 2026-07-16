import { notFound } from "next/navigation";
import { getFileContent, getFileDetail } from "@llm-wiki/kb";
import DocContent from "@/components/DocContent";
import TableOfContents from "@/components/TableOfContents";

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

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <DocContent
          path={content.path}
          language={content.language}
          indexedAt={indexedAt}
          content={content.content}
        />
      </div>
      <aside className="wiki-toc hidden w-64 shrink-0 overflow-hidden xl:block">
        <TableOfContents markdown={content.content} />
      </aside>
    </div>
  );
}
