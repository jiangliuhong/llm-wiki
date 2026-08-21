import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import RelationsView, { inTauriRuntime } from "./RelationsView";
import SettingsView from "./SettingsView";
import { useAgentChat } from "./useAgentChat";
import type { AvailableModelItem, ChatMessageItem, SessionInfo } from "./agentClient";

type View = "chat" | "documents" | "relations" | "imports" | "drafts" | "tasks" | "settings";

interface WorkspaceInfo {
  id: string;
  title: string;
  root: string;
  resolvedBy: string;
}

// --- Knowledge-base read types (mirror the Rust structs in store.rs) -------
interface KbFileSummary {
  id: number;
  path: string;
  language: string;
  size: number;
  indexedAt: string | null;
  chunkCount: number;
}
interface KbFileListPage {
  page: number;
  pageSize: number;
  total: number;
  files: KbFileSummary[];
}
interface KbChunkRef {
  id: number;
  chunkIndex: number;
  startLine: number;
  endLine: number;
}
interface KbFileContent {
  fileId: number;
  path: string;
  language: string;
  content: string;
  chunks: KbChunkRef[];
}
interface KbStats {
  dbPath: string;
  files: number;
  chunks: number;
  ftsRecords: number;
  vectorRecords: number;
  earliestIndexedAt: string | null;
  latestIndexedAt: string | null;
  tablesOk: boolean;
  vectorEnabled: boolean;
  byLanguage: Array<{ language: string; count: number }>;
  byRoot: Array<{ root: string; count: number }>;
}

interface Draft {
  id: number;
  draftId: string;
  workspaceId: string;
  targetPath: string;
  operationType: string;
  baseDocumentHash: string;
  generatedContent: string;
  sourceCitations: string[];
  sectionSlug: string;
  status: string;
  createdBy: string;
  createdAt: string;
  reviewedAt: string | null;
}

interface DraftApplyResult {
  draftId: string;
  targetPath: string;
  contentHash: string;
  bytesWritten: number;
  backupPath: string | null;
}

interface AttachmentInfo {
  name: string;
  size: number;
  isText: boolean;
  isExtractable: boolean;
}

interface IndexStats {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
  chunks: number;
  vectorEnabled: boolean;
}

interface KbConfigInfo {
  include: string[];
  defaults: string[];
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

type WorkspaceMode = "recent" | "open" | "create";

const WORKSPACE_STORAGE_KEY = "llm-wiki.desktop.workspaces";

const previewWorkspace: WorkspaceInfo = {
  id: "preview",
  title: "LLM Wiki",
  root: "本地工作空间",
  resolvedBy: "preview",
};

function readStoredWorkspaces(): WorkspaceInfo[] {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WorkspaceInfo => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === "string"
        && typeof candidate.title === "string"
        && typeof candidate.root === "string"
        && candidate.resolvedBy !== "default";
    });
  } catch {
    return [];
  }
}

function saveStoredWorkspaces(workspaces: WorkspaceInfo[]): void {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaces.slice(0, 8)));
  } catch {
    // localStorage is optional
  }
}

// --- Unified SVG Icon System ---
const ICON_PATHS: Record<string, React.ReactNode> = {
  spark: (<><path d="M12 2.8c.4 4.8 2.4 6.8 7.2 7.2-4.8.4-6.8 2.4-7.2 7.2-.4-4.8-2.4-6.8-7.2-7.2 4.8-.4 6.8-2.4 7.2-7.2Z" /><path d="M19 15.6c.2 2.1 1.1 3 3.2 3.2-2.1.2-3 1.1-3.2 3.2-.2-2.1-1.1-3-3.2-3.2 2.1-.2 3-1.1 3.2-3.2Z" fill="currentColor" stroke="none" /></>),
  file: (<><path d="M6 3.5h8.5L19 8v12.5H6v-17Z" /><path d="M14.5 3.5V8H19M9 12h7M9 15h7M9 18h4" /></>),
  network: (<><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></>),
  import: (<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>),
  draft: (<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>),
  tasks: (<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>),
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  search: (<><circle cx="10.5" cy="10.5" r="6.2" /><path d="m15.2 15.2 4.3 4.3" /></>),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></>),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m6.5 12.5 3.4 3.4 7.6-8" />,
  chevron: <path d="m7 9.5 5 5 5-5" />,
  folder: (<><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" /><path d="M3.5 11.5h17" /></>),
  copy: (<><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>),
  database: (<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></>),
  terminal: (<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>),
  shield: (<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>),
  link: <path d="m9.5 14.5 5-5M7.8 17.5l-1.3 1.3a3.7 3.7 0 1 1-5.3-5.3l3-3a3.7 3.7 0 0 1 5.3 0M16.2 6.5l1.3-1.3a3.7 3.7 0 1 1 5.3 5.3l-3 3a3.7 3.7 0 0 1-5.3 0" />,
  arrowUp: (<><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>),
  arrowRight: (<><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  pin: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
};

function Icon({ name, size = 16, strokeWidth = 1.7, className }: { name: string; size?: number; strokeWidth?: number; className?: string }): React.ReactElement {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name] ?? null}
    </svg>
  );
}

const navigation: Array<{ id: View; label: string; icon: string }> = [
  { id: "chat", label: "AI 问答", icon: "spark" },
  { id: "documents", label: "文档", icon: "file" },
  { id: "relations", label: "关系图谱", icon: "network" },
  { id: "imports", label: "文件导入", icon: "import" },
  { id: "drafts", label: "写入草稿", icon: "draft" },
  { id: "tasks", label: "后台任务", icon: "tasks" },
  { id: "settings", label: "设置", icon: "settings" },
];

