import { notFound, redirect } from "next/navigation";
import { listFiles } from "@llm-wiki/kb";
import SearchResults from "@/components/SearchResults";
import { loadKbContext } from "@/app/api/_lib/kb-config";

export default async function KnowledgeBasePage({
  params,
  searchParams,
}: {
  params: Promise<{ kbId: string }>;
  searchParams: Promise<{ q?: string }>;
}): Promise<React.ReactElement> {
  const { kbId } = await params;
  const { q } = await searchParams;
  let context;
  try {
    context = loadKbContext(kbId);
  } catch {
    notFound();
  }

  if (q?.trim()) {
    return (
      <div className="h-full overflow-y-auto">
        <SearchResults query={q.trim()} kbId={kbId} />
      </div>
    );
  }

  const page = listFiles({
    projectRoot: context.root,
    dbPath: context.dbPath,
    page: 1,
    pageSize: 1,
  });
  const first = page.files[0];
  if (first) redirect(`/kbs/${encodeURIComponent(kbId)}/files/${first.id}`);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="empty-state max-w-md rounded-3xl border border-slate-200 bg-white px-8 py-10 text-center shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          No documents indexed yet
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Run <code>llm-wiki --workspace {kbId} index</code>, then refresh this page.
        </p>
      </div>
    </div>
  );
}
