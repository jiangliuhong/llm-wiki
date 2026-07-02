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
    <nav
      className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto px-4 py-8"
      aria-label="On this page"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-default-400">
        On this page
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-default-400">No headings.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 border-l border-default-200">
          {items.map((item, i) => (
            <li key={`${item.id}-${i}`} className={item.level === 3 ? "ml-3" : ""}>
              <a
                href={`#${item.id}`}
                className="-ml-px block border-l-0 border-l-primary/0 py-0.5 pl-3 text-sm text-default-500 transition-colors hover:border-l-primary hover:text-foreground"
              >
                {item.text}
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