export default function App(): React.ReactElement {
  const [view, setView] = useState<View>("chat");
  const [sidebarWidth, setSidebarWidth] = useState(238);
  const [isResizing, setIsResizing] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [knownWorkspaces, setKnownWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("recent");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceTitle, setWorkspaceTitle] = useState("我的知识工作区");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kbStats, setKbStats] = useState<KbStats | null>(null);
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);
  const [searchFocusTrigger, setSearchFocusTrigger] = useState(0);
  const [pendingDocFileId, setPendingDocFileId] = useState<number | null>(null);

  useEffect(() => {
    const stored = readStoredWorkspaces();
    setKnownWorkspaces(stored);
    if (!inTauriRuntime() || typeof invoke !== "function") {
      setWorkspace(previewWorkspace);
      return;
    }
    const restoreRecentWorkspace = (): Promise<WorkspaceInfo | null> => {
      const recent = stored[0];
      if (!recent) return Promise.resolve(null);
      return invoke<WorkspaceInfo>("workspace_open", { root: recent.root })
        .then((info) => (info.resolvedBy === "manual" ? info : null))
        .catch(() => null);
    };
    void restoreRecentWorkspace()
      .then((restored) => (restored ? Promise.resolve(restored) : invoke<WorkspaceInfo>("workspace_current")))
      .then((current) => {
        setWorkspace(current);
        if (current.resolvedBy !== "default") {
          setKnownWorkspaces((previous) => {
            const next = [current, ...previous.filter((item) => item.id !== current.id)];
            saveStoredWorkspaces(next);
            return next;
          });
        }
      })
      .catch((reason: unknown) => {
        const message = String(reason);
        if (message.includes("reading 'invoke'") || message.includes("invoke is not a function")) {
          setWorkspace(previewWorkspace);
          return;
        }
        setError(message);
      });
  }, []);

  useEffect(() => {
    if (!workspace || !inTauriRuntime() || typeof invoke !== "function") {
      setKbStats(null);
      return;
    }
    let cancelled = false;
    void invoke<KbStats>("kb_stats", { root: workspace.root })
      .then((stats) => { if (!cancelled) setKbStats(stats); })
      .catch(() => { if (!cancelled) setKbStats(null); });
    return () => { cancelled = true; };
  }, [workspace, statsRefreshKey]);

  const focusSearch = (): void => {
    setView("chat");
    setSearchFocusTrigger((n) => n + 1);
  };

  useEffect(() => {
    const onSearchShortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onSearchShortcut);
    return () => window.removeEventListener("keydown", onSearchShortcut);
  }, []);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [workspaceMenuOpen]);

  useEffect(() => {
    if (!isResizing) return;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  const rememberWorkspace = (value: WorkspaceInfo): void => {
    setWorkspace(value);
    setKnownWorkspaces((previous) => {
      const next = [value, ...previous.filter((item) => item.id !== value.id)];
      saveStoredWorkspaces(next);
      return next;
    });
  };

  const forgetWorkspace = async (target: WorkspaceInfo, purge: boolean): Promise<void> => {
    setWorkspaceError(null);
    if (purge) {
      if (!inTauriRuntime()) {
        setWorkspaceError("删除工作区文件需要在 Tauri 桌面端运行");
        return;
      }
      try {
        await invoke("workspace_delete", { root: target.root, purge: true });
      } catch (reason: unknown) {
        setWorkspaceError(String(reason));
        return;
      }
    }
    setKnownWorkspaces((previous) => {
      const next = previous.filter((item) => item.id !== target.id);
      saveStoredWorkspaces(next);
      return next;
    });
    if (workspace?.id === target.id) {
      setWorkspace(inTauriRuntime() ? null : previewWorkspace);
    }
  };

  const selectWorkspace = async (candidate: WorkspaceInfo): Promise<void> => {
    setWorkspaceError(null);
    if (candidate.id === workspace?.id) {
      setWorkspaceMenuOpen(false);
      return;
    }
    if (!inTauriRuntime()) {
      rememberWorkspace(candidate);
      setWorkspaceMenuOpen(false);
      return;
    }
    try {
      const opened = await invoke<WorkspaceInfo>("workspace_open", { root: candidate.root });
      rememberWorkspace(opened);
      setWorkspaceMenuOpen(false);
    } catch (reason: unknown) {
      setWorkspaceError(String(reason));
    }
  };

  const openWorkspace = async (): Promise<void> => {
    const root = workspacePath.trim();
    if (!root) {
      setWorkspaceError("请输入工作区目录路径");
      return;
    }
    if (!inTauriRuntime()) {
      setWorkspaceError("工作区打开功能需要在 Tauri 桌面端运行");
      return;
    }
    try {
      const opened = await invoke<WorkspaceInfo>("workspace_open", { root });
      rememberWorkspace(opened);
      setWorkspacePath("");
      setWorkspaceMode("recent");
      setWorkspaceMenuOpen(false);
    } catch (reason: unknown) {
      setWorkspaceError(String(reason));
    }
  };

  const createWorkspace = async (): Promise<void> => {
    const root = workspacePath.trim();
    const titleValue = workspaceTitle.trim();
    if (!root || !titleValue) {
      setWorkspaceError("请输入工作区名称和目录路径");
      return;
    }
    if (!inTauriRuntime()) {
      setWorkspaceError("工作区创建功能需要在 Tauri 桌面端运行");
      return;
    }
    try {
      const created = await invoke<WorkspaceInfo>("workspace_create", { title: titleValue, root });
      rememberWorkspace(created);
      setWorkspacePath("");
      setWorkspaceMode("recent");
      setWorkspaceMenuOpen(false);
    } catch (reason: unknown) {
      setWorkspaceError(String(reason));
    }
  };

  const resizeSidebar = (clientX: number): void => {
    setSidebarWidth(Math.min(420, Math.max(190, clientX)));
  };

  return (
    <main className={isResizing ? "desktop-shell is-resizing" : "desktop-shell"} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <div className="body-grid">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="workspace-selector">
              <button className="workspace-identity" aria-label="切换工作空间" aria-expanded={workspaceMenuOpen} onClick={() => { setWorkspaceMenuOpen((open) => !open); setWorkspaceError(null); }}>
                <span className="workspace-avatar">{workspace?.title.slice(0, 2) ?? "LW"}</span>
                <span className="workspace-info-text">
                  <strong>{workspace?.title ?? "LLM Wiki"}</strong>
                  <small>{workspace?.root ?? "本地知识工作台"}</small>
                </span>
                <Icon name="chevron" size={14} className="chevron-icon" />
              </button>
            </div>
          </div>
          <div className="nav-group">
            <span className="nav-label">工作台</span>
            <nav aria-label="主导航">
              {navigation.map((item) => (
                <button
                  className={view === item.id ? "nav-item active" : "nav-item"}
                  key={item.id}
                  onClick={() => { setView(item.id); setPendingDocFileId(null); }}
                >
                  <span className="nav-item-icon"><Icon name={item.icon} size={15} /></span>
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
        </aside>

        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={190}
          aria-valuemax={420}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsResizing(true);
          }}
          onPointerMove={(event) => {
            event.preventDefault();
            if (isResizing) resizeSidebar(event.clientX);
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            setIsResizing(false);
          }}
          onPointerCancel={() => setIsResizing(false)}
          onDoubleClick={() => setSidebarWidth(238)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); resizeSidebar(sidebarWidth - 12); }
            if (event.key === "ArrowRight") { event.preventDefault(); resizeSidebar(sidebarWidth + 12); }
            if (event.key === "Home") { event.preventDefault(); setSidebarWidth(190); }
            if (event.key === "End") { event.preventDefault(); setSidebarWidth(420); }
          }}
        />

        <section className="main-area">
          <div className={view === "chat" || view === "documents" || view === "relations" || view === "settings" ? "content-pane documents-pane" : "content-pane"}>
            {error && <div className="error-banner">Core 尚未连接：{error}</div>}
            {view === "chat" && <ChatView workspace={workspace} focusTrigger={searchFocusTrigger} onOpenDocument={(fileId) => { setPendingDocFileId(fileId); setView("documents"); }} />}
            {view === "documents" && (
              <DocumentsView
                workspace={workspace}
                focusFileId={pendingDocFileId}
                onAskAI={() => setView("chat")}
                onOpenImports={() => setView("imports")}
                onOpenSettings={() => setView("settings")}
                onIndexed={() => setStatsRefreshKey((k) => k + 1)}
              />
            )}
            {view === "relations" && (
              <RelationsView
                workspace={workspace}
                onAskAI={() => setView("chat")}
                onOpenDocuments={() => setView("documents")}
                onIndexed={() => setStatsRefreshKey((k) => k + 1)}
              />
            )}
            {view === "imports" && <ImportsView workspace={workspace} onImported={() => setStatsRefreshKey((k) => k + 1)} />}
            {view === "drafts" && <DraftsView workspace={workspace} />}
            {view === "tasks" && <TasksView workspace={workspace} onIndexed={() => setStatsRefreshKey((k) => k + 1)} />}
            {view === "settings" && <SettingsView workspace={workspace} kbStats={kbStats} knownWorkspaceCount={knownWorkspaces.length} onOpenWorkspaceMenu={() => setWorkspaceMenuOpen(true)} onIndexed={() => setStatsRefreshKey((k) => k + 1)} />}
          </div>
        </section>
      </div>

      <footer className="statusbar">
        <div className="statusbar-left">
          <span className={kbStats?.tablesOk ? "status-dot" : "status-dot idle"} />
          <span>{workspace?.title ?? "未选择工作区"}</span>
          {kbStats && kbStats.tablesOk ? (
            <span className="statusbar-pill">{kbStats.files} 篇文档 · {kbStats.chunks} 切片</span>
          ) : (
            <span className="statusbar-pill">{workspace ? "尚未索引" : "无连接"}</span>
          )}
        </div>
        <div className="statusbar-center">
          <span>⌘K 快速问答</span>
        </div>
        <div className="statusbar-right">
          <span className="statusbar-pill">Rust Core</span>
          <span className="statusbar-pill">SQLite FTS5</span>
          <span className="statusbar-pill">Pi Protocol v2</span>
        </div>
      </footer>

      {workspaceMenuOpen && (
        <>
          <button className="workspace-modal-backdrop" type="button" aria-label="关闭工作区选择器" onClick={() => setWorkspaceMenuOpen(false)} />
          <WorkspaceMenu mode={workspaceMode} setMode={setWorkspaceMode} workspace={workspace} workspaces={knownWorkspaces} onSelect={selectWorkspace} onDelete={forgetWorkspace} path={workspacePath} setPath={setWorkspacePath} title={workspaceTitle} setTitle={setWorkspaceTitle} onOpen={openWorkspace} onCreate={createWorkspace} onClose={() => setWorkspaceMenuOpen(false)} error={workspaceError} />
        </>
      )}
    </main>
  );
}

interface WorkspaceMenuProps {
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  workspace: WorkspaceInfo | null;
  workspaces: WorkspaceInfo[];
  onSelect: (workspace: WorkspaceInfo) => Promise<void>;
  onDelete: (workspace: WorkspaceInfo, purge: boolean) => Promise<void>;
  path: string;
  setPath: (path: string) => void;
  title: string;
  setTitle: (title: string) => void;
  onOpen: () => Promise<void>;
  onCreate: () => Promise<void>;
  onClose: () => void;
  error: string | null;
}

