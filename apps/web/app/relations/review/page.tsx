"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { DocumentRelation, RelationProposal, RelationProposalStatus } from "@llm-wiki/kb";

export default function RelationReviewPage({
  kbId = "default",
}: { kbId?: string } = {}): React.ReactElement {
  const [status, setStatus] = useState<RelationProposalStatus>("pending");
  const [proposals, setProposals] = useState<RelationProposal[]>([]);
  const [conflicts, setConflicts] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    const apiBase = `/api/kbs/${encodeURIComponent(kbId)}`;
    const response = await fetch(`${apiBase}/relations/proposals?status=${status}`);
    const data = (await response.json()) as RelationProposal[] | { error: string };
    if (!response.ok || "error" in data)
      throw new Error("error" in data ? data.error : "Failed to load proposals.");
    setProposals(data);
    const nextConflicts = new Set<number>();
    await Promise.all(
      data.map(async (proposal) => {
        if (!proposal.sourceFileId || !proposal.targetFileId) return;
        const relations = (await fetch(
          `${apiBase}/files/${proposal.sourceFileId}/relations?direction=outgoing&type=${encodeURIComponent(proposal.relationType)}`,
        ).then((r) => r.json())) as DocumentRelation[];
        if (relations.some((relation) => relation.targetFileId === proposal.targetFileId))
          nextConflicts.add(proposal.id);
      }),
    );
    setConflicts(nextConflicts);
  }, [status, kbId]);

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message));
  }, [load]);

  const review = async (id: number, action: "approve" | "reject"): Promise<void> => {
    setBusy(id);
    try {
      const response = await fetch(
        `/api/kbs/${encodeURIComponent(kbId)}/relations/proposals/${id}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Failed to ${action} proposal.`);
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">
          Knowledge graph
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Relation proposals</h1>
        <p className="mt-2 text-sm text-slate-500">
          Agent-inferred edges remain outside the graph until approved.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          {(["pending", "approved", "rejected", "invalid"] as RelationProposalStatus[]).map(
            (item) => (
              <button
                key={item}
                onClick={() => setStatus(item)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${status === item ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}
              >
                {item}
              </button>
            ),
          )}
        </div>
        {error ? (
          <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
        ) : null}
        {proposals.length === 0 ? (
          <p className="mt-10 rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">
            No {status} proposals.
          </p>
        ) : (
          <ul className="mt-6 space-y-4">
            {proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <DocLink id={proposal.sourceFileId} path={proposal.sourcePath} kbId={kbId} />
                  <span className="rounded-full bg-indigo-50 px-2 py-1 font-mono text-xs text-indigo-700">
                    {proposal.relationType}
                  </span>
                  <span aria-hidden>→</span>
                  <DocLink id={proposal.targetFileId} path={proposal.targetPath} kbId={kbId} />
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                      Rationale
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-slate-700">{proposal.rationale}</p>
                  </div>
                  <div>
                    <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                      Evidence
                    </h2>
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      {proposal.evidencePath}:{proposal.evidenceStartLine}-
                      {proposal.evidenceEndLine}
                    </p>
                    {proposal.evidenceText ? (
                      <blockquote className="mt-2 border-l-2 border-indigo-200 pl-3 text-sm text-slate-600">
                        {proposal.evidenceText}
                      </blockquote>
                    ) : null}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div className="text-xs text-slate-500">
                    Confidence {(proposal.confidence * 100).toFixed(0)}%{" "}
                    {conflicts.has(proposal.id) ? (
                      <span className="ml-2 font-semibold text-amber-600">
                        Existing edge · approval will merge evidence
                      </span>
                    ) : null}
                  </div>
                  {proposal.status === "pending" ? (
                    <div className="flex gap-2">
                      <button
                        disabled={busy === proposal.id}
                        onClick={() => review(proposal.id, "reject")}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        disabled={busy === proposal.id}
                        onClick={() => review(proposal.id, "approve")}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs font-semibold text-slate-500">{proposal.status}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function DocLink({
  id,
  path,
  kbId,
}: {
  id: number | null;
  path: string;
  kbId: string;
}): React.ReactElement {
  return id ? (
    <Link
      href={`/kbs/${encodeURIComponent(kbId)}/files/${id}`}
      className="font-medium text-indigo-700 hover:underline"
    >
      {path}
    </Link>
  ) : (
    <span className="font-medium text-red-600" title="Document is missing">
      {path}
    </span>
  );
}
