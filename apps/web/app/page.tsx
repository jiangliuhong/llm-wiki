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
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">No documents indexed yet</h1>
        <p className="mt-2 text-default-500">
          Run <code className="rounded bg-default-100 px-1.5 py-0.5">llm-wiki-cli index</code> to
          populate the knowledge base, then refresh this page.
        </p>
      </div>
    </div>
  );
}
