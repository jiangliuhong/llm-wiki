"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import type { KnowledgeBaseSummary } from "./AppShell";

export default function KnowledgeBaseSwitcher({
  kbId,
  knowledgeBases,
  canAdd,
}: {
  kbId: string;
  knowledgeBases: KnowledgeBaseSummary[];
  canAdd: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [initialize, setInitialize] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/kbs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: path.trim(),
          id: id.trim() || undefined,
          title: title.trim() || undefined,
          initialize,
        }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) throw new Error(data.error ?? "Failed to add knowledge base.");
      window.location.assign(`/kbs/${encodeURIComponent(data.id)}`);
    } catch (reason) {
      setError((reason as Error).message);
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <select
          aria-label="Switch knowledge base"
          value={kbId}
          onChange={(event) => router.push(`/kbs/${encodeURIComponent(event.target.value)}`)}
          className="max-w-48 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-medium text-slate-600"
        >
          {knowledgeBases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        {canAdd ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
          >
            Add knowledge base
          </button>
        ) : null}
      </div>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-kb-title"
              className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/35 p-4 sm:items-center"
            >
              <form
                onSubmit={(event) => void submit(event)}
                className="my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
              >
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6 sm:py-5">
                  <div>
                    <h2 id="add-kb-title" className="text-lg font-semibold text-slate-900">
                      Add knowledge-base path
                    </h2>
                    <p className="mt-1 text-sm leading-5 text-slate-500">
                      Register an existing project, or initialize the directory when its config is
                      missing.
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                    className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100"
                  >
                    ×
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
                  <label className="block text-xs font-semibold text-slate-600">
                    Absolute directory path
                    <input
                      required
                      autoFocus
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                      placeholder="/Users/me/projects/team-wiki"
                      className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2.5 font-mono text-sm outline-none focus:border-indigo-400"
                    />
                  </label>
                  <label className="mt-4 block text-xs font-semibold text-slate-600">
                    Title{" "}
                    <span className="font-normal text-slate-400">(used when initializing)</span>
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="Team Wiki"
                      className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-400"
                    />
                  </label>
                  <label className="mt-4 block text-xs font-semibold text-slate-600">
                    Knowledge-base ID <span className="font-normal text-slate-400">(optional)</span>
                    <input
                      value={id}
                      onChange={(event) => setId(event.target.value)}
                      placeholder="team-wiki"
                      pattern="[a-z0-9][a-z0-9._-]*"
                      className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2.5 font-mono text-sm outline-none focus:border-indigo-400"
                    />
                  </label>
                  <label className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={initialize}
                      onChange={(event) => setInitialize(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Initialize when missing
                      <span className="mt-0.5 block text-xs text-slate-400">
                        Creates the default config, an independent index database, and a wiki
                        directory.
                      </span>
                    </span>
                  </label>
                  {error ? (
                    <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                      {error}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 bg-white px-5 py-4 sm:px-6">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setOpen(false)}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !path.trim()}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {saving ? "Adding…" : "Add and switch"}
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
