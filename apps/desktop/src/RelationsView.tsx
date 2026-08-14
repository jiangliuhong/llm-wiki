import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// --- Shared runtime check (used by App.tsx as well) ------------------------

export function inTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

// --- Knowledge-base relation types (mirror the Rust structs in store.rs) ----

export interface RelationEvidence {
  id: number;
  sourceKind: string;
  originalTarget: string;
  sourcePath: string;
  startLine: number | null;
  endLine: number | null;
  evidenceText: string | null;
  rationale: string | null;
  confidence: number;
}

export interface RelationProposal {
  id: number;
  sourceFileId: number | null;
  targetFileId: number | null;
  sourcePath: string;
  targetPath: string;
  relationType: string;
  confidence: number;
  rationale: string;
  evidencePath: string;
  evidenceStartLine: number;
  evidenceEndLine: number;
  evidenceText: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface DocumentRelation {
  id: number;
  sourceFileId: number;
  sourcePath: string;
  sourceTitle: string;
  targetFileId: number;
  targetPath: string;
  targetTitle: string;
  relationType: string;
  symmetric: boolean;
  evidence: RelationEvidence[];
}

export interface RelationsPayload {
  proposals: RelationProposal[];
  published: DocumentRelation[];
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

export interface RelationsViewProps {
  workspace: { root: string; title: string } | null;
  onAskAI: () => void;
  onOpenDocuments: () => void;
}

// --- Graph model ------------------------------------------------------------

const NODE_W = 252;
const NODE_H = 76;
const ROOT_W = 284;
const ROOT_H = 106;
const COL_GAP = 108;
const ROW_GAP = 26;
const PAD_X = 56;
const TOP_PAD = 96;
const BOT_PAD = 44;
const MIN_SCALE = 0.32;
const MAX_SCALE = 1.6;
const PALETTE = ["#5b6cf9", "#0fa8c7", "#20a464", "#c27b1d", "#9660d8", "#db5a5a", "#2f75bd", "#c14d80"];

interface GraphNode {
  id: string;
  title: string;
  path: string;
  cluster: string;
  depth: number;
  degree: number;
  outCount: number;
  inCount: number;
  isRoot: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  label: string;
  strong: boolean;
  color: string;
  d: string;
  lx: number;
  ly: number;
}

interface GraphZone {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: Array<{ id: string; count: number; color: string }>;
  types: Array<{ id: string; label: string; count: number; color: string }>;
  zones: GraphZone[];
  rootId: string | null;
  world: { w: number; h: number };
}

/** Top-level directory under wiki/, used as the cluster label. */
function clusterOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  if (parts.length > 0 && parts[0] === "wiki") parts.shift();
  return parts[0] ?? "根目录";
}

function prettyType(type: string): string {
  return type.replace(/_/g, " ");
}

function docName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/** Cubic bezier through (x0,y0)..(x3,y3); returns the SVG path plus its midpoint. */
function curve(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): { d: string; lx: number; ly: number } {
  const d = `M ${x0.toFixed(1)} ${y0.toFixed(1)} C ${x1.toFixed(1)} ${y1.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}, ${x3.toFixed(1)} ${y3.toFixed(1)}`;
  return { d, lx: (x0 + 3 * x1 + 3 * x2 + x3) / 8, ly: (y0 + 3 * y1 + 3 * y2 + y3) / 8 };
}

function edgeGeometry(a: GraphNode, b: GraphNode, offset: number): { d: string; lx: number; ly: number } {
  const aR = a.x + a.w;
  const bR = b.x + b.w;
  const aCy = a.y + a.h / 2;
  const bCy = b.y + b.h / 2;
  if (b.x >= aR) {
    const dx = Math.max(48, (b.x - aR) / 2);
    return curve(aR, aCy, aR + dx, aCy + offset, b.x - dx, bCy + offset, b.x, bCy);
  }
  if (bR <= a.x) {
    const dx = Math.max(48, (a.x - bR) / 2);
    return curve(a.x, aCy, a.x - dx, aCy + offset, bR + dx, bCy + offset, bR, bCy);
  }
  // Same or overlapping columns: connect vertically.
  const down = b.y >= a.y;
  const sign = down ? 1 : -1;
  const sx = a.x + a.w / 2;
  const sy = down ? a.y + a.h : a.y;
  const tx = b.x + b.w / 2 + offset;
  const ty = down ? b.y : b.y + b.h;
  const dy = Math.max(40, Math.abs(ty - sy) / 2);
  return curve(sx, sy, sx, sy + sign * dy, tx, ty - sign * dy, tx, ty);
}

/**
 * Deterministic layered layout: nodes are grouped into BFS-depth columns from
 * the highest-degree node ("core"), stacked by degree inside each column, and
 * vertically centered so all columns share a midline. The whole graph fits a
 * fixed world box that the canvas then pans/zooms over.
 */
function buildGraphModel(published: DocumentRelation[]): GraphModel {
  const info = new Map<string, { title: string; cluster: string; out: number; inc: number; neighbors: Set<string> }>();
  const ensure = (path: string, title: string): void => {
    let entry = info.get(path);
    if (!entry) {
      entry = { title: title || docName(path), cluster: clusterOf(path), out: 0, inc: 0, neighbors: new Set() };
      info.set(path, entry);
    } else if (title && entry.title === docName(path)) {
      entry.title = title;
    }
  };
  for (const rel of published) {
    ensure(rel.sourcePath, rel.sourceTitle);
    ensure(rel.targetPath, rel.targetTitle);
    const s = info.get(rel.sourcePath);
    const t = info.get(rel.targetPath);
    if (!s || !t) continue;
    s.out += 1;
    t.inc += 1;
    s.neighbors.add(rel.targetPath);
    t.neighbors.add(rel.sourcePath);
  }

  const paths = Array.from(info.keys()).sort();
  const degree = (p: string): number => {
    const e = info.get(p);
    return e ? e.out + e.inc : 0;
  };

  let rootId: string | null = null;
  const depths = new Map<string, number>();
  const firstPath = paths[0];
  if (firstPath !== undefined) {
    rootId = paths.reduce((best, p) => (degree(p) > degree(best) ? p : best), firstPath);
    {
      depths.set(rootId, 0);
      const queue: string[] = [rootId];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) break;
        const d = depths.get(cur) ?? 0;
        for (const nb of info.get(cur)?.neighbors ?? []) {
          if (!depths.has(nb)) {
            depths.set(nb, d + 1);
            queue.push(nb);
          }
        }
      }
      let maxDepth = 0;
      for (const d of depths.values()) maxDepth = Math.max(maxDepth, d);
      const detached = paths.filter((p) => !depths.has(p));
      for (const p of detached) depths.set(p, maxDepth + 1);
    }
  }

  const nodeH = (p: string): number => (p === rootId ? ROOT_H : NODE_H);
  const columns = new Map<number, string[]>();
  for (const p of paths) {
    const d = depths.get(p) ?? 0;
    const arr = columns.get(d) ?? [];
    arr.push(p);
    columns.set(d, arr);
  }
  const colDepths = Array.from(columns.keys()).sort((a, b) => a - b);
  const columnHeight = (arr: string[]): number => arr.reduce((h, p) => h + nodeH(p) + ROW_GAP, -ROW_GAP);
  const contentH = colDepths.reduce((h, d) => Math.max(h, columnHeight(columns.get(d) ?? [])), 0);
  const worldH = TOP_PAD + contentH + BOT_PAD;

  const nodes: GraphNode[] = [];
  const zones: GraphZone[] = [];
  let detachedDepth = -1;
  if (rootId !== null && columns.size > 1) {
    // If a detached column exists it is always the last one.
    const last = colDepths[colDepths.length - 1] ?? 0;
    const lastArr = columns.get(last) ?? [];
    const reached = new Set<string>();
    const walk = (p: string): void => {
      if (reached.has(p)) return;
      reached.add(p);
      for (const nb of info.get(p)?.neighbors ?? []) walk(nb);
    };
    walk(rootId);
    if (lastArr.some((p) => !reached.has(p))) detachedDepth = last;
  }
  colDepths.forEach((d, ci) => {
    const arr = (columns.get(d) ?? []).slice().sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
    const x = PAD_X + ci * (NODE_W + COL_GAP);
    const h = columnHeight(arr);
    const y0 = TOP_PAD + (contentH - h) / 2;
    arr.forEach((p, i) => {
      const e = info.get(p);
      if (!e) return;
      const isRoot = p === rootId;
      nodes.push({
        id: p,
        title: e.title,
        path: p,
        cluster: e.cluster,
        depth: d,
        degree: e.out + e.inc,
        outCount: e.out,
        inCount: e.inc,
        isRoot,
        x,
        y: y0 + arr.slice(0, i).reduce((acc, prev) => acc + nodeH(prev) + ROW_GAP, 0),
        w: isRoot ? ROOT_W : NODE_W,
        h: isRoot ? ROOT_H : NODE_H,
      });
    });
    zones.push({
      x: x - 26,
      y: TOP_PAD - 46,
      w: NODE_W + 52,
      h: h + 62,
      label: d === detachedDepth ? "未直接连通" : d === 0 ? "核心文档" : d === 1 ? "一跳关联" : d === 2 ? "二跳关联" : `第 ${d + 1} 层`,
    });
  });
  const worldW = colDepths.length > 0 ? PAD_X * 2 + (colDepths.length - 1) * (NODE_W + COL_GAP) + NODE_W : 480;

  // Relation-type palette assignment, then edges (with spread when a pair has
  // several relations so their curves do not overlap exactly).
  const typeCounts = new Map<string, number>();
  for (const rel of published) typeCounts.set(rel.relationType, (typeCounts.get(rel.relationType) ?? 0) + 1);
  const types = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count], i) => ({ id, label: prettyType(id), count, color: PALETTE[i % PALETTE.length] ?? "#5b6cf9" }));
  const typeColor = new Map(types.map((t) => [t.id, t.color]));

  const pairTotal = new Map<string, number>();
  const pairKey = (from: string, to: string): string => (from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`);
  for (const rel of published) {
    const key = pairKey(rel.sourcePath, rel.targetPath);
    pairTotal.set(key, (pairTotal.get(key) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  for (const rel of published) {
    const a = nodeById.get(rel.sourcePath);
    const b = nodeById.get(rel.targetPath);
    if (!a || !b) continue;
    const key = pairKey(rel.sourcePath, rel.targetPath);
    const idx = pairSeen.get(key) ?? 0;
    pairSeen.set(key, idx + 1);
    const total = pairTotal.get(key) ?? 1;
    const offset = (idx - (total - 1) / 2) * 18;
    const geo = edgeGeometry(a, b, offset);
    edges.push({
      id: `${rel.sourcePath}\u0000${rel.targetPath}\u0000${rel.relationType}\u0000${rel.id}`,
      from: rel.sourcePath,
      to: rel.targetPath,
      type: rel.relationType,
      label: prettyType(rel.relationType),
      strong: rel.symmetric || rel.evidence.length > 0,
      color: typeColor.get(rel.relationType) ?? "#5b6cf9",
      ...geo,
    });
  }

  const clusterCounts = new Map<string, number>();
  for (const n of nodes) clusterCounts.set(n.cluster, (clusterCounts.get(n.cluster) ?? 0) + 1);
  const clusters = Array.from(clusterCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count], i) => ({ id, count, color: PALETTE[i % PALETTE.length] ?? "#5b6cf9" }));

  return { nodes, edges, clusters, types, zones, rootId, world: { w: worldW, h: worldH } };
}

/** Undirected BFS from `origin` limited to `hops` levels. */
function bfsWithin(model: GraphModel, origin: string | null, hops: number): Set<string> {
  const seen = new Set<string>();
  if (!origin) return seen;
  const adjacency = new Map<string, Set<string>>();
  for (const e of model.edges) {
    const a = adjacency.get(e.from) ?? new Set<string>();
    a.add(e.to);
    adjacency.set(e.from, a);
    const b = adjacency.get(e.to) ?? new Set<string>();
    b.add(e.from);
    adjacency.set(e.to, b);
  }
  let frontier = [origin];
  seen.add(origin);
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const nb of adjacency.get(p) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

// --- Icons (line-style SVG paths from the preview prototype) -----------------

const ICON_PATHS: Record<string, React.ReactNode> = {
  file: (<><path d="M6 3.5h8.5L19 8v12.5H6v-17Z" /><path d="M14.5 3.5V8H19M9 12h7M9 15h7M9 18h4" /></>),
  search: (<><circle cx="10.5" cy="10.5" r="6.2" /><path d="m15.2 15.2 4.3 4.3" /></>),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  target: (<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>),
  check: <path d="m6.5 12.5 3.4 3.4 7.6-8" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: (<><rect x="3.5" y="4" width="7" height="7" rx="1.5" /><rect x="13.5" y="4" width="7" height="4" rx="1.5" /><rect x="13.5" y="11" width="7" height="9" rx="1.5" /><rect x="3.5" y="14" width="7" height="6" rx="1.5" /></>),
  label: (<><path d="M4 6h9l7 6-7 6H4V6Z" /><circle cx="8" cy="12" r="1.4" fill="currentColor" stroke="none" /></>),
  link: <path d="m9.5 14.5 5-5M7.8 17.5l-1.3 1.3a3.7 3.7 0 1 1-5.3-5.3l3-3a3.7 3.7 0 0 1 5.3 0M16.2 6.5l1.3-1.3a3.7 3.7 0 1 1 5.3 5.3l-3 3a3.7 3.7 0 0 1-5.3 0" />,
  more: (<><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>),
  spark: (<><path d="m12 3 1.5 5.2L19 10l-5.5 1.8L12 17l-1.5-5.2L5 10l5.5-1.8L12 3Z" /><path d="m18.5 15 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" fill="currentColor" stroke="none" /></>),
  external: <path d="M13 5h6v6M19 5l-8 8M18 14v5H5V6h5" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4" />,
};

function GIcon({ name, size = 16, strokeWidth = 1.7 }: { name: string; size?: number; strokeWidth?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name] ?? null}
    </svg>
  );
}

// --- Demo payload (browser preview only, no Tauri runtime) -------------------

function demoPayload(): RelationsPayload {
  const nodes: Array<[string, string]> = [
    ["wiki/P&L系统/BI预测逻辑说明.md", "BI 预测逻辑说明"],
    ["wiki/P&L系统/GMV计算说明.md", "P&L Forecast GMV 计算说明"],
    ["wiki/P&L系统/数据分层说明.md", "P&L 系统数据分层说明"],
    ["wiki/P&L系统/预测场景说明.md", "中心版 / 乐观版 场景说明"],
    ["wiki/P&L系统/参数集定义.md", "参数集定义"],
    ["wiki/数据仓库/pl_forecast_user_flow_metrics.md", "预测用户流指标口径"],
    ["wiki/数据仓库/pl_forecast_result_monthly.md", "pl_forecast_result_monthly 表说明"],
    ["wiki/指标/收入指标.md", "收入指标口径"],
    ["wiki/指标/成本指标.md", "业务成本指标口径"],
    ["wiki/指标/利润指标.md", "利润指标口径"],
    ["wiki/BI/利润看板.md", "BI 利润看板说明"],
  ];
  const byPath = new Map(nodes);
  const published: DocumentRelation[] = [];
  let nextId = 1;
  const edge = (from: string, to: string, type: string, symmetric: boolean, evidenced: boolean): void => {
    published.push({
      id: nextId++,
      sourceFileId: nextId,
      sourcePath: from,
      sourceTitle: byPath.get(from) ?? docName(from),
      targetFileId: nextId + 100,
      targetPath: to,
      targetTitle: byPath.get(to) ?? docName(to),
      relationType: type,
      symmetric,
      evidence: evidenced
        ? [{ id: nextId + 500, sourceKind: "frontmatter", originalTarget: to, sourcePath: from, startLine: 4, endLine: 9, evidenceText: null, rationale: "frontmatter relations 声明", confidence: 0.9 }]
        : [],
    });
  };
  edge("wiki/P&L系统/预测场景说明.md", "wiki/P&L系统/BI预测逻辑说明.md", "references", false, true);
  edge("wiki/P&L系统/参数集定义.md", "wiki/P&L系统/BI预测逻辑说明.md", "references", false, true);
  edge("wiki/P&L系统/预测场景说明.md", "wiki/P&L系统/参数集定义.md", "related_to", true, true);
  edge("wiki/数据仓库/pl_forecast_user_flow_metrics.md", "wiki/P&L系统/GMV计算说明.md", "depends_on", false, true);
  edge("wiki/P&L系统/GMV计算说明.md", "wiki/P&L系统/BI预测逻辑说明.md", "references", false, true);
  edge("wiki/P&L系统/BI预测逻辑说明.md", "wiki/P&L系统/数据分层说明.md", "extends", false, true);
  edge("wiki/P&L系统/数据分层说明.md", "wiki/数据仓库/pl_forecast_result_monthly.md", "references", false, true);
  edge("wiki/数据仓库/pl_forecast_user_flow_metrics.md", "wiki/数据仓库/pl_forecast_result_monthly.md", "depends_on", false, false);
  edge("wiki/数据仓库/pl_forecast_result_monthly.md", "wiki/指标/收入指标.md", "aggregates", false, false);
  edge("wiki/数据仓库/pl_forecast_result_monthly.md", "wiki/指标/成本指标.md", "aggregates", false, false);
  edge("wiki/指标/收入指标.md", "wiki/指标/利润指标.md", "feeds_into", false, true);
  edge("wiki/指标/成本指标.md", "wiki/指标/利润指标.md", "feeds_into", false, true);
  edge("wiki/指标/利润指标.md", "wiki/BI/利润看板.md", "consumed_by", false, true);
  edge("wiki/数据仓库/pl_forecast_result_monthly.md", "wiki/BI/利润看板.md", "consumed_by", false, false);
  const proposals: RelationProposal[] = [
    {
      id: 901, sourceFileId: 3, targetFileId: 8,
      sourcePath: "wiki/P&L系统/GMV计算说明.md", targetPath: "wiki/指标/收入指标.md",
      relationType: "feeds_into", confidence: 0.82,
      rationale: "GMV 计算说明中的预计收入章节与收入指标口径使用同一公式，疑似直接上下游。",
      evidencePath: "wiki/P&L系统/GMV计算说明.md", evidenceStartLine: 42, evidenceEndLine: 55,
      evidenceText: null, status: "pending", createdAt: "2026-08-13T09:12:00Z", reviewedAt: null,
    },
    {
      id: 902, sourceFileId: 5, targetFileId: 11,
      sourcePath: "wiki/数据仓库/pl_forecast_result_monthly.md", targetPath: "wiki/BI/利润看板.md",
      relationType: "consumed_by", confidence: 0.64,
      rationale: "看板文档引用了结果宽表的字段清单，建议补充字段级证据。",
      evidencePath: "wiki/BI/利润看板.md", evidenceStartLine: 20, evidenceEndLine: 28,
      evidenceText: null, status: "pending", createdAt: "2026-08-13T10:02:00Z", reviewedAt: null,
    },
  ];
  return { proposals, published };
}

// --- Main view ----------------------------------------------------------------

type RangeMode = "global" | "one" | "two";

const RANGE_LABELS: Record<RangeMode, string> = { global: "全局", one: "一跳", two: "两跳" };

export default function RelationsView({ workspace, onAskAI, onOpenDocuments }: RelationsViewProps): React.ReactElement {
  const [state, setState] = useState<LoadState<RelationsPayload>>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [rangeMode, setRangeMode] = useState<RangeMode>("global");
  const [activeTypes, setActiveTypes] = useState<Set<string> | null>(null);
  const [activeCluster, setActiveCluster] = useState<string | null>(null);
  const [strongOnly, setStrongOnly] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [relationTab, setRelationTab] = useState<"all" | "out" | "in">("all");
  const [isDemo, setIsDemo] = useState(false);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!inTauriRuntime() || typeof invoke !== "function") {
      setState({ status: "ready", data: demoPayload() });
      setIsDemo(true);
      return;
    }
    if (!workspace) {
      setState({ status: "error", message: "请先选择一个工作区" });
      setIsDemo(false);
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    setIsDemo(false);
    void invoke<RelationsPayload>("relations_list", { root: workspace.root })
      .then((data) => { if (!cancelled) setState({ status: "ready", data }); })
      .catch((reason: unknown) => { if (!cancelled) setState({ status: "error", message: String(reason) }); });
    return () => { cancelled = true; };
  }, [workspace, reloadKey]);

  const model = useMemo(
    () => (state.status === "ready" ? buildGraphModel(state.data.published) : null),
    [state],
  );
  const proposals = state.status === "ready" ? state.data.proposals : [];

  // Reset selection/filters whenever a new graph is loaded.
  useEffect(() => {
    setSelectedId(model?.rootId ?? null);
    setActiveTypes(null);
    setActiveCluster(null);
    setQuery("");
    setRangeMode("global");
    setStrongOnly(false);
    setShowLabels(true);
  }, [model]);

  const typeSet = useMemo(
    () => activeTypes ?? new Set((model?.types ?? []).map((t) => t.id)),
    [activeTypes, model],
  );

  const rangeIds = useMemo(() => {
    if (!model) return new Set<string>();
    if (rangeMode === "global") return new Set(model.nodes.map((n) => n.id));
    return bfsWithin(model, selectedId ?? model.rootId, rangeMode === "one" ? 1 : 2);
  }, [model, rangeMode, selectedId]);

  const visibility = useMemo(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const incident = new Map<string, number>();
    if (model) {
      const nodeBase = (id: string): boolean => {
        const n = model.nodes.find((x) => x.id === id);
        if (!n || !rangeIds.has(id)) return false;
        return !activeCluster || n.cluster === activeCluster;
      };
      for (const e of model.edges) {
        if (!nodeBase(e.from) || !nodeBase(e.to)) continue;
        if (!typeSet.has(e.type)) continue;
        if (strongOnly && !e.strong) continue;
        edgeIds.add(e.id);
        incident.set(e.from, (incident.get(e.from) ?? 0) + 1);
        incident.set(e.to, (incident.get(e.to) ?? 0) + 1);
      }
      for (const n of model.nodes) {
        if (!nodeBase(n.id)) continue;
        if (n.degree > 0 && (incident.get(n.id) ?? 0) === 0) continue;
        nodeIds.add(n.id);
      }
    }
    return { nodeIds, edgeIds };
  }, [model, rangeIds, activeCluster, typeSet, strongOnly]);

  const visibleNodeCount = visibility.nodeIds.size;
  const visibleEdgeCount = visibility.edgeIds.size;

  const selected = useMemo(
    () => model?.nodes.find((n) => n.id === selectedId) ?? null,
    [model, selectedId],
  );

  const showToast = useCallback((text: string): void => {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  }, []);

  const fit = useCallback((): void => {
    const el = stageRef.current;
    if (!el || !model) return;
    const pad = 46;
    const availW = Math.max(120, el.clientWidth - pad * 2);
    const availH = Math.max(120, el.clientHeight - pad * 2);
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / model.world.w, availH / model.world.h, 1.05)));
    setCamera({
      scale,
      x: (el.clientWidth - model.world.w * scale) / 2,
      y: (el.clientHeight - model.world.h * scale) / 2,
    });
  }, [model]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number): void => {
    setCamera((prev) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      const ratio = scale / prev.scale;
      return { scale, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
    });
  }, []);

  const centerNode = useCallback((id: string): void => {
    const el = stageRef.current;
    const node = model?.nodes.find((n) => n.id === id);
    if (!el || !node) return;
    setCamera((prev) => {
      const scale = Math.max(prev.scale, 0.85);
      return {
        scale,
        x: el.clientWidth / 2 - (node.x + node.w / 2) * scale,
        y: el.clientHeight / 2 - (node.y + node.h / 2) * scale,
      };
    });
  }, [model]);

  const selectNode = useCallback((id: string, center = false): void => {
    setSelectedId(id);
    if (center) centerNode(id);
  }, [centerNode]);

  // Refit when the graph, range mode or cluster filter changes.
  useEffect(() => { fit(); }, [fit, rangeMode, activeCluster]);

  // Wheel zoom needs a non-passive listener, so it is attached imperatively.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY > 0 ? 0.92 : 1.08);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  if (state.status === "loading") return <div className="empty-state"><div className="empty-icon">⌘</div><h2>加载关系图谱…</h2></div>;
  if (state.status === "error") return <div className="empty-state"><div className="empty-icon">⌘</div><h2>无法加载关系图谱</h2><p>{state.message}</p></div>;
  if (!model || (model.nodes.length === 0 && proposals.length === 0)) {
    return <div className="empty-state">
      <div className="empty-icon">⌘</div>
      <h2>暂无关系数据</h2>
      <p>工作区尚未索引，或还没有已发布 / 待审核的关系。</p>
    </div>;
  }

  const q = query.trim().toLowerCase();
  const nodeMatches = (n: GraphNode): boolean => !q || `${n.title} ${n.path}`.toLowerCase().includes(q);
  const pendingProposals = proposals.filter((p) => p.status === "pending");

  const toggleType = (id: string): void => {
    setActiveTypes((prev) => {
      const base = prev ?? new Set(model.types.map((t) => t.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allTypesOff = typeSet.size === 0;
  const toggleAllTypes = (): void => {
    if (allTypesOff) setActiveTypes(null);
    else setActiveTypes(new Set());
  };

  const resetFilters = (): void => {
    setActiveTypes(null);
    setActiveCluster(null);
    setStrongOnly(false);
    setShowLabels(true);
    setQuery("");
    setRangeMode("global");
    if (model.rootId) setSelectedId(model.rootId);
    fit();
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    const hit = model.nodes.find(nodeMatches);
    if (hit) selectNode(hit.id, true);
  };

  const copyNodeLink = async (): Promise<void> => {
    if (!selected) return;
    try { await navigator.clipboard.writeText(`llm-wiki://graph/${selected.path}`); } catch { /* clipboard unavailable */ }
    showToast("已复制节点链接");
  };

  const relEdges = selected ? model.edges.filter((e) => e.from === selected.id || e.to === selected.id) : [];
  const outEdges = relEdges.filter((e) => e.from === selectedId);
  const inEdges = relEdges.filter((e) => e.to === selectedId);
  const tabbedEdges = relationTab === "out" ? outEdges : relationTab === "in" ? inEdges : relEdges;
  const nodeTypeTags = selected
    ? Array.from(new Set(relEdges.map((e) => e.type))).slice(0, 4).map(prettyType)
    : [];

  const graphTitle = activeCluster ? `${activeCluster} · 关系图谱` : rangeMode === "global" ? "全局知识网络" : `${RANGE_LABELS[rangeMode]}邻域视图`;

  return <div className="relations-page">
    {/* --- Left: explorer / filters --------------------------------------- */}
    <aside className="rg-explorer">
      <div className="rg-panel-head">
        <div className="rg-panel-copy">
          <div className="rg-panel-title">图谱浏览器</div>
          <div className="rg-panel-sub">筛选节点与关系范围</div>
        </div>
        <button className="rg-icon-btn" title="重置筛选" onClick={resetFilters}><GIcon name="target" size={15} /></button>
      </div>
      <div className="rg-panel-scroll">
        <label className="rg-search">
          <GIcon name="search" size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKeyDown} placeholder="查找节点" />
          {q && <button className="rg-clear" aria-label="清除搜索" onClick={() => setQuery("")}><GIcon name="x" size={12} /></button>}
        </label>

        <div className="rg-range-switch" role="group" aria-label="视图范围">
          {(Object.keys(RANGE_LABELS) as RangeMode[]).map((mode) => (
            <button key={mode} className={rangeMode === mode ? "active" : ""} onClick={() => setRangeMode(mode)}>
              {RANGE_LABELS[mode]}
            </button>
          ))}
        </div>
        <p className="rg-range-hint">{rangeMode === "global" ? "显示图谱中的全部节点" : `围绕${selected ? "选中节点" : "核心文档"}展示邻域`}</p>

        <section className="rg-section">
          <div className="rg-kicker"><span>图谱概览</span></div>
          <div className="rg-stats">
            <div className="rg-stat"><strong>{visibleNodeCount}</strong><span>可见节点</span></div>
            <div className="rg-stat"><strong>{visibleEdgeCount}</strong><span>关系边</span></div>
            <div className="rg-stat"><strong>{model.clusters.length}</strong><span>目录簇</span></div>
            <div className="rg-stat"><strong>{pendingProposals.length}</strong><span>待审核</span></div>
          </div>
        </section>

        {model.types.length > 0 && (
          <section className="rg-section">
            <div className="rg-kicker"><span>关系类型</span><button onClick={toggleAllTypes}>{allTypesOff ? "全部显示" : "全部隐藏"}</button></div>
            <div className="rg-type-list">
              {model.types.map((t) => {
                const on = typeSet.has(t.id);
                return (
                  <button key={t.id} className={on ? "rg-type-row on" : "rg-type-row off"} onClick={() => toggleType(t.id)}>
                    <span className="rg-type-check">{on && <GIcon name="check" size={11} strokeWidth={2.2} />}</span>
                    <span className="rg-type-name"><i className="rg-type-dot" style={{ background: t.color }} />{t.label}</span>
                    <span className="rg-type-count">{t.count}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {model.clusters.length > 1 && (
          <section className="rg-section">
            <div className="rg-kicker"><span>目录簇</span><button onClick={() => setActiveCluster(null)}>清除</button></div>
            <div className="rg-cluster-list">
              {model.clusters.map((c) => {
                const maxCount = model.clusters[0]?.count ?? c.count;
                return (
                  <button
                    key={c.id}
                    className={activeCluster === c.id ? "rg-cluster active" : "rg-cluster"}
                    style={{ "--cluster-color": c.color, "--cluster-progress": `${Math.max(12, Math.round((c.count / Math.max(1, maxCount)) * 100))}%` } as React.CSSProperties}
                    onClick={() => setActiveCluster(activeCluster === c.id ? null : c.id)}
                  >
                    <span className="rg-cluster-top">
                      <i className="rg-cluster-swatch" />
                      <span className="rg-cluster-name">{c.id}</span>
                      <span className="rg-cluster-count">{c.count} 节点</span>
                    </span>
                    <span className="rg-cluster-bar"><span /></span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="rg-section">
          <div className="rg-kicker"><span>关系设置</span></div>
          <div className="rg-control-row">
            <span>仅显示强关系</span>
            <button className={strongOnly ? "rg-toggle on" : "rg-toggle"} aria-label="仅显示强关系" onClick={() => setStrongOnly((v) => !v)} />
          </div>
          <div className="rg-control-row">
            <span>显示关系名称</span>
            <button className={showLabels ? "rg-toggle on" : "rg-toggle"} aria-label="显示关系名称" onClick={() => setShowLabels((v) => !v)} />
          </div>
          <p className="rg-range-hint">强关系 = 有证据支撑或对称的关系；弱关系以虚线显示。</p>
        </section>

        {pendingProposals.length > 0 && (
          <section className="rg-section">
            <div className="rg-kicker"><span>待审核候选 · {pendingProposals.length}</span></div>
            <div className="rg-proposal-list">
              {pendingProposals.slice(0, 10).map((p) => (
                <div key={p.id} className="rg-proposal" title={p.rationale}>
                  <strong>{docName(p.sourcePath)} → {docName(p.targetPath)}</strong>
                  <span>{prettyType(p.relationType)} · 置信度 {(p.confidence * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
            <p className="rg-range-hint">候选关系审核通过后才会进入图谱。</p>
          </section>
        )}

        <section className="rg-section">
          <button className="rg-reload" onClick={() => setReloadKey((k) => k + 1)}>
            <GIcon name="refresh" size={14} /><span>重新加载图谱</span>
          </button>
        </section>
      </div>
    </aside>

    {/* --- Center: canvas --------------------------------------------------- */}
    <section className="rg-center">
      <header className="rg-toolbar">
        <div className="rg-toolbar-title">
          <strong>{graphTitle}</strong>
          {isDemo && <span className="rg-demo-chip">示例数据</span>}
        </div>
        <span className="rg-meta-chip">{visibleNodeCount} 节点</span>
        <span className="rg-meta-chip">{visibleEdgeCount} 关系</span>
        <div className="rg-toolbar-spacer" />
        <button className="rg-tool" onClick={fit}><GIcon name="fit" size={14} /><span>适应画布</span></button>
        <button className="rg-tool" disabled={!model.rootId} onClick={() => model.rootId && selectNode(model.rootId, true)}><GIcon name="target" size={14} /><span>聚焦核心</span></button>
        <button className={showLabels ? "rg-tool active" : "rg-tool"} onClick={() => setShowLabels((v) => !v)}><GIcon name="label" size={14} /><span>关系名称</span></button>
      </header>

      <div
        ref={stageRef}
        className={panning ? "rg-stage panning" : "rg-stage"}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".rg-node, .rg-minimap, .rg-zoom, .rg-legend")) return;
          panRef.current = { px: e.clientX, py: e.clientY, ox: camera.x, oy: camera.y };
          e.currentTarget.setPointerCapture(e.pointerId);
          setPanning(true);
        }}
        onPointerMove={(e) => {
          const p = panRef.current;
          if (!p) return;
          setCamera((prev) => ({ ...prev, x: p.ox + e.clientX - p.px, y: p.oy + e.clientY - p.py }));
        }}
        onPointerUp={() => { panRef.current = null; setPanning(false); }}
        onPointerCancel={() => { panRef.current = null; setPanning(false); }}
      >
        <div className="rg-tip"><span className="pulse" />拖动画布浏览 · 滚轮缩放</div>

        <div className="rg-world" style={{ width: model.world.w, height: model.world.h, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
          {model.zones.map((z, i) => (
            <div key={i} className="rg-zone" style={{ left: z.x, top: z.y, width: z.w, height: z.h }}><span>{z.label}</span></div>
          ))}

          <svg className="rg-edge-layer" viewBox={`0 0 ${model.world.w} ${model.world.h}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              {model.types.map((t) => (
                <marker key={t.id} id={`rg-arrow-${t.id}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L8,4 L0,8 z" fill={rgba(t.color, 0.85)} />
                </marker>
              ))}
            </defs>
            {model.edges.map((e) => {
              if (!visibility.edgeIds.has(e.id)) return null;
              const touched = selectedId !== null && (e.from === selectedId || e.to === selectedId);
              return (
                <g key={e.id}>
                  <path
                    className={e.strong ? "rg-edge strong" : "rg-edge weak"}
                    d={e.d}
                    markerEnd={`url(#rg-arrow-${e.type})`}
                    stroke={rgba(e.color, touched ? 0.92 : 0.5)}
                    strokeWidth={touched ? 2 : 1.5}
                  />
                  {showLabels && (
                    <text className={touched ? "rg-edge-label hl" : "rg-edge-label"} x={e.lx} y={e.ly - 7} textAnchor="middle">{e.label}</text>
                  )}
                </g>
              );
            })}
          </svg>

          {model.nodes.map((n) => {
            if (!visibility.nodeIds.has(n.id)) return null;
            const hit = q !== "" && nodeMatches(n);
            const dim = q !== "" && !hit;
            return (
              <button
                key={n.id}
                className={[
                  "rg-node",
                  n.isRoot ? "rg-root" : "",
                  n.id === selectedId ? "selected" : "",
                  hit ? "search-hit" : "",
                  dim ? "search-dim" : "",
                ].filter(Boolean).join(" ")}
                style={{ left: n.x, top: n.y, width: n.w }}
                title={n.path}
                onClick={(e) => { e.stopPropagation(); selectNode(n.id); }}
              >
                <span className="rg-node-icon"><GIcon name="file" size={17} /></span>
                <span className="rg-node-copy">
                  <strong>{n.title}</strong>
                  <span>{n.path}</span>
                </span>
                <span className="rg-node-badge">{n.degree}</span>
                {n.isRoot && (
                  <span className="rg-node-foot">
                    <span>核心文档</span><i /><span>{n.outCount} 出边</span><i /><span>{n.inCount} 入边</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {visibleNodeCount === 0 && (
          <div className="rg-stage-empty">当前筛选下没有可显示的节点<br />尝试放宽关系类型或目录簇筛选</div>
        )}

        {model.types.length > 0 && (
          <div className="rg-legend">
            {model.types.slice(0, 5).map((t) => (
              <span key={t.id} className="rg-legend-item"><i style={{ background: t.color }} />{t.label}</span>
            ))}
            {model.types.length > 5 && <span className="rg-legend-item">+{model.types.length - 5}</span>}
          </div>
        )}

        <div className="rg-zoom">
          <button aria-label="缩小" onClick={() => { const el = stageRef.current; if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1 / 1.15); }}><GIcon name="minus" size={14} /></button>
          <span className="rg-zoom-value">{Math.round(camera.scale * 100)}%</span>
          <button aria-label="放大" onClick={() => { const el = stageRef.current; if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.15); }}><GIcon name="plus" size={14} /></button>
        </div>

        <Minimap model={model} camera={camera} visibleNodeIds={visibility.nodeIds} stageSize={stageSize} onFit={fit} />
      </div>
    </section>

    {/* --- Right: inspector -------------------------------------------------- */}
    <aside className="rg-inspector">
      <div className="rg-panel-head">
        <div className="rg-inspect-icon"><GIcon name="file" size={16} /></div>
        <div className="rg-panel-copy">
          <div className="rg-panel-title">节点详情</div>
          <div className="rg-panel-sub">查看定义与关系</div>
        </div>
      </div>
      <div className="rg-panel-scroll rg-inspect-scroll">
        {selected === null
          ? <div className="rg-relation-empty">在画布中选择一个节点查看详情</div>
          : <>
            <div className="rg-inspect-card">
              <div className="rg-inspect-kind">
                <span className="rg-kind-badge"><i />文档</span>
                <div className="rg-inspect-actions">
                  <button className="rg-icon-btn" title="复制节点链接" onClick={() => void copyNodeLink()}><GIcon name="link" size={14} /></button>
                  <button className="rg-icon-btn" title="更多操作"><GIcon name="more" size={15} /></button>
                </div>
              </div>
              <h2 className="rg-inspect-title">{selected.title}</h2>
              <div className="rg-inspect-path">{selected.path}</div>
              <div className="rg-meta-grid">
                <div className="rg-meta-cell"><strong>{selected.degree}</strong><span>直接关系</span></div>
                <div className="rg-meta-cell"><strong>{selected.outCount}</strong><span>出边</span></div>
                <div className="rg-meta-cell"><strong>{selected.inCount}</strong><span>入边</span></div>
              </div>
              {nodeTypeTags.length > 0 && (
                <div className="rg-inspect-tags">
                  <span className="rg-tag">{selected.cluster}</span>
                  {nodeTypeTags.map((tag) => <span key={tag} className="rg-tag">{tag}</span>)}
                </div>
              )}
            </div>

            <section className="rg-section">
              <div className="rg-kicker"><span>关联关系</span></div>
              <div className="rg-relation-tabs">
                <button className={relationTab === "all" ? "active" : ""} onClick={() => setRelationTab("all")}>全部 {relEdges.length}</button>
                <button className={relationTab === "out" ? "active" : ""} onClick={() => setRelationTab("out")}>出边 {outEdges.length}</button>
                <button className={relationTab === "in" ? "active" : ""} onClick={() => setRelationTab("in")}>入边 {inEdges.length}</button>
              </div>
              <div className="rg-relation-list">
                {tabbedEdges.length === 0
                  ? <div className="rg-relation-empty">当前筛选下没有可显示的关系</div>
                  : tabbedEdges.map((e) => {
                    const outbound = e.from === selectedId;
                    const otherId = outbound ? e.to : e.from;
                    const other = model.nodes.find((n) => n.id === otherId);
                    if (!other) return null;
                    return (
                      <button key={e.id} className="rg-relation-item" style={{ "--rel-color": e.color, "--rel-soft": rgba(e.color, 0.12) } as React.CSSProperties} onClick={() => selectNode(otherId, true)}>
                        <span className="rg-relation-icon"><GIcon name="file" size={14} /></span>
                        <span className="rg-relation-copy">
                          <strong>{other.title}</strong>
                          <span>{e.label} · {e.strong ? "强关系" : "弱关系"}</span>
                        </span>
                        <span className="rg-relation-direction">{outbound ? "→ 出边" : "← 入边"}</span>
                      </button>
                    );
                  })}
              </div>
            </section>
            <section className="rg-section">
              <div className="rg-kicker"><span>图谱洞察</span></div>
              <div className="rg-insight-card">
                <div className="rg-insight-head"><GIcon name="spark" size={14} /><span>关系解读</span></div>
                <p>{insightFor(selected, relEdges.length)}</p>
              </div>
            </section>
          </>}
      </div>
      <div className="rg-inspector-footer">
        <button className="rg-action" onClick={onAskAI}><GIcon name="spark" size={14} /><span>询问 AI</span></button>
        <button className="rg-action primary" onClick={onOpenDocuments}><GIcon name="external" size={14} /><span>打开文档</span></button>
      </div>
    </aside>

    <div className={toast ? "toast show" : "toast"} role="status">{toast}</div>
  </div>;
}

function insightFor(node: GraphNode, degree: number): string {
  if (degree === 0) {
    return "该文档暂时没有已发布关系。可以运行 kb-infer-relations 让 Agent 提交候选关系，补全它的上下游。";
  }
  if (node.isRoot || degree >= 6) {
    return `该文档是 ${node.cluster} 目录下的核心枢纽，直接连接 ${degree} 个文档（${node.outCount} 出边 / ${node.inCount} 入边）。优先完善它的关系可以显著提升问答召回质量。`;
  }
  return `该文档位于 ${node.cluster} 目录，通过 ${degree} 条关系与图谱相连（${node.outCount} 出边 / ${node.inCount} 入边）。建议沿强关系追踪上游输入，再检查下游消费方是否完整。`;
}

// --- Minimap -------------------------------------------------------------------

function Minimap({ model, camera, visibleNodeIds, stageSize, onFit }: {
  model: GraphModel;
  camera: { x: number; y: number; scale: number };
  visibleNodeIds: Set<string>;
  stageSize: { w: number; h: number };
  onFit: () => void;
}): React.ReactElement | null {
  if (stageSize.w === 0 || stageSize.h === 0) return null;
  const W = 150;
  const H = 96;
  const r = Math.min(W / model.world.w, H / model.world.h);
  const offX = (W - model.world.w * r) / 2;
  const offY = (H - model.world.h * r) / 2;
  const vw = Math.min(model.world.w, stageSize.w / camera.scale);
  const vh = Math.min(model.world.h, stageSize.h / camera.scale);
  const vx = Math.max(0, Math.min(model.world.w - vw, -camera.x / camera.scale));
  const vy = Math.max(0, Math.min(model.world.h - vh, -camera.y / camera.scale));
  return (
    <div className="rg-minimap" title="点击适应画布" onClick={onFit}>
      <svg viewBox={`0 0 ${W} ${H}`}>
        {model.zones.map((z, i) => (
          <rect key={i} className="rg-mini-zone" x={z.x * r + offX} y={z.y * r + offY} width={z.w * r} height={z.h * r} rx={2.5} />
        ))}
        {model.nodes.map((n) => (
          <rect
            key={n.id}
            className={visibleNodeIds.has(n.id) ? "rg-mini-node" : "rg-mini-node off"}
            x={(n.x + n.w / 2) * r + offX - 3.5}
            y={(n.y + n.h / 2) * r + offY - 2}
            width={7}
            height={4}
            rx={1.5}
          />
        ))}
        <rect className="rg-mini-viewport" x={vx * r + offX} y={vy * r + offY} width={Math.max(6, vw * r)} height={Math.max(5, vh * r)} rx={2} />
      </svg>
    </div>
  );
}
