"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Input } from "@heroui/react";
import type { KbFileSummary } from "@llm-wiki/kb";

/**
 * Left-rail file browser.
 *
 * Fetches the flat file list from `/api/kb/files`, builds a nested tree from
 * the slash-separated paths (e.g. `wiki/foo.md` → folder `wiki` > file
 * `foo.md`), renders collapsible folders, and links each file to its
 * `/files/[id]` route. The active file is derived from the current pathname
 * and highlighted.
 */

interface TreeNode {
  /** Folder name, or null for a file leaf's filename. */
  name: string;
  /** Present only on folder nodes. */
  children?: Map<string, TreeNode>;
  /** Present only on file leaves. */
  file?: KbFileSummary;
}

/** Builds a nested tree from a list of slash-separated file paths. */
function buildTree(files: KbFileSummary[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let node = root;
    segments.forEach((seg, i) => {
      const isLeaf = i === segments.length - 1;
      if (!node.children) node.children = new Map();
      let child = node.children.get(seg);
      if (!child) {
        child = isLeaf ? { name: seg, file } : { name: seg, children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    });
  }
  return root;
}

/** Active file id parsed from a `/files/[id]` pathname, or null. */
function activeIdFromPath(pathname: string | null): number | null {
  if (!pathname) return null;
  const m = pathname.match(/\/(?:kbs\/[^/]+\/)?files\/(\d+)/);
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

export default function FileTree({ kbId }: { kbId: string }): React.ReactElement {
  const [files, setFiles] = useState<KbFileSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    // pageSize=500 keeps the tree full for typical local wikis; pagination
    // is handled server-side and the UI gracefully truncates if exceeded.
    fetch(`/api/kbs/${encodeURIComponent(kbId)}/files?pageSize=500`)
      .then((r) => r.json())
      .then((data: { files?: KbFileSummary[]; error?: string }) => {
        if (cancelled) return;
        if ("error" in data) setError(data.error ?? "Failed to load files.");
        else setFiles(data.files ?? []);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [kbId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const activeId = activeIdFromPath(pathname);

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav className="flex h-full flex-col" aria-label="File browser">
      <div className="px-4 pb-3 pt-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
            Documents
          </h2>
          {files.length > 0 ? (
            <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
              {filtered.length}
            </span>
          ) : null}
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          aria-label="Filter files"
          className="wiki-filter h-9 text-sm"
        />
      </div>
      <div className="wiki-tree-scroll flex-1 overflow-y-auto px-3 pb-5">
        {error ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>
        ) : files.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center text-sm text-slate-400">
            No files indexed
          </p>
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center text-sm text-slate-400">
            No matching files
          </p>
        ) : (
          <TreeBranch
            node={tree}
            depth={0}
            keyPrefix=""
            collapsed={collapsed}
            onToggle={toggle}
            activeId={activeId}
            kbId={kbId}
          />
        )}
      </div>
    </nav>
  );
}

function TreeBranch({
  node,
  depth,
  keyPrefix,
  collapsed,
  onToggle,
  activeId,
  kbId,
}: {
  node: TreeNode;
  depth: number;
  keyPrefix: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  activeId: number | null;
  kbId: string;
}): React.ReactElement {
  const children = node.children ? Array.from(node.children.values()) : [];
  // Folders first (alpha), then files (alpha).
  children.sort((a, b) => {
    const aFolder = !!a.children;
    const bFolder = !!b.children;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return (
    <ul className={depth === 0 ? "flex flex-col" : "flex flex-col"}>
      {children.map((child) => {
        const isFolder = !!child.children;
        const key = keyPrefix ? `${keyPrefix}/${child.name}` : child.name;
        const isCollapsed = collapsed.has(key);
        const isActive = child.file?.id === activeId;

        if (isFolder) {
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onToggle(key)}
                className="tree-row flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-slate-600"
                style={{ paddingLeft: `${depth * 0.85 + 0.5}rem` }}
                aria-expanded={!isCollapsed}
              >
                <span aria-hidden className="w-3 shrink-0 text-[10px] text-slate-400">
                  {isCollapsed ? "▸" : "▾"}
                </span>
                <span aria-hidden className="tree-folder-icon">
                  {isCollapsed ? "+" : "−"}
                </span>
                <span className="truncate">{child.name}</span>
              </button>
              {!isCollapsed ? (
                <TreeBranch
                  node={child}
                  depth={depth + 1}
                  keyPrefix={key}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  activeId={activeId}
                  kbId={kbId}
                />
              ) : null}
            </li>
          );
        }

        return (
          <li key={key}>
            <Link
              href={`/kbs/${encodeURIComponent(kbId)}/files/${child.file!.id}`}
              className={`tree-row flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                isActive ? "tree-row-active font-semibold text-indigo-700" : "text-slate-600"
              }`}
              style={{ paddingLeft: `${depth * 0.85 + 0.5}rem` }}
            >
              <span aria-hidden className="w-3 shrink-0" />
              <span aria-hidden className="tree-file-icon">
                MD
              </span>
              <span className="truncate">{child.name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
