import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Chip } from "@heroui/react";

/**
 * Server component rendering a KB document.
 *
 * Renders the reassembled file content as GitHub-flavored markdown, with a
 * header showing the breadcrumb path, language badge, and last-indexed time.
 * Heading ids are slugified so the `<TableOfContents />` right rail can link
 * to them.
 */
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

export default function DocContent({
  path,
  language,
  indexedAt,
  content,
}: {
  path: string;
  language: string;
  indexedAt: string | null;
  content: string;
}): React.ReactElement {
  const segments = path.split("/").filter(Boolean);
  const indexed = indexedAt ? new Date(indexedAt).toLocaleString() : null;

  return (
    <article className="prose-doc mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6 border-b border-default-200 pb-4">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-default-400">
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 ? <span aria-hidden>/</span> : null}
              <span className={i === segments.length - 1 ? "text-default-600" : ""}>{seg}</span>
            </span>
          ))}
        </nav>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft">
            {language}
          </Chip>
          {indexed ? (
            <span className="text-xs text-default-400">Indexed {indexed}</span>
          ) : null}
        </div>
      </header>

      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Slugify headings so the TOC anchors resolve.
          h1: ({ children }) => (
            <h1 id={slugify(extractText(children))}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 id={slugify(extractText(children))}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 id={slugify(extractText(children))}>{children}</h3>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

/** Recursively extracts plain text from react-markdown heading children. */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}
