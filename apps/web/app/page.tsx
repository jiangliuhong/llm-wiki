import { redirect } from "next/navigation";
import { getDefaultKbId } from "@/app/api/_lib/kb-config";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<never> {
  const { q } = await searchParams;
  const suffix = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  redirect(`/kbs/${encodeURIComponent(getDefaultKbId())}${suffix}`);
}