function WorkspaceMenu({ mode, setMode, workspace, workspaces, onSelect, onDelete, path, setPath, title, setTitle, onOpen, onCreate, onClose, error }: WorkspaceMenuProps): React.ReactElement {
  const [pendingDelete, setPendingDelete] = useState<WorkspaceInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async (target: WorkspaceInfo, purge: boolean): Promise<void> => {
    setDeleting(true);
    try {
      await onDelete(target, purge);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const [picking, setPicking] = useState(false);
  const pickDirectory = async (): Promise<void> => {
    if (picking || !inTauriRuntime()) return;
    setPicking(true);
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") setPath(selected);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="workspace-menu" role="dialog" aria-label="工作区选择器">
      <div className="workspace-menu-header">
        <div>
          <strong>工作空间管理</strong>
          <small>{workspace?.root ?? "选择或创建一个本地知识库工作区"}</small>
        </div>
        <button className="menu-close" onClick={onClose} aria-label="关闭工作区选择器">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="workspace-tabs">
        <button className={mode === "recent" ? "active" : ""} onClick={() => setMode("recent")}>最近使用</button>
        <button className={mode === "open" ? "active" : ""} onClick={() => setMode("open")}>打开目录</button>
        <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>新建工作区</button>
      </div>
      {mode === "recent" && (
        <div className="workspace-list">
          {workspaces.length === 0 && <p className="menu-empty" style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)", fontSize: "12px" }}>还没有历史记录，打开一个本地工作区开始使用。</p>}
          {workspaces.map((item) => {
            if (pendingDelete?.id === item.id) {
              return (
                <div key={item.id} className="workspace-entry-confirm">
                  <div className="workspace-entry-confirm-message">
                    <strong>{item.title}</strong>
                    <span>删除后不可恢复。「移除记录」仅清理列表，「删除文件」将清理 .llm-wiki 配置。</span>
                  </div>
                  <div className="workspace-entry-confirm-actions">
                    <button className="confirm-remove" disabled={deleting} onClick={() => void handleDelete(item, false)}>移除记录</button>
                    <button className="confirm-purge" disabled={deleting} onClick={() => void handleDelete(item, true)}>删除文件</button>
                    <button className="confirm-cancel" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
                  </div>
                </div>
              );
            }
            return (
              <div key={item.id} className="workspace-entry-row">
                <button className={item.id === workspace?.id ? "workspace-entry active" : "workspace-entry"} onClick={() => void onSelect(item)}>
                  <span className="workspace-entry-avatar">{item.title.slice(0, 2)}</span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.root}</small>
                  </span>
                  {item.id === workspace?.id && <span className="workspace-check"><Icon name="check" size={14} /></span>}
                </button>
                <button className="workspace-entry-delete" aria-label={`删除工作区 ${item.title}`} disabled={deleting} onClick={() => setPendingDelete(item)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {(mode === "open" || mode === "create") && (
        <div className="workspace-form">
          {mode === "create" && (
            <label>
              工作区名称
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品架构知识库" />
            </label>
          )}
          <label>
            目录路径
            <div className="workspace-path-row">
              <input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void (mode === "open" ? onOpen() : onCreate()); }} placeholder="/Users/username/Workspace/docs" autoFocus />
              <button type="button" className="workspace-path-browse" disabled={picking || !inTauriRuntime()} title={inTauriRuntime() ? "选择目录" : "目录选择需要在桌面端运行"} onClick={() => void pickDirectory()}>
                浏览…
              </button>
            </div>
          </label>
          <small className="workspace-help">{mode === "create" ? "将在该目录自动创建 .llm-wiki 知识库配置与索引数据库" : "目标目录需包含或初始化 .llm-wiki 知识库"}</small>
          <button className="workspace-submit" onClick={() => void (mode === "open" ? onOpen() : onCreate())}>
            {mode === "create" ? "创建并打开" : "打开工作区"}
          </button>
        </div>
      )}
      {error && <p className="workspace-menu-error">{error}</p>}
    </div>
  );
}

// --- AI chat helpers ---
function conversationTime(isoOrTimestamp: string | number): string {
  const ts = typeof isoOrTimestamp === "number" ? isoOrTimestamp : new Date(isoOrTimestamp).getTime();
  if (Number.isNaN(ts)) return "刚刚";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return "刚刚";
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} 分钟前`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)} 小时前`;
  if (deltaSec < 86400 * 7) return `${Math.floor(deltaSec / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}

function dayBucket(isoOrTimestamp: string | number): string {
  const ts = typeof isoOrTimestamp === "number" ? isoOrTimestamp : new Date(isoOrTimestamp).getTime();
  if (Number.isNaN(ts)) return "未知时间";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "今天";
  if (ts >= startOfToday - 86400000) return "昨天";
  if (ts >= startOfToday - 6 * 86400000) return "本周";
  return "更早";
}

function ChatView({
  workspace,
  focusTrigger,
  onOpenDocument,
}: {
  workspace: WorkspaceInfo | null;
  focusTrigger: number;
  onOpenDocument: (fileId: number) => void;
}): React.ReactElement {
  const {
    sessions,
    activeSessionId,
    activeSession,
    messages,
    availableModels,
    loadingSession,
    sending,
    streaming,
    error: agentError,
    selectSession,
    sendMessage,
    cancelPrompt,
    deleteSession,
    togglePin,
  } = useAgentChat({ workspaceRoot: workspace?.root ?? null });

  const [filterQuery, setFilterQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "week">("all");
  const [query, setQuery] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState<string>("pi-default");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, AvailableModelItem[]>();
    for (const m of availableModels) {
      const providerKey = m.provider;
      const list = groups.get(providerKey) ?? [];
      list.push(m);
      groups.set(providerKey, list);
    }
    return Array.from(groups.entries()).map(([provider, models]) => {
      const providerLabel =
        provider === "openai-codex"
          ? "OpenAI Codex"
          : provider === "anthropic"
            ? "Anthropic"
            : provider === "openai"
              ? "OpenAI"
              : provider === "deepseek"
                ? "DeepSeek"
                : provider === "google"
                  ? "Google Gemini"
                  : provider.toUpperCase();
      return {
        provider,
        label: providerLabel,
        models,
      };
    });
  }, [availableModels]);

  useEffect(() => {
    if (activeSession?.model?.id && activeSession.model.id !== "default" && activeSession.model.id !== "") {
      const key = `${activeSession.model.provider}:${activeSession.model.id}`;
      const exists = availableModels.some((m) => `${m.provider}:${m.id}` === key);
      if (exists) setSelectedModelKey(key);
    }
  }, [activeSession, availableModels]);

  const selectedModelConfig = useMemo(() => {
    if (selectedModelKey === "pi-default") return undefined;
    const found = availableModels.find((m) => `${m.provider}:${m.id}` === selectedModelKey);
    if (found) {
      return {
        provider: found.provider,
        id: found.id,
      };
    }
    return undefined;
  }, [selectedModelKey, availableModels]);

  useEffect(() => {
    if (focusTrigger > 0) textareaRef.current?.focus();
  }, [focusTrigger]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSessionId, messages.length, streaming.text, streaming.thinking]);

  const handleSend = async (textToSend?: string): Promise<void> => {
    const text = (textToSend ?? query).trim();
    if (!text || !workspace || sending) return;
    setQuery("");
    await sendMessage(text, selectedModelConfig);
  };

  const visibleSessions = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    return sessions
      .filter((s) => {
        if (q && !s.title.toLowerCase().includes(q)) return false;
        const ts = new Date(s.updatedAt).getTime();
        if (filter === "today") return ts >= startOfToday;
        if (filter === "week") return ts >= startOfToday - 6 * 86400000;
        return true;
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [sessions, filterQuery, filter]);

  const sessionGroups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of visibleSessions) {
      const label = dayBucket(s.updatedAt);
      const arr = map.get(label) ?? [];
      arr.push(s);
      map.set(label, arr);
    }
    return Array.from(map.entries());
  }, [visibleSessions]);

  return (
    <div className="chat-page">
      <aside className="library">
        <div className="library-head">
          <div className="section-title-row">
            <div>
              <span className="section-title">历史对话</span>
              <span className="section-count">{sessions.length}</span>
            </div>
            <div className="small-actions">
              <button
                className="lib-icon-btn"
                title="新建对话"
                onClick={() => {
                  selectSession(null);
                  textareaRef.current?.focus();
                }}
              >
                <Icon name="plus" size={15} />
              </button>
            </div>
          </div>
          <label className="library-search">
            <Icon name="search" size={14} />
            <input
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="搜索历史问答记录"
            />
          </label>
        </div>
        <div className="library-filter">
          {(["all", "today", "week"] as const).map((key) => (
            <button
              key={key}
              className={filter === key ? "filter-chip active" : "filter-chip"}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "全部" : key === "today" ? "今天" : "本周"}
            </button>
          ))}
        </div>
        <div className="doc-scroll">
          {visibleSessions.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 16px", color: "var(--text-muted)", fontSize: "12px", lineHeight: "1.6" }}>
              {sessions.length === 0 ? (
                <>暂无历史对话<br />提问后将自动沉淀在此</>
              ) : (
                <>未匹配到对话<br />请尝试更换搜索词</>
              )}
            </div>
          ) : (
            sessionGroups.map(([label, items]) => (
              <div key={label}>
                <div className="doc-group-label">{label}</div>
                {items.map((s) => (
                  <article
                    key={s.sessionId}
                    className={s.sessionId === activeSessionId ? "conv-item active" : "conv-item"}
                    onClick={() => selectSession(s.sessionId)}
                  >
                    <div className="conv-icon">
                      <Icon name="spark" size={14} />
                    </div>
                    <div className="conv-copy">
                      <div className="conv-title">
                        {s.title}
                        {s.pinned && <span className="conv-pin-badge">★</span>}
                      </div>
                      <div className="conv-meta">
                        <span>{conversationTime(s.updatedAt)}</span>
                      </div>
                    </div>
                    <button
                      className="conv-delete"
                      aria-label={`删除对话 ${s.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteSession(s.sessionId);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </article>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="chat-detail">
        <div className="reader-toolbar">
          <div className="toolbar-breadcrumb">
            <span className="crumb">
              <span>{workspace?.title ?? "LLM Wiki"}</span>
            </span>
            <span className="crumb">
              <em>/</em>
              <span className="current">{activeSession ? activeSession.title : "新对话"}</span>
            </span>
          </div>
          <div className="toolbar-spacer" />
          {activeSession && (
            <>
              <span className="chat-meta-chip">
                {messages.length} 条消息
              </span>
              <button
                className="tool-button"
                title={activeSession.pinned ? "取消置顶" : "置顶对话"}
                onClick={() => void togglePin(activeSession.sessionId)}
              >
                <Icon name="pin" size={13} />
                <span>{activeSession.pinned ? "已置顶" : "置顶"}</span>
              </button>
              <button
                className="tool-button"
                onClick={() => void deleteSession(activeSession.sessionId)}
              >
                <Icon name="trash" size={13} />
                <span>删除</span>
              </button>
            </>
          )}
        </div>

        <div className="reader-scroll" ref={threadRef}>
          {activeSessionId === null && messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="hero-icon">
                <Icon name="spark" size={28} />
              </div>
              <h2>向 Pi 智能体发起问答</h2>
              <p>
                回答基于本地知识库已索引文档，由 Pi CLI 运行时流式生成，支持工具受控调用与安全草稿写入。
              </p>
              <div className="prompt-suggestions">
                <button
                  type="button"
                  className="prompt-chip"
                  onClick={() => {
                    const prompt = "总结当前工作区核心知识库的内容概要";
                    setQuery(prompt);
                    void handleSend(prompt);
                  }}
                >
                  <Icon name="spark" size={12} />
                  总结工作区核心内容
                </button>
                <button
                  type="button"
                  className="prompt-chip"
                  onClick={() => {
                    const prompt = "列出知识库中所有核心架构与模块规范";
                    setQuery(prompt);
                    void handleSend(prompt);
                  }}
                >
                  <Icon name="network" size={12} />
                  列出系统架构与模块
                </button>
                <button
                  type="button"
                  className="prompt-chip"
                  onClick={() => {
                    const prompt = "检索近期更新或重要的文档并给出清单";
                    setQuery(prompt);
                    void handleSend(prompt);
                  }}
                >
                  <Icon name="file" size={12} />
                  查询近期重要文档
                </button>
                <button
                  type="button"
                  className="prompt-chip"
                  onClick={() => {
                    const prompt = "检索工作区中的 API 与接口设计规范";
                    setQuery(prompt);
                    void handleSend(prompt);
                  }}
                >
                  <Icon name="terminal" size={12} />
                  检索 API 与接口设计
                </button>
              </div>
            </div>
          ) : (
            <div className="chat-thread-inner">
              {loadingSession ? (
                <p className="msg-status">正在加载会话记录…</p>
              ) : (
                <>
                  {messages.map((m) =>
                    m.role === "user" ? (
                      <div className="msg-user" key={m.id}>
                        <div className="msg-user-bubble">{m.text}</div>
                      </div>
                    ) : (
                      <AssistantMessage key={m.id} message={m} onOpenDocument={onOpenDocument} />
                    ),
                  )}

                  {sending && (
                    <div className="msg-assistant">
                      <div className="msg-avatar">
                        <Icon name="spark" size={16} />
                      </div>
                      <div className="msg-assistant-body">
                        {Boolean(streaming.thinking) && (
                          <details className="msg-thinking" open={streaming.phase === "thinking"}>
                            <summary>
                              {streaming.phase === "thinking" ? "正在思考…" : "查看思考过程"}
                            </summary>
                            <div className="msg-thinking-body">{streaming.thinking}</div>
                          </details>
                        )}
                        {streaming.toolCalls.length > 0 && (
                          <div className="msg-tool-list">
                            {streaming.toolCalls.map((tool) => (
                              <span
                                key={tool.toolCallId}
                                className={
                                  tool.result === undefined
                                    ? "msg-tool-pill executing"
                                    : tool.isError
                                      ? "msg-tool-pill error"
                                      : "msg-tool-pill"
                                }
                                title={JSON.stringify(tool.args)}
                              >
                                <Icon name="settings" size={12} /> {tool.toolName} {tool.result === undefined ? "…" : "✓"}
                              </span>
                            ))}
                          </div>
                        )}
                        {streaming.text ? (
                          <div className="msg-pi-streaming">{streaming.text}</div>
                        ) : !streaming.thinking && streaming.toolCalls.length === 0 ? (
                          <p className="msg-status">Pi 正在检索并思考…</p>
                        ) : null}
                      </div>
                    </div>
                  )}

                  {agentError && <div className="msg-error">请求失败：{agentError}</div>}
                </>
              )}
            </div>
          )}
        </div>

        <div className="chat-composer">
          <div className="composer-inner">
            <textarea
              ref={textareaRef}
              placeholder={
                !workspace
                  ? "请先选择一个工作区"
                  : "向 Pi 智能体提问，按 Enter 发送…"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={!workspace}
            />
            <div className="composer-toolbar">
              <div className="composer-toolbar-left">
                <span className="composer-tool">{workspace ? workspace.title : "未选择工作区"}</span>
                <div className="model-selector-chip" title="选择 Pi 已认证模型">
                  <span className="model-selector-spark"><Icon name="spark" size={12} /></span>
                  <select
                    value={selectedModelKey}
                    onChange={(e) => setSelectedModelKey(e.target.value)}
                    disabled={!workspace || sending || availableModels.length === 0}
                    aria-label="选择模型"
                  >
                    <option value="pi-default">Pi 默认模型 (全局首选)</option>
                    {availableModels.length === 0 ? (
                      <option value="" disabled>
                        未检测到已认证模型 (在 Pi CLI 登录)
                      </option>
                    ) : (
                      modelGroups.map((group) => (
                        <optgroup key={group.provider} label={group.label}>
                          {group.models.map((m) => (
                            <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                              {m.name || m.id} {m.isDefault ? "★" : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))
                    )}
                  </select>
                  <span className="model-selector-arrow">▼</span>
                </div>
              </div>
              {sending ? (
                <button
                  className="send-button stop"
                  aria-label="停止生成"
                  onClick={() => void cancelPrompt()}
                >
                  <Icon name="stop" size={14} />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送"
                  disabled={!workspace || !query.trim() || sending}
                  onClick={() => void handleSend()}
                >
                  <Icon name="arrowUp" size={15} />
                </button>
              )}
            </div>
          </div>
          <p className="composer-note">
            Pi 生成式问答 · Enter 发送 · Shift+Enter 换行
          </p>
        </div>
      </section>
    </div>
  );
}

const AssistantMessage = memo(function AssistantMessage({
  message,
  onOpenDocument: _onOpenDocument,
}: {
  message: ChatMessageItem;
  onOpenDocument: (fileId: number) => void;
}): React.ReactElement {
  return (
    <div className="msg-assistant">
      <div className="msg-avatar">
        <Icon name="spark" size={16} />
      </div>
      <div className="msg-assistant-body">
        {Boolean(message.thinking) && (
          <details className="msg-thinking">
            <summary>查看思考过程</summary>
            <div className="msg-thinking-body">{message.thinking}</div>
          </details>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="msg-tool-list">
            {message.toolCalls.map((tool) => (
              <span
                key={tool.toolCallId}
                className={tool.isError ? "msg-tool-pill error" : "msg-tool-pill"}
                title={JSON.stringify(tool.args)}
              >
                <Icon name="settings" size={12} /> {tool.toolName}
              </span>
            ))}
          </div>
        )}
        {message.text ? (
          <div className="msg-pi-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        ) : !message.thinking ? (
          <p className="msg-status">未返回文本输出。</p>
        ) : null}
        {message.errorMessage && (
          <div className="msg-error">生成未完成：{message.errorMessage}</div>
        )}
      </div>
    </div>
  );
});

// --- Documents View ---
interface HeadingEntry {
  level: number;
  text: string;
  slug: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!children) return "";
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

function extractHeadings(markdown: string): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;
    const level = m[1].length;
    const text = m[2].trim();
    if (!text) continue;
    headings.push({ level, text, slug: slugify(text) });
  }
  return headings;
}

function splitFrontMatter(markdown: string): { title: string | null; subtitle: string | null; body: string } {
  if (!markdown.startsWith("---")) return { title: null, subtitle: null, body: markdown };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { title: null, subtitle: null, body: markdown };
  const rawFm = markdown.slice(3, end);
  const body = markdown.slice(end + 4).replace(/^\r?\n/, "");
  let title: string | null = null;
  let subtitle: string | null = null;
  for (const line of rawFm.split(/\r?\n/)) {
    const titleMatch = /^title:\s*["']?(.*?)["']?$/.exec(line);
    if (titleMatch && titleMatch[1]) title = titleMatch[1].trim();
    const descMatch = /^(?:description|subtitle):\s*["']?(.*?)["']?$/.exec(line);
    if (descMatch && descMatch[1]) subtitle = descMatch[1].trim();
  }
  return { title, subtitle, body };
}

function docName(path: string): string {
  const clean = path.replace(/\\/g, "/");
  const file = clean.split("/").pop() ?? clean;
  return file.replace(/\.[^.]+$/, "");
}

function parentLabel(path: string): string {
  const clean = path.replace(/\\/g, "/");
  const parts = clean.split("/");
  if (parts.length <= 1) return "根目录";
  return parts.slice(0, -1).join(" / ");
}

function DocumentsEmptyState({
  workspace,
  includeDirs,
  defaultDirs,
  indexing,
  dirSaving,
  indexError,
  dirError,
  indexFeedback,
  onReindex,
  onAddDir,
  onRemoveDir,
  onResetDirs,
  onOpenImports,
  onOpenSettings,
}: {
  workspace: WorkspaceInfo | null;
  includeDirs: string[];
  defaultDirs: string[];
  indexing: boolean;
  dirSaving: boolean;
  indexError: string | null;
  dirError: string | null;
  indexFeedback: string | null;
  onReindex: () => void;
  onAddDir: (dir: string, reindex?: boolean) => void;
  onRemoveDir: (dir: string, reindex?: boolean) => void;
  onResetDirs: () => void;
  onOpenImports: () => void;
  onOpenSettings: () => void;
}): React.ReactElement {
  const [newDirInput, setNewDirInput] = useState("");
  const presets = ["wiki", "docs", "kb", "knowledge", "notes"];
  const availablePresets = presets.filter((p) => !includeDirs.includes(p));

  const handleAddSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const val = newDirInput.trim();
    if (!val) return;
    onAddDir(val, true);
    setNewDirInput("");
  };

  return (
    <div className="doc-empty-container">
      <div className="doc-empty-card">
        <div className="doc-empty-icon">
          <Icon name="file" size={28} />
        </div>
        <h2>未检测到已索引文档</h2>
        <p className="doc-empty-desc">
          当前工作区扫描目录下暂无 Markdown 或文本文件。您可以配置已有文档目录快速构建索引，或直接导入外部知识文件。
        </p>

        {workspace && (
          <div className="doc-empty-root-box">
            <Icon name="folder" size={13} />
            <span>当前工作区：</span>
            <code>{workspace.root}</code>
          </div>
        )}

        <div className="doc-quick-dirs-section">
          <div className="doc-quick-dirs-head">
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Icon name="folder" size={14} />
              <span>知识库扫描目录配置</span>
            </div>
            <small>{includeDirs.length} 个配置目录</small>
          </div>

          <div className="doc-quick-chips">
            {includeDirs.map((dir) => (
              <span key={dir} className="doc-dir-chip">
                <Icon name="folder" size={12} />
                <code>{dir}/</code>
                <button
                  type="button"
                  title={`移除 ${dir}`}
                  disabled={dirSaving || includeDirs.length <= 1}
                  onClick={() => onRemoveDir(dir, true)}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>

          <form className="doc-quick-add-form" onSubmit={handleAddSubmit}>
            <div className="doc-quick-input-wrapper">
              <Icon name="folder" size={14} className="doc-quick-input-icon" />
              <input
                value={newDirInput}
                onChange={(e) => setNewDirInput(e.target.value)}
                placeholder="输入工作区内的相对目录 (如 docs、notes 或 packages/kb)"
                disabled={!workspace || dirSaving || indexing}
              />
            </div>
            <button type="submit" disabled={!workspace || dirSaving || indexing || !newDirInput.trim()}>
              <Icon name="plus" size={13} />
              添加并扫描
            </button>
          </form>

          {availablePresets.length > 0 && (
            <div className="doc-presets-row">
              <span>快速添加常用目录：</span>
              {availablePresets.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="doc-preset-btn"
                  disabled={!workspace || dirSaving || indexing}
                  onClick={() => onAddDir(p, true)}
                >
                  + {p}
                </button>
              ))}
              {includeDirs.length > 0 && !defaultDirs.every((d) => includeDirs.includes(d)) && (
                <button type="button" className="doc-preset-btn" onClick={onResetDirs} style={{ marginLeft: "auto" }}>
                  恢复默认
                </button>
              )}
            </div>
          )}
        </div>

        <div className="doc-empty-actions">
          <button className="primary-button" disabled={!workspace || indexing} onClick={onReindex}>
            <Icon name="refresh" size={14} className={indexing ? "spin" : ""} />
            {indexing ? "正在扫描索引中…" : "立即重新扫描索引"}
          </button>
          <button className="tool-button" onClick={onOpenImports}>
            <Icon name="import" size={14} />
            导入外部文档
          </button>
          <button className="tool-button" onClick={onOpenSettings}>
            <Icon name="settings" size={14} />
            工作区设置
          </button>
        </div>

        {dirError && <div className="doc-status-banner error">目录配置错误：{dirError}</div>}
        {indexError && <div className="doc-status-banner error">索引错误：{indexError}</div>}
        {indexFeedback && <div className="doc-status-banner success">{indexFeedback}</div>}
      </div>
    </div>
  );
}

function DocumentsView({
  workspace,
  onAskAI,
  onOpenImports,
  onOpenSettings,
  onIndexed,
  focusFileId = null,
}: {
  workspace: WorkspaceInfo | null;
  onAskAI: () => void;
  onOpenImports: () => void;
  onOpenSettings: () => void;
  onIndexed: () => void;
  focusFileId?: number | null;
}): React.ReactElement {
  const [page, setPage] = useState<LoadState<KbFileListPage>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<number | null>(focusFileId);
  const [content, setContent] = useState<LoadState<KbFileContent>>({ status: "loading" });
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexFeedback, setIndexFeedback] = useState<string | null>(null);
  const [includeDirs, setIncludeDirs] = useState<string[]>([]);
  const [defaultDirs, setDefaultDirs] = useState<string[]>([]);
  const [dirSaving, setDirSaving] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [docReloadKey, setDocReloadKey] = useState(0);

  useEffect(() => {
    if (!workspace || !inTauriRuntime()) {
      setPage({ status: "error", message: "请先选择一个工作区" });
      return;
    }
    let cancelled = false;
    setPage({ status: "loading" });
    void invoke<KbFileListPage>("documents_list", { root: workspace.root })
      .then((data) => {
        if (!cancelled) {
          setPage({ status: "ready", data });
          setSelectedId(focusFileId);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPage({ status: "error", message: String(reason) });
      });

    void invoke<KbConfigInfo>("kb_config_get", { root: workspace.root })
      .then((config) => {
        if (!cancelled) {
          setIncludeDirs(config.include);
          setDefaultDirs(config.defaults);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [workspace, docReloadKey, focusFileId]);

  useEffect(() => {
    if (selectedId === null || !workspace) {
      setContent({ status: "loading" });
      return;
    }
    let cancelled = false;
    setContent({ status: "loading" });
    void invoke<KbFileContent>("document_read", { root: workspace.root, fileId: selectedId })
      .then((data) => {
        if (cancelled) return;
        if (data) setContent({ status: "ready", data });
        else setContent({ status: "error", message: "文档内容为空或不存在" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setContent({ status: "error", message: String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, selectedId]);

  const runIndex = async (reset = false): Promise<void> => {
    if (!workspace || !inTauriRuntime() || indexing) return;
    setIndexing(true);
    setIndexError(null);
    setIndexFeedback(null);
    try {
      const stats = await invoke<IndexStats>("index_run", { root: workspace.root, reset });
      setIndexFeedback(`索引完成：扫描 ${stats.scanned} 篇，新增 ${stats.added} 篇，更新 ${stats.updated} 篇，切片 ${stats.chunks} 个`);
      onIndexed();
      setDocReloadKey((k) => k + 1);
      setTimeout(() => setIndexFeedback(null), 5000);
    } catch (reason: unknown) {
      setIndexError(String(reason));
    } finally {
      setIndexing(false);
    }
  };

  const saveIncludeDirs = async (next: string[], reindexAfter = false): Promise<void> => {
    if (!workspace || dirSaving) return;
    setDirSaving(true);
    setDirError(null);
    try {
      const config = await invoke<KbConfigInfo>("kb_config_set_include", { root: workspace.root, include: next });
      setIncludeDirs(config.include);
      if (reindexAfter) {
        await runIndex();
      }
    } catch (reason: unknown) {
      setDirError(String(reason));
    } finally {
      setDirSaving(false);
    }
  };

  const addDir = (dir: string, reindexAfter = false): void => {
    const cleaned = dir.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    if (includeDirs.includes(cleaned)) {
      setDirError(`目录 "${cleaned}" 已在索引列表中`);
      return;
    }
    void saveIncludeDirs([...includeDirs, cleaned], reindexAfter);
  };

  const removeDir = (dir: string, reindexAfter = false): void => {
    if (includeDirs.length <= 1) {
      setDirError("至少需要保留一个索引目录");
      return;
    }
    const next = includeDirs.filter((d) => d !== dir);
    void saveIncludeDirs(next, reindexAfter);
  };

  if (page.status === "loading") return <div className="empty-state"><div className="hero-icon"><Icon name="file" size={24} /></div><h2>加载文档列表中…</h2></div>;
  if (page.status === "error") return <div className="empty-state"><div className="hero-icon"><Icon name="file" size={24} /></div><h2>无法加载文档</h2><p>{page.message}</p></div>;

  const list = page.data;
  if (list.total === 0) {
    return (
      <DocumentsEmptyState
        workspace={workspace}
        includeDirs={includeDirs}
        defaultDirs={defaultDirs}
        indexing={indexing}
        dirSaving={dirSaving}
        indexError={indexError}
        dirError={dirError}
        indexFeedback={indexFeedback}
        onReindex={() => void runIndex()}
        onAddDir={addDir}
        onRemoveDir={removeDir}
        onResetDirs={() => void saveIncludeDirs(defaultDirs, true)}
        onOpenImports={onOpenImports}
        onOpenSettings={onOpenSettings}
      />
    );
  }

  const selectedFile = list.files.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="documents-page">
      <Library
        files={list.files}
        total={list.total}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onReindex={() => void runIndex()}
        indexing={indexing}
        onOpenImports={onOpenImports}
        includeDirs={includeDirs}
        defaultDirs={defaultDirs}
        dirSaving={dirSaving}
        dirError={dirError}
        onAddDir={addDir}
        onRemoveDir={removeDir}
        onResetDirs={() => void saveIncludeDirs(defaultDirs, true)}
        indexFeedback={indexFeedback}
      />
      <ReaderShell file={selectedFile} content={content} onAskAI={onAskAI} />
    </div>
  );
}

function Library({
  files,
  total,
  selectedId,
  onSelect,
  onReindex,
  indexing,
  onOpenImports,
}: {
  files: KbFileSummary[];
  total: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onReindex: () => void;
  indexing: boolean;
  onOpenImports: () => void;
  includeDirs: string[];
  defaultDirs: string[];
  dirSaving: boolean;
  dirError: string | null;
  onAddDir: (dir: string, reindex?: boolean) => void;
  onRemoveDir: (dir: string, reindex?: boolean) => void;
  onResetDirs: () => void;
  indexFeedback: string | null;
}): React.ReactElement {
  const [filterQuery, setFilterQuery] = useState("");

  const filteredFiles = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filterQuery]);

  return (
    <aside className="library">
      <div className="library-head">
        <div className="section-title-row">
          <div>
            <span className="section-title">文档列表</span>
            <span className="section-count">{total}</span>
          </div>
          <div className="small-actions">
            <button
              className="lib-icon-btn"
              title="重新扫描索引"
              disabled={indexing}
              onClick={onReindex}
            >
              <Icon name="refresh" size={14} className={indexing ? "spin" : ""} />
            </button>
            <button
              className="lib-icon-btn"
              title="导入外部文件"
              onClick={onOpenImports}
            >
              <Icon name="import" size={14} />
            </button>
          </div>
        </div>
        <label className="library-search">
          <Icon name="search" size={14} />
          <input
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="搜索文档名称与路径"
          />
        </label>
      </div>

      <div className="doc-scroll">
        {filteredFiles.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 14px", color: "var(--text-muted)", fontSize: "12px" }}>
            无匹配文档
          </div>
        ) : (
          filteredFiles.map((file) => (
            <article
              key={file.id}
              className={file.id === selectedId ? "doc-item active" : "doc-item"}
              onClick={() => onSelect(file.id)}
            >
              <div className="doc-icon">
                <Icon name="file" size={14} />
              </div>
              <div className="doc-copy">
                <div className="doc-title">{docName(file.path)}</div>
                <div className="doc-path">{file.path}</div>
                <div className="doc-meta">
                  <span>{(file.size / 1024).toFixed(1)} KB</span>
                  <span className="meta-dot" />
                  <span>{file.chunkCount} 切片</span>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </aside>
  );
}

function ReaderShell({
  file,
  content,
  onAskAI,
}: {
  file: KbFileSummary | null;
  content: LoadState<KbFileContent>;
  onAskAI: () => void;
}): React.ReactElement {
  const [viewMode, setViewMode] = useState<"render" | "source">("render");
  const [copied, setCopied] = useState(false);

  const rawMarkdown = content.status === "ready" ? content.data.content : "";
  const { title: fmTitle, subtitle: fmSubtitle, body: cleanBody } = useMemo(
    () => splitFrontMatter(rawMarkdown),
    [rawMarkdown],
  );
  const displayTitle = fmTitle || (file ? docName(file.path) : "未命名文档");
  const headings = useMemo(() => extractHeadings(cleanBody), [cleanBody]);

  const copyContent = async (): Promise<void> => {
    if (!rawMarkdown) return;
    try {
      await navigator.clipboard.writeText(rawMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  if (!file) {
    return (
      <section className="reader-shell">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", textAlign: "center" }}>
          <div className="hero-icon"><Icon name="file" size={24} /></div>
          <h3 style={{ margin: "0 0 6px", color: "var(--text-main)", fontSize: "16px" }}>选择左侧文档查看详情</h3>
          <p style={{ margin: 0, fontSize: "13px" }}>支持 Markdown 实时渲染与结构化大纲导航</p>
        </div>
      </section>
    );
  }

  return (
    <section className="reader-shell">
      <div className="reader-toolbar">
        <div className="toolbar-breadcrumb">
          <span className="crumb">
            <Icon name="folder" size={13} />
            <span>{parentLabel(file.path)}</span>
          </span>
          <span className="crumb">
            <em>/</em>
            <span className="current">{docName(file.path)}</span>
          </span>
        </div>
        <div className="toolbar-spacer" />
        <div className="segmented">
          <button className={viewMode === "render" ? "active" : ""} onClick={() => setViewMode("render")}>
            渲染视图
          </button>
          <button className={viewMode === "source" ? "active" : ""} onClick={() => setViewMode("source")}>
            源码视图
          </button>
        </div>
        <button className="tool-button" onClick={() => void copyContent()}>
          <Icon name={copied ? "check" : "copy"} size={13} />
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
        <button className="tool-button primary" onClick={onAskAI}>
          <Icon name="spark" size={13} />
          <span>向 AI 提问本文档</span>
        </button>
      </div>

      <div className="reader-scroll">
        {content.status === "loading" ? (
          <div style={{ textAlign: "center", padding: "60px", color: "var(--text-muted)", fontSize: "13px" }}>
            正在读取文档内容…
          </div>
        ) : content.status === "error" ? (
          <div style={{ textAlign: "center", padding: "60px", color: "var(--danger)", fontSize: "13px" }}>
            {content.message}
          </div>
        ) : viewMode === "source" ? (
          <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
            <pre style={{ margin: 0, padding: "20px", borderRadius: "12px", background: "#1e293b", color: "#e2e8f0", fontFamily: "var(--app-font-mono)", fontSize: "13px", lineHeight: "1.65", overflow: "auto", whiteSpace: "pre-wrap" }}>
              {rawMarkdown}
            </pre>
          </div>
        ) : (
          <div className="reader-layout">
            <article className="article">
              <header className="article-header">
                <div className="eyebrow-doc">
                  <Icon name="folder" size={12} />
                  <span>{parentLabel(file.path)}</span>
                </div>
                <h1>{displayTitle}</h1>
                {fmSubtitle && <p className="article-subtitle">{fmSubtitle}</p>}
                <div className="article-meta">
                  <span className="tag blue">{file.language.toUpperCase()}</span>
                  <span className="tag">{(file.size / 1024).toFixed(1)} KB</span>
                  <span className="tag">{file.chunkCount} 切片</span>
                  <span style={{ color: "var(--text-muted)", fontSize: "11px", marginLeft: "auto" }}>
                    路径：{file.path}
                  </span>
                </div>
              </header>

              <div className="article-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1({ children, ...props }) {
                      const text = extractText(children);
                      return <h1 id={slugify(text)} {...props}>{children}</h1>;
                    },
                    h2({ children, ...props }) {
                      const text = extractText(children);
                      return <h2 id={slugify(text)} {...props}>{children}</h2>;
                    },
                    h3({ children, ...props }) {
                      const text = extractText(children);
                      return <h3 id={slugify(text)} {...props}>{children}</h3>;
                    },
                  }}
                >
                  {cleanBody}
                </ReactMarkdown>
              </div>
            </article>

            {headings.length > 0 && (
              <aside className="toc">
                <div className="toc-title">目录导航</div>
                <nav className="toc-list">
                  {headings.map((h, i) => (
                    <a key={`${h.slug}-${i}`} href={`#${h.slug}`} className={h.level === 3 ? "sub" : ""}>
                      {h.text}
                    </a>
                  ))}
                </nav>
              </aside>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// --- Imports View (Full Desktop 2-column App Design) ---
function ImportsView({ workspace, onImported }: { workspace: WorkspaceInfo | null; onImported: () => void }): React.ReactElement {
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [targetPath, setTargetPath] = useState("");
  const [content, setContent] = useState<string | null>(null);

  const refresh = (): void => {
    if (!workspace || !inTauriRuntime()) return;
    void invoke<AttachmentInfo[]>("attachments_list", { root: workspace.root })
      .then(setAttachments)
      .catch((reason: unknown) => setError(String(reason)));
  };

  useEffect(refresh, [workspace]);

  const pickAndImport = async (): Promise<void> => {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await openDialog({ multiple: false, directory: false });
      if (typeof picked !== "string") return;
      const info = await invoke<AttachmentInfo>("import_file", { root: workspace.root, sourcePath: picked });
      refresh();
      setSelected(info.name);
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const loadContent = async (name: string, isExtractable?: boolean): Promise<void> => {
    if (!workspace) return;
    setSelected(name);
    setContent(null);
    setError(null);
    const stem = name.replace(/\.[^.]+$/, "");
    setTargetPath(`wiki/${stem}.md`);
    try {
      const text = await invoke<string>("attachment_read", { root: workspace.root, name });
      setContent(text);
    } catch {
      if (isExtractable) {
        try {
          const extracted = await invoke<string>("attachment_extract", { root: workspace.root, name });
          setContent(extracted);
        } catch (reason: unknown) {
          setError(String(reason));
        }
      }
    }
  };

  const createDraft = async (): Promise<void> => {
    if (!workspace || !selected || !targetPath.trim()) return;
    setError(null);
    try {
      await invoke<Draft>("draft_create", {
        root: workspace.root,
        workspaceId: workspace.id,
        targetPath: targetPath.trim(),
        operationType: "create",
        generatedContent: content ?? "",
      });
      onImported();
      setError(null);
      setSelected(null);
      setContent(null);
      setTargetPath("");
    } catch (reason: unknown) {
      setError(String(reason));
    }
  };

  if (!workspace) {
    return (
      <div className="doc-empty-container">
        <div className="doc-empty-card">
          <div className="doc-empty-icon"><Icon name="import" size={28} /></div>
          <h2>导入外部知识文档</h2>
          <p className="doc-empty-desc">请先在左上角选择或连接一个本地工作区。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="split-panel">
      <div className="file-tree">
        <div className="file-tree-header">
          <strong>已导入附件 ({attachments.length})</strong>
        </div>
        <div className="file-tree-actions">
          <button className="primary-button" style={{ width: "100%" }} disabled={busy} onClick={() => void pickAndImport()}>
            <Icon name="plus" size={14} />
            {busy ? "正在导入…" : "导入外部文件"}
          </button>
        </div>

        {attachments.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "12px", textAlign: "center", padding: "24px 8px" }}>
            暂无已导入文件。点击上方按钮选择 Markdown、PDF、Word 或文本文件开始。
          </p>
        ) : (
          attachments.map((att) => (
            <button
              className={att.name === selected ? "file-item selected" : "file-item"}
              key={att.name}
              onClick={() => void loadContent(att.name, att.isExtractable)}
            >
              <Icon name="file" size={15} />
              <div className="file-item-copy">
                <div className="file-item-name">{att.name}</div>
                <div className="file-item-meta">
                  {(att.size / 1024).toFixed(1)} KB · {att.isText ? "纯文本" : att.isExtractable ? "自动提取" : "二进制"}
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      <article className="document-reader">
        {error && <div className="doc-status-banner error">操作错误：{error}</div>}
        {selected === null ? (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
            <div className="hero-icon"><Icon name="import" size={28} /></div>
            <h2 style={{ fontSize: "18px", color: "var(--text-main)", margin: "0 0 8px" }}>选择左侧已导入文件</h2>
            <p style={{ maxWidth: "460px", margin: "0 auto", fontSize: "13px", lineHeight: "1.6" }}>
              导入的文件将存放于 <code>attachments/</code> 目录。支持将提取的内容一键转换为草稿，安全写入知识库。
            </p>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <span className="eyebrow-doc">{selected}</span>
            </div>
            <h2>创建草稿并写入 Wiki</h2>
            {content === null ? (
              <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>正在提取文档文本…</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "16px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12.5px", fontWeight: 600 }}>
                  目标写入路径 (相对于工作区根目录)
                  <input
                    value={targetPath}
                    onChange={(e) => setTargetPath(e.target.value)}
                    placeholder="wiki/document.md"
                    style={{ padding: "9px 12px", borderRadius: "8px", border: "1px solid var(--border-main)", fontSize: "13px" }}
                  />
                </label>
                <div>
                  <button className="primary-button" disabled={!targetPath.trim()} onClick={() => void createDraft()}>
                    <Icon name="draft" size={14} />
                    生成写入草稿
                  </button>
                  <span style={{ marginLeft: "12px", color: "var(--text-muted)", fontSize: "11.5px" }}>
                    草稿创建后可在「写入草稿」中二次确认，保障原子写入安全。
                  </span>
                </div>
                <div style={{ marginTop: "16px" }}>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 8px" }}>提取内容预览</h3>
                  <pre style={{ margin: 0, padding: "16px", borderRadius: "10px", background: "var(--bg-surface-subtle)", border: "1px solid var(--border-subtle)", maxHeight: "420px", overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "var(--app-font-mono)", fontSize: "12.5px", lineHeight: "1.6" }}>
                    {content.slice(0, 5000)}{content.length > 5000 ? "\n\n…（预览截断，完整内容将完整写入草稿）" : ""}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </article>
    </div>
  );
}

// --- Drafts View (Full Desktop 2-column Review Layout) ---
const OPERATION_LABELS: Record<string, string> = {
  create: "新建文档",
  append: "追加内容",
  update_section: "更新章节",
  overwrite: "覆盖文档",
};

function DraftsView({ workspace }: { workspace: WorkspaceInfo | null }): React.ReactElement {
  const [drafts, setDrafts] = useState<LoadState<Draft[]>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!workspace || !inTauriRuntime()) {
      setDrafts({ status: "error", message: "请先选择一个工作区" });
      return;
    }
    let cancelled = false;
    setDrafts({ status: "loading" });
    void invoke<Draft[]>("draft_list", { root: workspace.root })
      .then((data) => {
        if (!cancelled) {
          setDrafts({ status: "ready", data });
          setSelectedId(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setDrafts({ status: "error", message: String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, refreshKey]);

  const selectedDraft = drafts.status === "ready" ? drafts.data.find((d) => d.draftId === selectedId) ?? null : null;

  const refresh = (): void => {
    setActionError(null);
    setRefreshKey((k) => k + 1);
  };

  const applyDraft = async (draftId: string): Promise<void> => {
    if (!workspace) return;
    setActionError(null);
    try {
      await invoke<DraftApplyResult>("draft_apply", { root: workspace.root, draftId });
      refresh();
    } catch (reason: unknown) {
      setActionError(String(reason));
    }
  };

  const rejectDraft = async (draftId: string): Promise<void> => {
    if (!workspace) return;
    setActionError(null);
    try {
      await invoke<Draft>("draft_reject", { root: workspace.root, draftId });
      refresh();
    } catch (reason: unknown) {
      setActionError(String(reason));
    }
  };

  if (drafts.status === "loading") return <div className="empty-state"><div className="hero-icon"><Icon name="draft" size={24} /></div><h2>加载草稿列表中…</h2></div>;
  if (drafts.status === "error") return <div className="empty-state"><div className="hero-icon"><Icon name="draft" size={24} /></div><h2>无法加载草稿</h2><p>{drafts.message}</p></div>;

  const list = drafts.data;
  const pending = list.filter((d) => d.status === "pending");

  if (list.length === 0) {
    return (
      <div className="doc-empty-container">
        <div className="doc-empty-card">
          <div className="doc-empty-icon"><Icon name="draft" size={28} /></div>
          <h2>暂无待确认草稿</h2>
          <p className="doc-empty-desc">
            由 Pi 智能体生成或由导入文件创建的写入草稿会在此处列出，供您人工确认后原子写入 Wiki。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="split-panel">
      <div className="file-tree">
        <div className="file-tree-header">
          <strong>写入草稿 ({pending.length} 待确认 / {list.length} 总数)</strong>
        </div>
        {list.map((draft) => (
          <button
            className={draft.draftId === selectedId ? "file-item selected" : "file-item"}
            key={draft.draftId}
            onClick={() => {
              setSelectedId(draft.draftId);
              setActionError(null);
            }}
          >
            <Icon name="draft" size={15} />
            <div className="file-item-copy">
              <div className="file-item-name">{draft.targetPath}</div>
              <div className="file-item-meta">
                <span className={`draft-badge ${draft.status}`}>{draft.status === "pending" ? "待审核" : draft.status === "applied" ? "已写入" : "已拒绝"}</span>
                {" · "}{OPERATION_LABELS[draft.operationType] ?? draft.operationType}
              </div>
            </div>
          </button>
        ))}
      </div>

      <article className="document-reader">
        {actionError && <div className="doc-status-banner error">操作失败：{actionError}</div>}
        {selectedDraft === null ? (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
            <div className="hero-icon"><Icon name="draft" size={28} /></div>
            <h2 style={{ fontSize: "18px", color: "var(--text-main)", margin: "0 0 8px" }}>选择左侧草稿进行审查</h2>
            <p style={{ fontSize: "13px" }}>当前有 {pending.length} 个待确认写入草稿。</p>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span className="eyebrow-doc">{OPERATION_LABELS[selectedDraft.operationType] ?? selectedDraft.operationType}</span>
              <span className={`draft-badge ${selectedDraft.status}`}>
                {selectedDraft.status === "pending" ? "待审核" : selectedDraft.status === "applied" ? "已生效" : "已拒绝"}
              </span>
            </div>
            <h2>{selectedDraft.targetPath}</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "12.5px", margin: "0 0 18px" }}>
              创建者：{selectedDraft.createdBy}
              {selectedDraft.baseDocumentHash && ` · 基准哈希：${selectedDraft.baseDocumentHash.slice(0, 10)}…`}
              {selectedDraft.sourceCitations.length > 0 && ` · 引用 ${selectedDraft.sourceCitations.length} 处知识来源`}
            </p>

            {selectedDraft.status === "pending" ? (
              <div style={{ display: "flex", gap: "10px", margin: "16px 0" }}>
                <button className="primary-button" onClick={() => void applyDraft(selectedDraft.draftId)}>
                  <Icon name="check" size={14} />
                  确认写入知识库
                </button>
                <button className="tool-button" onClick={() => void rejectDraft(selectedDraft.draftId)}>
                  <Icon name="close" size={14} />
                  拒绝草稿
                </button>
              </div>
            ) : (
              <div style={{ padding: "8px 12px", borderRadius: "8px", background: "var(--bg-surface-muted)", color: "var(--text-secondary)", fontSize: "12px", margin: "14px 0" }}>
                该草稿已完成处理 ({selectedDraft.status})。
              </div>
            )}

            <div style={{ marginTop: "20px" }}>
              <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 8px" }}>生成内容预览</h3>
              <pre style={{ margin: 0, padding: "16px", borderRadius: "10px", background: "var(--bg-surface-subtle)", border: "1px solid var(--border-subtle)", maxHeight: "480px", overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "var(--app-font-mono)", fontSize: "12.5px", lineHeight: "1.6" }}>
                {selectedDraft.generatedContent}
              </pre>
            </div>
          </div>
        )}
      </article>
    </div>
  );
}

// --- Tasks View (Full Desktop System Monitor) ---
function TasksView({ workspace, onIndexed }: { workspace: WorkspaceInfo | null; onIndexed: () => void }): React.ReactElement {
  const [indexing, setIndexing] = useState(false);
  const [lastResult, setLastResult] = useState<IndexStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<KbStats | null>(null);

  useEffect(() => {
    if (!workspace || !inTauriRuntime()) return;
    void invoke<KbStats>("kb_stats", { root: workspace.root })
      .then(setStats)
      .catch(() => {});
  }, [workspace, lastResult]);

  const runIndex = async (): Promise<void> => {
    if (!workspace || !inTauriRuntime() || indexing) return;
    setIndexing(true);
    setError(null);
    try {
      const result = await invoke<IndexStats>("index_run", { root: workspace.root });
      setLastResult(result);
      onIndexed();
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setIndexing(false);
    }
  };

  return (
    <div className="task-list">
      <div className="task-page-header">
        <h1>后台任务与系统健康</h1>
        <p>监控工作区全文索引、知识库拓扑与底层数据库运行状态。</p>
      </div>

      <div className="task-card">
        <div className="task-card-header">
          <strong>工作区全文索引 (FTS5 Indexer)</strong>
          <button
            className="primary-button"
            disabled={!workspace || indexing}
            onClick={() => void runIndex()}
          >
            <Icon name="refresh" size={14} className={indexing ? "spin" : ""} />
            {indexing ? "正在构建索引…" : "立即重新索引"}
          </button>
        </div>
        <p>扫描配置目录下的 Markdown 与文本文件，解析层级章节并维护 BM25 全文检索索引与切片。</p>

        {error && <div className="doc-status-banner error" style={{ marginTop: "12px" }}>索引错误：{error}</div>}

        <div className="task-stats-grid">
          <div className="task-stat-item">
            <span>索引状态</span>
            <strong>{stats?.tablesOk ? "就绪" : "未建立"}</strong>
          </div>
          <div className="task-stat-item">
            <span>收录文档</span>
            <strong>{stats?.files ?? 0} 篇</strong>
          </div>
          <div className="task-stat-item">
            <span>文本切片 (Chunks)</span>
            <strong>{stats?.chunks ?? 0} 条</strong>
          </div>
          <div className="task-stat-item">
            <span>FTS5 记录数</span>
            <strong>{stats?.ftsRecords ?? 0} 条</strong>
          </div>
        </div>

        {lastResult && (
          <div style={{ marginTop: "14px", padding: "10px 14px", borderRadius: "8px", background: "var(--bg-surface-subtle)", fontSize: "12px", color: "var(--text-secondary)" }}>
            上次扫描结果：扫描 {lastResult.scanned} 篇 · 新增 {lastResult.added} 篇 · 更新 {lastResult.updated} 篇 · 跳过 {lastResult.skipped} 篇 · 切片 {lastResult.chunks} 个
          </div>
        )}
      </div>

      <div className="task-card">
        <div className="task-card-header">
          <strong>存储引擎与并发安全性 (SQLite WAL)</strong>
          <span className="draft-badge applied">正常运行</span>
        </div>
        <p>采用 SQLite WAL (Write-Ahead Logging) 模式，保障桌面端多任务、AI 问答并发检索及文件写入事务的一致性。</p>
        <div className="task-stats-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <div className="task-stat-item">
            <span>模式</span>
            <strong>WAL Journal</strong>
          </div>
          <div className="task-stat-item">
            <span>检索协议</span>
            <strong>SQLite FTS5 BM25</strong>
          </div>
          <div className="task-stat-item">
            <span>安全写入校验</span>
            <strong>expectedHash 开启</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
