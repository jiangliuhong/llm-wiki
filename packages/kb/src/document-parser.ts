import nodePath from "node:path";

export interface ParsedRelationReference {
  type: string;
  target: string;
  sourceKind: "frontmatter" | "markdown_link" | "wikilink";
  startLine: number;
  evidenceText: string;
}

export interface ParsedDocumentSection {
  heading: string;
  slug: string;
  level: number;
  startLine: number;
}

export interface ParsedDocument {
  title: string;
  slug: string;
  summary: string | null;
  tags: string[];
  body: string;
  bodyStartLine: number;
  metadata: Record<string, unknown>;
  relations: ParsedRelationReference[];
  sections: ParsedDocumentSection[];
}

export function normalizeRelationType(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "related_to";
}

export function slugifyDocument(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "document"
  );
}

export function parseDocument(content: string, path: string): ParsedDocument {
  const markdown = /\.mdx?$/i.test(path);
  const fm = markdown
    ? parseFrontmatter(content)
    : { body: content, bodyStartLine: 1, metadata: {}, rawLines: [] };
  const body = fm.body;
  const lines = body.split(/\r?\n/);
  const firstHeading = markdown ? lines.find((line) => /^#\s+/.test(line)) : undefined;
  const fallbackTitle = nodePath.basename(path, nodePath.extname(path));
  const title =
    stringValue(fm.metadata.title) ?? firstHeading?.replace(/^#\s+/, "").trim() ?? fallbackTitle;
  const summary = stringValue(fm.metadata.summary);
  const tags = parseStringList(fm.metadata.tags);
  const relations = markdown ? parseFrontmatterRelations(fm.rawLines) : [];

  for (let index = 0; markdown && index < lines.length; index++) {
    const line = lines[index] ?? "";
    const sourceLine = fm.bodyStartLine + index;
    for (const match of line.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = cleanLinkTarget(match[1] ?? "");
      if (isLocalTarget(target)) {
        relations.push({
          type: "references",
          target,
          sourceKind: "markdown_link",
          startLine: sourceLine,
          evidenceText: line.trim(),
        });
      }
    }
    for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = cleanLinkTarget((match[1] ?? "").split("|")[0] ?? "");
      if (target) {
        relations.push({
          type: "references",
          target,
          sourceKind: "wikilink",
          startLine: sourceLine,
          evidenceText: line.trim(),
        });
      }
    }
  }

  const sections = markdown
    ? lines.flatMap((line, index) => {
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (!match?.[1] || !match[2]) return [];
        return [
          {
            heading: match[2],
            slug: slugifyDocument(match[2]),
            level: match[1].length,
            startLine: fm.bodyStartLine + index,
          },
        ];
      })
    : [];

  return {
    title,
    slug: slugifyDocument(stringValue(fm.metadata.slug) ?? title),
    summary,
    tags,
    body,
    bodyStartLine: fm.bodyStartLine,
    metadata: fm.metadata,
    relations,
    sections,
  };
}

function parseFrontmatter(content: string): {
  body: string;
  bodyStartLine: number;
  metadata: Record<string, unknown>;
  rawLines: string[];
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---")
    return { body: content, bodyStartLine: 1, metadata: {}, rawLines: [] };
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return { body: content, bodyStartLine: 1, metadata: {}, rawLines: [] };
  const closingIndex = end + 1;
  const rawLines = lines.slice(1, closingIndex);
  const metadata: Record<string, unknown> = {};
  for (const line of rawLines) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match?.[1] || match[1] === "relations") continue;
    metadata[match[1]] = parseScalarOrList(match[2] ?? "");
  }
  return {
    body: lines.slice(closingIndex + 1).join("\n"),
    bodyStartLine: closingIndex + 2,
    metadata,
    rawLines,
  };
}

function parseFrontmatterRelations(lines: string[]): ParsedRelationReference[] {
  const result: ParsedRelationReference[] = [];
  let inRelations = false;
  let current: { type?: string; target?: string; line: number; evidence: string[] } | null = null;
  const flush = (): void => {
    if (current?.target)
      result.push({
        type: normalizeRelationType(current.type ?? "related_to"),
        target: current.target,
        sourceKind: "frontmatter",
        startLine: current.line,
        evidenceText: current.evidence.join(" ").trim(),
      });
    current = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^relations:\s*$/.test(line.trim())) {
      inRelations = true;
      continue;
    }
    if (inRelations && /^[A-Za-z0-9_-]+:/.test(line) && !/^\s/.test(line)) {
      flush();
      inRelations = false;
    }
    if (!inRelations) continue;
    const item = /^\s*-\s*(?:type:\s*)?(.+?)\s*$/.exec(line);
    if (item) {
      flush();
      current = { line: index + 2, evidence: [line.trim()] };
      if (line.includes("type:")) current.type = unquote(item[1] ?? "");
      continue;
    }
    if (!current) continue;
    current.evidence.push(line.trim());
    const field = /^\s+(type|target):\s*(.+?)\s*$/.exec(line);
    if (field?.[1] === "type") current.type = unquote(field[2] ?? "");
    if (field?.[1] === "target") current.target = cleanLinkTarget(unquote(field[2] ?? ""));
  }
  flush();
  return result;
}

function parseScalarOrList(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]"))
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  return unquote(trimmed);
}
function parseStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return [
      ...new Set(
        value
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "").trim();
}
function cleanLinkTarget(value: string): string {
  return value.trim().replace(/^<|>$/g, "").split("#")[0]?.split("?")[0]?.trim() ?? "";
}
function isLocalTarget(value: string): boolean {
  return value.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("#");
}
