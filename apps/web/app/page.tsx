import { redirect } from "next/navigation";
import { listFiles } from "@llm-wiki/kb";
import SearchResults from "@/components/SearchResults";

/**
 * Home route.
 *
 * - `?q=<query>`: render search results in the content area (triggered from
 *   the top nav search box).
 * - otherwise: jump to the first indexed file so the doc viewer is never
 *   empty. If nothing is indexed yet, show a friendly empty state.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<React.ReactElement> {
  const { q } = await searchParams;

  if (q && q.trim().length > 0) {
    return (
      <div className="h-full overflow-y-auto">
        <SearchResults query={q.trim()} />
      </div>
    );
  }

  const page = listFiles({ page: 1, pageSize: 1 });
  const first = page.files[0];
  if (first) {
    redirect(`/files/${first.id}`);
  }

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="empty-state max-w-md rounded-3xl border border-slate-200 bg-white px-8 py-10 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-sm font-bold text-indigo-600">
          MD
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          No documents indexed yet
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Run{" "}
          <code className="rounded-md bg-slate-100 px-1.5 py-1 font-mono text-xs text-indigo-700">
            llm-wiki-cli index
          </code>{" "}
          to populate the knowledge base, then refresh this page.
        </p>
      </div>
    </div>
  );
}
