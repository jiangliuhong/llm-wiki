"use client";

import { useMemo } from "react";

/**
 * Right-rail table of contents.
 *
 * Parses `#`-prefixed headings (H2 and H3) out of the raw markdown and lists
 * them as in-page anchor links. Heading ids are slugified here to match the
 * ids assigned in `<DocContent />`.
 */
interface TocItem {
  level: 2 | 3;
  text: string;
  id: string;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

/** Extracts plain-text headings from raw markdown (strips inline syntax). */
function extractHeadings(markdown: string): TocItem[] {
  const items: TocItem[] = [];
  const lines = markdown.split("\n");
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    const hashes = m?.[1];
    const headingText = m?.[2];
    if (!hashes || headingText === undefined) continue;
    const level = (hashes.length === 2 ? 2 : 3) as 2 | 3;
    // Strip common inline markdown for a clean TOC label.
    const text = headingText
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    items.push({ level, text, id: slugify(text) });
  }
  return items;
}

export default function TableOfContents({ markdown }: { markdown: string }): React.ReactElement {
  const items = useMemo(() => extractHeadings(markdown), [markdown]);

  return (
    <nav className="flex h-full min-h-0 flex-col px-6 py-10" aria-label="On this page">
      <h2 className="mb-4 shrink-0 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
        On this page
      </h2>
      <div className="toc-scroll min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-sm text-slate-400">No headings.</p>
        ) : (
          <ul className="toc-list flex flex-col gap-1 border-l border-slate-200">
            {items.map((item, i) => (
              <li key={`${item.id}-${i}`} className={item.level === 3 ? "ml-3" : ""}>
                <a
                  href={`#${item.id}`}
                  className="-ml-px block border-l border-transparent py-1 pl-3 text-[13px] leading-5 text-slate-500 transition-colors hover:border-indigo-500 hover:text-indigo-700"
                >
                  {item.text}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
