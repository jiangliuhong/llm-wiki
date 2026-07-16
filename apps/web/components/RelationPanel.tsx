"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DocumentNeighborhood, DocumentRelation } from "@llm-wiki/kb";

export default function RelationPanel({
  graph,
  embedded = false,
}: {
  graph: DocumentNeighborhood;
  embedded?: boolean;
}): React.ReactElement {
  const types = useMemo(
    () => [...new Set(graph.relations.map((relation) => relation.relationType))],
    [graph.relations],
  );
  const [type, setType] = useState("all");
  const visible =
    type === "all"
      ? graph.relations
      : graph.relations.filter((relation) => relation.relationType === type);
  const incoming = visible.filter((relation) => relation.targetFileId === graph.center.fileId);
  const outgoing = visible.filter((relation) => relation.sourceFileId === graph.center.fileId);

  return (
    <div className={`wiki-relations px-4 py-5 ${embedded ? "" : "h-full overflow-y-auto"}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
          Relations
        </h2>
        {types.length ? (
          <select
            aria-label="Filter relation type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="max-w-28 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-600"
          >
            <option value="all">All</option>
            {types.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <p className="mt-4 text-xs leading-5 text-slate-400">No published document relations.</p>
      ) : (
        <>
          <RelationGroup title="Upstream" relations={incoming} centerId={graph.center.fileId} />
          <RelationGroup title="Downstream" relations={outgoing} centerId={graph.center.fileId} />
          <details className="mt-5 rounded-xl border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-xs font-semibold text-indigo-700">
              Local graph
            </summary>
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[10px]">
              <div className="space-y-2">
                {incoming.map((r) => (
                  <GraphNode
                    key={r.id}
                    id={r.sourceFileId}
                    title={r.sourceTitle}
                    type={r.relationType}
                  />
                ))}
              </div>
              <div className="rounded-lg bg-indigo-600 px-2 py-2 text-center font-semibold text-white">
                {graph.center.title}
              </div>
              <div className="space-y-2">
                {outgoing.map((r) => (
                  <GraphNode
                    key={r.id}
                    id={r.targetFileId}
                    title={r.targetTitle}
                    type={r.relationType}
                  />
                ))}
              </div>
            </div>
          </details>
        </>
      )}
      {graph.center.tags.length ? (
        <div className="mt-5 flex flex-wrap gap-1">
          {graph.center.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-500"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
      {graph.tagRelated.length ? (
        <section className="mt-5">
          <h3 className="text-xs font-semibold text-slate-700">Related by tag</h3>
          <ul className="mt-2 space-y-2">
            {graph.tagRelated.map((node) => (
              <li key={node.fileId}>
                <Link
                  href={`/files/${node.fileId}`}
                  className="block rounded-lg bg-slate-50 p-2 text-xs text-indigo-700 hover:underline"
                >
                  {node.title}
                  <span className="mt-1 block text-[10px] text-slate-400">
                    {node.sharedTags.map((tag) => `#${tag}`).join(" ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RelationGroup({
  title,
  relations,
  centerId,
}: {
  title: string;
  relations: DocumentRelation[];
  centerId: number;
}): React.ReactElement | null {
  if (!relations.length) return null;
  return (
    <section className="mt-5">
      <h3 className="text-xs font-semibold text-slate-700">{title}</h3>
      <ul className="mt-2 space-y-2">
        {relations.map((relation) => {
          const outgoing = relation.sourceFileId === centerId;
          const id = outgoing ? relation.targetFileId : relation.sourceFileId;
          const path = outgoing ? relation.targetPath : relation.sourcePath;
          const best = relation.evidence[0];
          return (
            <li key={relation.id} className="rounded-lg border border-slate-100 bg-white p-2">
              <Link
                href={`/files/${id}`}
                className="block truncate text-xs font-medium text-indigo-700 hover:underline"
              >
                {path}
              </Link>
              <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-slate-400">
                <span>{relation.relationType}</span>
                <span>
                  {best?.sourceKind}
                  {best?.sourceKind === "agent" ? ` · ${(best.confidence * 100).toFixed(0)}%` : ""}
                </span>
              </div>
              {best?.rationale ? (
                <p className="mt-1 text-[10px] leading-4 text-slate-500">{best.rationale}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
function GraphNode({
  id,
  title,
  type,
}: {
  id: number;
  title: string;
  type: string;
}): React.ReactElement {
  return (
    <Link
      href={`/files/${id}`}
      title={type}
      className="block rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-slate-600 hover:border-indigo-300"
    >
      {title}
    </Link>
  );
}
