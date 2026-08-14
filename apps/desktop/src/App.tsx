import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import RelationsView, { inTauriRuntime } from "./RelationsView";

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

interface SearchHit {
  chunkId: number;
  fileId: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  preview: string;
  bm25: number;
}

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

type WorkspaceMode = "recent" | "open" | "create";
type RuntimeMode = "pi" | "preview";

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
      // Drop fallback contexts (resolvedBy === "default"): they have no
      // real on-disk workspace and shouldn't appear in the recent list.
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
    // localStorage is optional in embedded previews.
  }
}

const navigation: Array<{ id: View; label: string; icon: string }> = [
  { id: "chat", label: "AI 问答", icon: "✦" },
  { id: "documents", label: "文档", icon: "▤" },
  { id: "relations", label: "关系图谱", icon: "⌘" },
  { id: "imports", label: "文件导入", icon: "↥" },
  { id: "drafts", label: "写入草稿", icon: "◒" },
  { id: "tasks", label: "后台任务", icon: "◷" },
  { id: "settings", label: "设置", icon: "⚙" },
];

export default function App(): React.ReactElement {
  const [view, setView] = useState<View>("chat");
  const [sidebarWidth, setSidebarWidth] = useState(238);
  const [isResizing, setIsResizing] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [knownWorkspaces, setKnownWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("recent");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("pi");
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
    void invoke<WorkspaceInfo>("workspace_current")
      .then((current) => {
        setWorkspace(current);
        // Only remember workspaces that resolved to a real manifest. A
        // "default" fallback (no on-disk workspace.json) is shown as the
        // active context but must not enter the recent list — it has no
        // deletable on-disk presence.
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

  // Refresh index stats whenever the active workspace changes (or after a
  // manual index run) so the status bar reflects the real counts.
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

  // ⌘K / Ctrl+K → switch to the search view and focus the input.
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

  const title = useMemo(
    () => navigation.find((item) => item.id === view)?.label ?? "LLM Wiki",
    [view],
  );

  const resizeSidebar = (clientX: number): void => {
    setSidebarWidth(Math.min(420, Math.max(190, clientX)));
  };

  return (
    <main className={isResizing ? "desktop-shell is-resizing" : "desktop-shell"} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <div className="body-grid">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="workspace-selector">
              <button className="workspace-identity" aria-label="切换工作空间" aria-expanded={workspaceMenuOpen} onClick={() => { setWorkspaceMenuOpen((open) => !open); setRuntimeMenuOpen(false); setWorkspaceError(null); }}>
                <span className="workspace-avatar">{workspace?.title.slice(0, 2) ?? "LW"}</span>
                <span>
                  <strong>{workspace?.title ?? "LLM Wiki"}</strong>
                  <small>{workspace?.root ?? "本地知识工作台"}</small>
                </span>
                <span className="chevron">⌄</span>
              </button>
            </div>
          </div>
          <button className="compose-button" onClick={() => setView("chat")}><span>＋</span>新建对话 <kbd>⌘ N</kbd></button>
          <div className="nav-group">
            <span className="nav-label">工作台</span>
            <nav aria-label="主导航">
              {navigation.map((item) => (
                <button
                  className={view === item.id ? "nav-item active" : "nav-item"}
                  key={item.id}
                  onClick={() => { setView(item.id); setPendingDocFileId(null); }}
                >
                  <span>{item.icon}</span>{item.label}
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
          <header className="workspace-toolbar">
            <div className="toolbar-title">
              <span>{navigation.find((item) => item.id === view)?.icon}</span>
              <strong>{title}</strong>
              <small>{workspace?.title ?? "LLM Wiki"}</small>
            </div>
            <div className="toolbar-actions">
              <button className="search-button" aria-label="搜索工作空间" onClick={focusSearch}><span>⌕</span>搜索 <kbd>⌘ K</kbd></button>
              <span className="connection-pill"><span className="status-dot" />本地</span>
              <div className="runtime-selector">
                <button className="runtime-picker" aria-label="选择 Pi Runtime" aria-expanded={runtimeMenuOpen} onClick={() => { setRuntimeMenuOpen((open) => !open); setWorkspaceMenuOpen(false); }}>✦ Pi <span>⌄</span></button>
                {runtimeMenuOpen && <RuntimeMenu selected={runtimeMode} onSelect={(mode) => { setRuntimeMode(mode); setRuntimeMenuOpen(false); }} />}
              </div>
              <button className="icon-button" aria-label="更多操作">•••</button>
            </div>
          </header>
          <div className={view === "chat" || view === "documents" || view === "relations" ? "content-pane documents-pane" : "content-pane"}>
            {error && <div className="error-banner">Core 尚未连接：{error}</div>}
            {view === "chat" && <ChatView workspace={workspace} focusTrigger={searchFocusTrigger} onOpenDocument={(fileId) => { setPendingDocFileId(fileId); setView("documents"); }} />}
            {view === "documents" && <DocumentsView workspace={workspace} focusFileId={pendingDocFileId} onAskAI={() => setView("chat")} />}
            {view === "relations" && <RelationsView workspace={workspace} onAskAI={() => setView("chat")} onOpenDocuments={() => setView("documents")} />}
            {view === "imports" && <ImportsView workspace={workspace} onImported={() => setStatsRefreshKey((k) => k + 1)} />}
            {view === "drafts" && <DraftsView workspace={workspace} />}
            {view === "tasks" && <TasksView workspace={workspace} onIndexed={() => setStatsRefreshKey((k) => k + 1)} />}
            {view === "settings" && <SettingsView workspace={workspace} kbStats={kbStats} />}
          </div>
        </section>
      </div>
      <footer className="statusbar">
        {kbStats && kbStats.tablesOk
          ? <>{kbStats.files} documents · {kbStats.chunks} chunks · index ready</>
          : <>{workspace ? "工作区尚未索引" : "未选择工作区"}</>}
        {" "}<span>Rust Core · SQLite · FTS5</span>
      </footer>
      {workspaceMenuOpen && <>
        <button className="workspace-modal-backdrop" type="button" aria-label="关闭工作区选择器" onClick={() => setWorkspaceMenuOpen(false)} />
        <WorkspaceMenu mode={workspaceMode} setMode={setWorkspaceMode} workspace={workspace} workspaces={knownWorkspaces} onSelect={selectWorkspace} onDelete={forgetWorkspace} path={workspacePath} setPath={setWorkspacePath} title={workspaceTitle} setTitle={setWorkspaceTitle} onOpen={openWorkspace} onCreate={createWorkspace} onClose={() => setWorkspaceMenuOpen(false)} error={workspaceError} />
      </>}
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
      // `null`/`undefined` means the user cancelled — stay silent.
      if (typeof selected === "string") setPath(selected);
    } finally {
      setPicking(false);
    }
  };
  return <div className="workspace-menu" role="dialog" aria-label="工作区选择器">
    <div className="workspace-menu-header"><div><strong>工作区</strong><small>{workspace?.root ?? "选择一个本地知识库"}</small></div><button className="menu-close" onClick={onClose} aria-label="关闭工作区选择器">×</button></div>
    <div className="workspace-tabs">
      <button className={mode === "recent" ? "active" : ""} onClick={() => setMode("recent")}>最近使用</button>
      <button className={mode === "open" ? "active" : ""} onClick={() => setMode("open")}>打开</button>
      <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>新建</button>
    </div>
    {mode === "recent" && <div className="workspace-list">
      {workspaces.length === 0 && <p className="menu-empty">还没有记录，打开一个本地工作区开始使用。</p>}
      {workspaces.map((item) => {
        if (pendingDelete?.id === item.id) {
          return <div key={item.id} className="workspace-entry-confirm">
            <div className="workspace-entry-confirm-message">
              <strong>{item.title}</strong>
              <span>删除后不可恢复。「移除记录」保留磁盘文件，「删除文件」清除 .llm-wiki 元数据。</span>
            </div>
            <div className="workspace-entry-confirm-actions">
              <button className="confirm-remove" disabled={deleting} onClick={() => void handleDelete(item, false)}>移除记录</button>
              <button className="confirm-purge" disabled={deleting} onClick={() => void handleDelete(item, true)}>删除文件</button>
              <button className="confirm-cancel" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
            </div>
          </div>;
        }
        return <div key={item.id} className="workspace-entry-row">
          <button className={item.id === workspace?.id ? "workspace-entry active" : "workspace-entry"} onClick={() => void onSelect(item)}>
            <span className="workspace-entry-avatar">{item.title.slice(0, 2)}</span><span><strong>{item.title}</strong><small>{item.root}</small></span>{item.id === workspace?.id && <span className="workspace-check">✓</span>}
          </button>
          <button className="workspace-entry-delete" aria-label={`删除工作区 ${item.title}`} disabled={deleting} onClick={() => setPendingDelete(item)}>×</button>
        </div>;
      })}
    </div>}
    {(mode === "open" || mode === "create") && <div className="workspace-form">
      {mode === "create" && <label>工作区名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品知识库" /></label>}
      <label>目录路径
        <div className="workspace-path-row">
          <input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void (mode === "open" ? onOpen() : onCreate()); }} placeholder="/Users/you/Documents/wiki" autoFocus />
          <button type="button" className="workspace-path-browse" disabled={picking || !inTauriRuntime()} title={inTauriRuntime() ? "选择目录" : "目录选择需要在桌面端运行"} onClick={() => void pickDirectory()}>浏览…</button>
        </div>
      </label>
      <small className="workspace-help">{mode === "create" ? "将在目录中创建 .llm-wiki/workspace.json" : "目录需包含 .llm-wiki/workspace.json"}</small>
      <button className="workspace-submit" onClick={() => void (mode === "open" ? onOpen() : onCreate())}>{mode === "create" ? "创建并打开" : "打开工作区"}</button>
    </div>}
    {error && <p className="workspace-menu-error">{error}</p>}
  </div>;
}

function RuntimeMenu({ selected, onSelect }: { selected: RuntimeMode; onSelect: (mode: RuntimeMode) => void }): React.ReactElement {
  return <div className="runtime-menu" role="dialog" aria-label="Pi Runtime 选择器">
    <div className="runtime-menu-header"><strong>Pi Runtime</strong><span className="runtime-badge"><span className="online-dot" />已连接</span></div>
    <button className={selected === "pi" ? "runtime-entry active" : "runtime-entry"} onClick={() => onSelect("pi")}><span className="runtime-entry-icon">✦</span><span><strong>Host Bridge</strong><small>Host Tools only · 只读</small></span>{selected === "pi" && <span className="workspace-check">✓</span>}</button>
    <button className={selected === "preview" ? "runtime-entry active" : "runtime-entry"} onClick={() => onSelect("preview")}><span className="runtime-entry-icon preview">◌</span><span><strong>离线预览</strong><small>仅查看界面 · 不调用 Core</small></span>{selected === "preview" && <span className="workspace-check">✓</span>}</button>
    <div className="runtime-menu-note">Bash、Write、Edit 默认禁用。外部 Agent 只能检索、读取和查看关系图谱。</div>
  </div>;
}

// --- AI chat page: helpers + sub-components (layout mirrors the documents page)

let uidCounter = 0;
function uid(): string {
  uidCounter += 1;
  return `${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

type ChatAnswer =
  | { kind: "pending" }
  | { kind: "results"; hits: SearchHit[] }
  | { kind: "error"; message: string };

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: ChatAnswer;
  createdAt: number;
}

interface ChatConversation {
  id: string;
  title: string;
  workspaceId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

const CHAT_STORAGE_KEY = "llm-wiki.desktop.chats";
const CHAT_STORAGE_LIMIT = 60;

function readStoredConversations(): ChatConversation[] {
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ChatConversation => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === "string"
        && typeof candidate.title === "string"
        && typeof candidate.workspaceId === "string"
        && Array.isArray(candidate.messages);
    });
  } catch {
    return [];
  }
}

function conversationTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

function dayBucket(ts: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "今天";
  if (ts >= startOfToday - 86400000) return "昨天";
  if (ts >= startOfToday - 7 * 86400000) return "最近 7 天";
  return "更早";
}

function ChatView({ workspace, focusTrigger, onOpenDocument }: { workspace: WorkspaceInfo | null; focusTrigger: number; onOpenDocument: (fileId: number) => void }): React.ReactElement {
  const scopeId = workspace?.id ?? "preview";
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "week">("all");
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Load this workspace's saved conversations whenever the scope changes.
  useEffect(() => {
    const stored = readStoredConversations()
      .filter((c) => c.workspaceId === scopeId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    setConversations(stored);
    setActiveId(null);
    setHydratedScope(scopeId);
  }, [scopeId]);

  // Persist every change back to localStorage. Storage is shared across
  // workspaces, so other scopes' conversations must be kept intact — and
  // writes are skipped until the load above has landed for this scope.
  useEffect(() => {
    if (hydratedScope !== scopeId) return;
    try {
      const others = readStoredConversations().filter((c) => c.workspaceId !== scopeId);
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify([...others, ...conversations.slice(0, CHAT_STORAGE_LIMIT)]));
    } catch {
      // localStorage is optional in embedded previews.
    }
  }, [conversations, scopeId, hydratedScope]);

  // When focusTrigger changes (⌘K or search button clicked), focus the composer.
  useEffect(() => {
    if (focusTrigger > 0) textareaRef.current?.focus();
  }, [focusTrigger]);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const activeMessageCount = active?.messages.length ?? 0;

  // Keep the newest exchange in view when the active conversation updates.
  useEffect(() => {
    const el = threadRef.current;
    if (el && activeMessageCount > 0) el.scrollTop = el.scrollHeight;
  }, [activeId, activeMessageCount]);

  const patchAnswer = (convId: string, messageId: string, answer: ChatAnswer): void => {
    setConversations((previous) => previous.map((c) => c.id !== convId ? c : {
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map((m) => m.id === messageId ? { ...m, answer } : m),
    }));
  };

  // Asking a question appends a user message plus a pending assistant reply;
  // the FTS5 search results become the reply's citations.
  const send = async (): Promise<void> => {
    const text = query.trim();
    if (!text || !workspace || sending) return;
    setSending(true);
    setQuery("");
    const now = Date.now();
    const convId = activeId ?? uid();
    const assistantId = uid();
    setConversations((previous) => {
      const existing = previous.find((c) => c.id === convId);
      const base: ChatConversation = existing ?? {
        id: convId,
        title: text.length > 30 ? `${text.slice(0, 30)}…` : text,
        workspaceId: scopeId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      const messages: ChatMessage[] = [
        ...base.messages,
        { id: uid(), role: "user", text, createdAt: now },
        { id: assistantId, role: "assistant", text: "", answer: { kind: "pending" }, createdAt: now },
      ];
      return [{ ...base, messages, updatedAt: now }, ...previous.filter((c) => c.id !== convId)];
    });
    setActiveId(convId);
    try {
      const hits = await invoke<SearchHit[]>("document_search", { root: workspace.root, query: text });
      patchAnswer(convId, assistantId, { kind: "results", hits });
    } catch (reason: unknown) {
      const message = inTauriRuntime()
        ? String(reason)
        : "检索需要在 Tauri 桌面端运行（当前为浏览器预览模式）";
      patchAnswer(convId, assistantId, { kind: "error", message });
    } finally {
      setSending(false);
    }
  };

  const deleteConversation = (convId: string): void => {
    setConversations((previous) => previous.filter((c) => c.id !== convId));
    setActiveId((current) => (current === convId ? null : current));
  };

  const visible = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return conversations
      .filter((c) => {
        if (q && !`${c.title} ${c.messages.map((m) => m.text).join(" ")}`.toLowerCase().includes(q)) return false;
        if (filter === "today") return c.updatedAt >= startOfToday;
        if (filter === "week") return c.updatedAt >= startOfToday - 6 * 86400000;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [conversations, filterQuery, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, ChatConversation[]>();
    for (const c of visible) {
      const label = dayBucket(c.updatedAt);
      const arr = map.get(label) ?? [];
      arr.push(c);
      map.set(label, arr);
    }
    return Array.from(map.entries());
  }, [visible]);

  const askCount = (c: ChatConversation): number => c.messages.filter((m) => m.role === "user").length;

  return <div className="chat-page">
    <aside className="library">
      <div className="library-head">
        <div className="section-title-row">
          <div><span className="section-title">对话</span><span className="section-count">{conversations.length}</span></div>
          <div className="small-actions">
            <button className="lib-icon-btn" title="新对话" onClick={() => { setActiveId(null); textareaRef.current?.focus(); }}><Icon name="plus" size={15} /></button>
          </div>
        </div>
        <label className="library-search">
          <Icon name="search" size={15} />
          <input value={filterQuery} onChange={(e) => setFilterQuery(e.target.value)} placeholder="搜索历史对话" />
        </label>
      </div>
      <div className="library-filter">
        {(["all", "today", "week"] as const).map((key) => (
          <button key={key} className={filter === key ? "filter-chip active" : "filter-chip"} onClick={() => setFilter(key)}>
            {key === "all" ? "全部" : key === "today" ? "今天" : "本周"}
          </button>
        ))}
      </div>
      <div className="doc-scroll">
        {visible.length === 0
          ? <div className="doc-empty">{conversations.length === 0 ? <>还没有对话<br />提问后会自动保存在这里</> : <>没有匹配的对话<br />换一个关键词试试</>}</div>
          : groups.map(([label, items]) => (
            <div key={label}>
              <div className="doc-group-label">{label}</div>
              {items.map((c) => (
                <article key={c.id} className={c.id === activeId ? "conv-item active" : "conv-item"} onClick={() => setActiveId(c.id)}>
                  <div className="conv-icon"><Icon name="spark" size={15} /></div>
                  <div className="conv-copy">
                    <div className="conv-title">{c.title}</div>
                    <div className="conv-meta">
                      <span>{askCount(c)} 次提问</span><span className="meta-dot" />
                      <span>{conversationTime(c.updatedAt)}</span>
                    </div>
                  </div>
                  <button className="conv-delete" aria-label={`删除对话 ${c.title}`} onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}><Icon name="trash" size={14} /></button>
                </article>
              ))}
            </div>
          ))}
      </div>
    </aside>

    <section className="chat-detail">
      <div className="reader-toolbar">
        <div className="toolbar-breadcrumb">
          <span className="crumb"><span>{workspace?.title ?? "LLM Wiki"}</span></span>
          <span className="crumb"><em>/</em><span className="current">{active ? active.title : "新对话"}</span></span>
        </div>
        <div className="toolbar-spacer" />
        {active && <span className="chat-meta-chip">{askCount(active)} 次提问 · {active.messages.length} 条消息</span>}
        {active && <button className="tool-button" onClick={() => deleteConversation(active.id)}><Icon name="trash" size={14} /><span>删除对话</span></button>}
      </div>

      <div className="reader-scroll" ref={threadRef}>
        {active === null
          ? (conversations.length === 0
            ? <div className="chat-welcome">
              <div className="hero-icon">✦</div>
              <h2>搜索当前工作空间</h2>
              <p>输入关键词检索已索引文档。Pi 生成式问答接入后将在此提供基于真实文档的回答。</p>
            </div>
            : <div className="reader-placeholder"><div className="reader-placeholder-icon">✦</div><h3>选择左侧对话</h3><p>或直接在下方提问，自动开始一段新对话。</p></div>)
          : <div className="chat-thread-inner">
            {active.messages.map((m) => m.role === "user"
              ? <div className="msg-user" key={m.id}><div className="msg-user-bubble">{m.text}</div></div>
              : <AssistantMessage key={m.id} message={m} onOpenDocument={onOpenDocument} />)}
          </div>}
      </div>

      <div className="chat-composer">
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            placeholder={workspace ? "搜索工作空间文档…" : "请先选择一个工作区"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!workspace}
          />
          <div className="composer-toolbar">
            <span className="composer-tool">{workspace ? workspace.title : "未选择工作区"}</span>
            <button className="send-button" aria-label="发送" disabled={!workspace || !query.trim() || sending} onClick={() => void send()}>
              {sending ? "…" : "↑"}
            </button>
          </div>
        </div>
        <p className="composer-note">Enter 提问 · Shift+Enter 换行 · 全文检索 (FTS5)</p>
      </div>
    </section>
  </div>;
}

function AssistantMessage({ message, onOpenDocument }: { message: ChatMessage; onOpenDocument: (fileId: number) => void }): React.ReactElement {
  const answer = message.answer ?? { kind: "pending" as const };
  return <div className="msg-assistant">
    <div className="msg-avatar">✦</div>
    <div className="msg-assistant-body">
      {answer.kind === "pending" && <p className="msg-status">正在检索工作空间文档…</p>}
      {answer.kind === "error" && <div className="msg-error">检索失败：{answer.message}</div>}
      {answer.kind === "results" && (answer.hits.length === 0
        ? <p className="msg-status">没有找到匹配的文档。尝试换一个关键词，或先索引工作区。</p>
        : <>
          <p className="msg-status">找到 {answer.hits.length} 条相关文档：</p>
          <div className="hit-list">
            {answer.hits.map((hit) => (
              <article key={hit.chunkId} className="hit-card" onClick={() => onOpenDocument(hit.fileId)}>
                <div className="hit-card-path">
                  <span className="hit-card-name">{docName(hit.path)}</span>
                  <span className="hit-card-lines">L{hit.startLine}-{hit.endLine}</span>
                </div>
                <div className="hit-card-filepath">{hit.path}</div>
                <p className="hit-card-preview">{hit.preview}</p>
              </article>
            ))}
          </div>
        </>)}
    </div>
  </div>;
}

// --- Documents page: helpers + sub-components (layout mirrors preview.html) -

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

/** Recursively extracts plain text from react-markdown heading children. */
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

interface HeadingEntry { level: number; text: string; slug: string; }

/** Parses h2/h3 headings out of raw markdown (skipping fenced code blocks). */
function extractHeadings(markdown: string): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m && m[1] && m[2]) {
      const text = m[2].replace(/[*`_]/g, "").trim();
      entries.push({ level: m[1].length, text, slug: slugify(text) });
    }
  }
  return entries;
}

/**
 * Lifts the leading h1 out as the title and the first plain paragraph out as the
 * subtitle, returning the remaining body so neither is rendered twice. Fenced
 * code blocks are skipped when scanning so their contents never become a title
 * or subtitle.
 */
function splitFrontMatter(markdown: string): { title: string | null; subtitle: string | null; body: string } {
  let title: string | null = null;
  let rest = markdown;
  const h1 = /^\s*#\s+(.+?)\s*$/m.exec(markdown);
  if (h1 && h1[1]) {
    const idx = h1.index ?? 0;
    title = h1[1].replace(/[*`_]/g, "").trim();
    rest = (markdown.slice(0, idx) + markdown.slice(idx + h1[0].length)).replace(/^\n+/, "");
  }

  const lines = rest.split("\n");
  const blocks: Array<{ start: number; end: number; kind: string; text: string }> = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\s*```/.test(line)) { inFence = !inFence; i += 1; continue; }
    if (inFence || !line.trim()) { i += 1; continue; }
    const first = line.trim();
    let kind = "paragraph";
    if (/^#{1,6}\s/.test(first)) kind = "heading";
    else if (/^>\s?/.test(first)) kind = "quote";
    else if (/^[-*+]\s/.test(first)) kind = "list";
    else if (/^\d+\.\s/.test(first)) kind = "list";
    else if (/^\|/.test(first)) kind = "table";
    const start = i;
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (next === undefined || !next.trim() || /^\s*```/.test(next)) break;
      i += 1;
    }
    blocks.push({ start, end: i, kind, text: lines.slice(start, i).join("\n") });
  }

  const subtitleBlock = blocks.find((b) => b.kind === "paragraph");
  let subtitle: string | null = null;
  let body = rest;
  if (subtitleBlock) {
    subtitle = subtitleBlock.text.replace(/[*`_]/g, "").trim();
    const remaining = lines.slice();
    remaining.splice(subtitleBlock.start, subtitleBlock.end - subtitleBlock.start);
    body = remaining.join("\n").replace(/^\n+/, "");
  }
  return { title, subtitle, body };
}

function docName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function parentLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "根目录";
  return parts.slice(0, -1).join(" / ");
}

function toTimestamp(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function relativeTime(value: string | null): string {
  if (!value) return "未索引";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "未知";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(value).toLocaleDateString();
}

const ICON_PATHS: Record<string, React.ReactNode> = {
  file: (<><path d="M6 3.5h8.5L19 8v12.5H6v-17Z" /><path d="M14.5 3.5V8H19M9 12h7M9 15h7M9 18h4" /></>),
  spark: (<><path d="M12 2.8c.4 4.8 2.4 6.8 7.2 7.2-4.8.4-6.8 2.4-7.2 7.2-.4-4.8-2.4-6.8-7.2-7.2 4.8-.4 6.8-2.4 7.2-7.2Z" /><path d="M19 15.6c.2 2.1 1.1 3 3.2 3.2-2.1.2-3 1.1-3.2 3.2-.2-2.1-1.1-3-3.2-3.2 2.1-.2 3-1.1 3.2-3.2Z" fill="currentColor" stroke="none" /></>),
  link: <path d="m9.5 14.5 5-5M7.8 17.5l-1.3 1.3a3.7 3.7 0 1 1-5.3-5.3l3-3a3.7 3.7 0 0 1 5.3 0M16.2 6.5l1.3-1.3a3.7 3.7 0 1 1 5.3 5.3l-3 3a3.7 3.7 0 0 1-5.3 0" />,
  panel: (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>),
  more: (<><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>),
  search: (<><circle cx="10.5" cy="10.5" r="6.2" /><path d="m15.2 15.2 4.3 4.3" /></>),
  sort: <path d="M8 5v14m0 0-3-3m3 3 3-3M16 19V5m0 0-3 3m3-3 3 3" />,
  chevron: <path d="m7 9.5 5 5 5-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  trash: (<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></>),
};

function Icon({ name, size = 16, strokeWidth = 1.7 }: { name: string; size?: number; strokeWidth?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name] ?? null}
    </svg>
  );
}

function DocumentsView({ workspace, onAskAI, focusFileId = null }: { workspace: WorkspaceInfo | null; onAskAI: () => void; focusFileId?: number | null }): React.ReactElement {
  const [page, setPage] = useState<LoadState<KbFileListPage>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<number | null>(focusFileId);
  const [content, setContent] = useState<LoadState<KbFileContent>>({ status: "loading" });

  useEffect(() => {
    if (!workspace || !inTauriRuntime()) {
      setPage({ status: "error", message: "请先选择一个工作区" });
      return;
    }
    let cancelled = false;
    setPage({ status: "loading" });
    void invoke<KbFileListPage>("documents_list", { root: workspace.root })
      .then((data) => { if (!cancelled) { setPage({ status: "ready", data }); setSelectedId(focusFileId); } })
      .catch((reason: unknown) => { if (!cancelled) setPage({ status: "error", message: String(reason) }); });
    return () => { cancelled = true; };
  }, [workspace]);

  useEffect(() => {
    if (selectedId === null || !workspace) { setContent({ status: "loading" }); return; }
    let cancelled = false;
    setContent({ status: "loading" });
    void invoke<KbFileContent>("document_read", { root: workspace.root, fileId: selectedId })
      .then((data) => {
        if (cancelled) return;
        if (data) setContent({ status: "ready", data });
        else setContent({ status: "error", message: "文档内容为空或不存在" });
      })
      .catch((reason: unknown) => { if (!cancelled) setContent({ status: "error", message: String(reason) }); });
    return () => { cancelled = true; };
  }, [workspace, selectedId]);

  if (page.status === "loading") return <div className="empty-state"><div className="empty-icon">▤</div><h2>加载文档列表…</h2></div>;
  if (page.status === "error") return <div className="empty-state"><div className="empty-icon">▤</div><h2>无法加载文档</h2><p>{page.message}</p></div>;

  const list = page.data;
  if (list.total === 0) {
    return <div className="empty-state">
      <div className="empty-icon">▤</div>
      <h2>工作区尚未索引</h2>
      <p>在终端运行 <code>llm-wiki index</code> 构建索引后，文档会显示在这里。</p>
    </div>;
  }

  const selectedFile = list.files.find((f) => f.id === selectedId) ?? null;

  return <div className="documents-page">
    <Library files={list.files} total={list.total} selectedId={selectedId} onSelect={setSelectedId} />
    <ReaderShell file={selectedFile} content={content} onAskAI={onAskAI} />
  </div>;
}

interface LibraryProps {
  files: KbFileSummary[];
  total: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
}

function Library({ files, total, selectedId, onSelect }: LibraryProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "recent" | "starred">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? files.filter((f) => `${f.path} ${f.language}`.toLowerCase().includes(q)) : files.slice();
    if (filter === "recent") list.sort((a, b) => toTimestamp(b.indexedAt) - toTimestamp(a.indexedAt));
    return list;
  }, [files, query, filter]);

  const groups = useMemo(() => {
    if (query.trim() || filter === "recent") {
      return [{ label: filter === "recent" ? "最近更新" : "搜索结果", items: filtered }];
    }
    const map = new Map<string, KbFileSummary[]>();
    for (const f of filtered) {
      const label = parentLabel(f.path);
      const arr = map.get(label) ?? [];
      arr.push(f);
      map.set(label, arr);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
  }, [filtered, query, filter]);

  return (
    <aside className="library">
      <div className="library-head">
        <div className="section-title-row">
          <div><span className="section-title">知识库</span><span className="section-count">{total}</span></div>
          <div className="small-actions">
            <button className="lib-icon-btn" title="筛选"><Icon name="filter" size={15} /></button>
            <button className="lib-icon-btn" title="导入文档"><Icon name="plus" size={15} /></button>
          </div>
        </div>
        <label className="library-search">
          <Icon name="search" size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选当前知识库" />
        </label>
      </div>
      <div className="library-filter">
        {(["all", "recent", "starred"] as const).map((key) => (
          <button key={key} className={filter === key ? "filter-chip active" : "filter-chip"} onClick={() => setFilter(key)}>
            {key === "all" ? "全部" : key === "recent" ? "最近" : "收藏"}
          </button>
        ))}
        <button className="filter-chip sort" title="排序"><Icon name="sort" size={14} /></button>
      </div>
      <div className="doc-scroll">
        {filter === "starred"
          ? <div className="doc-empty">还没有收藏的文档<br />收藏后可在此快速访问</div>
          : filtered.length === 0
            ? <div className="doc-empty">没有找到匹配的文档<br />换一个关键词试试</div>
            : groups.map((g) => (
              <div key={g.label}>
                <div className="doc-group-label">{g.label}</div>
                {g.items.map((f) => (
                  <article key={f.id} className={f.id === selectedId ? "doc-item active" : "doc-item"} onClick={() => onSelect(f.id)}>
                    <div className="doc-icon"><Icon name="file" size={16} /></div>
                    <div className="doc-copy">
                      <div className="doc-title">{docName(f.path)}</div>
                      <div className="doc-path">{f.path}</div>
                      <div className="doc-meta">
                        <span>{f.chunkCount} 个切片</span><span className="meta-dot" />
                        <span>{relativeTime(f.indexedAt)}</span>
                      </div>
                    </div>
                    <button className="doc-menu" aria-label="更多操作" onClick={(e) => e.stopPropagation()}><Icon name="more" size={15} /></button>
                  </article>
                ))}
              </div>
            ))}
      </div>
    </aside>
  );
}

interface ReaderShellProps {
  file: KbFileSummary | null;
  content: LoadState<KbFileContent>;
  onAskAI: () => void;
}

function ReaderShell({ file, content, onAskAI }: ReaderShellProps): React.ReactElement {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [activeHeading, setActiveHeading] = useState("");
  const [toast, setToast] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const markdown = content.status === "ready" ? content.data.content : "";
  const { title: liftedTitle, subtitle, body } = useMemo(() => splitFrontMatter(markdown), [markdown]);
  const headings = useMemo(() => extractHeadings(body), [body]);

  // Reset to the first heading whenever the document (or view) changes.
  useEffect(() => {
    const first = headings[0];
    setActiveHeading(first ? first.slug : "");
  }, [headings]);

  // Scroll-spy: highlight the TOC entry for the heading nearest the top.
  useEffect(() => {
    const el = scrollRef.current;
    const first = headings[0];
    if (!el || !first || view !== "preview") return;
    const onScroll = (): void => {
      let current = first.slug;
      for (const h of headings) {
        const node = el.querySelector(`[id="${h.slug}"]`) as HTMLElement | null;
        if (node && node.getBoundingClientRect().top < 180) current = h.slug;
      }
      setActiveHeading(current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [headings, view]);

  const scrollToHeading = (slug: string): void => {
    const el = scrollRef.current;
    const node = el?.querySelector(`[id="${slug}"]`) as HTMLElement | null;
    node?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const copyLink = async (): Promise<void> => {
    if (!file) return;
    try { await navigator.clipboard.writeText(`llm-wiki://${file.path}`); } catch { /* clipboard unavailable */ }
    setToast(true);
    window.setTimeout(() => setToast(false), 1500);
  };

  const ready = content.status === "ready";
  const segments = ready ? content.data.path.split("/").filter(Boolean) : [];
  const articleTitle = ready ? (liftedTitle ?? docName(content.data.path)) : "";

  return (
    <section className="reader-shell">
      <div className="reader-toolbar">
        <div className="toolbar-breadcrumb">
          {segments.length === 0
            ? <span className="current">未选择文档</span>
            : segments.map((seg, i) => (
              <span key={i} className="crumb">
                {i > 0 && <em>/</em>}
                <span className={i === segments.length - 1 ? "current" : ""}>{seg}</span>
              </span>
            ))}
        </div>
        <div className="toolbar-spacer" />
        <div className="segmented">
          <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>预览</button>
          <button className={view === "source" ? "active" : ""} onClick={() => setView("source")}>源码</button>
        </div>
        <button className="tool-button" onClick={() => void copyLink()}><Icon name="link" size={14} /><span>复制链接</span></button>
        <button className="tool-button primary" onClick={onAskAI}><Icon name="spark" size={14} /><span>询问 AI</span></button>
        <button className="lib-icon-btn" aria-label="更多操作"><Icon name="more" size={17} /></button>
      </div>

      <div className="reader-scroll" ref={scrollRef}>
        {file === null
          ? <div className="reader-placeholder"><div className="reader-placeholder-icon">▤</div><h3>选择左侧文档</h3><p>从知识库中选一篇文档开始阅读。</p></div>
          : content.status === "loading"
            ? <div className="reader-placeholder"><h3>加载中…</h3></div>
            : content.status === "error"
              ? <div className="reader-placeholder"><h3>无法加载文档</h3><p>{content.message}</p></div>
              : <div className="reader-layout">
                <article className="article">
                  <header className="article-header">
                    <div className="eyebrow-doc"><span className="line" /><span>{content.data.language === "markdown" ? "Markdown" : content.data.language} 文档</span></div>
                    <h1>{articleTitle}</h1>
                    {subtitle && <p className="article-subtitle">{subtitle}</p>}
                    <div className="article-meta">
                      <span className="tag blue">{content.data.language}</span>
                      <span className="tag">{content.data.chunks.length} 个切片</span>
                      <span className="updated">更新于 {relativeTime(file.indexedAt)}</span>
                    </div>
                  </header>
                  {view === "preview"
                    ? <ArticleMarkdown markdown={body} />
                    : <div className="source-view"><pre>{markdown}</pre></div>}
                </article>
                {view === "preview" && headings.length > 0 && (
                  <aside className="toc">
                    <div className="toc-title"><span>本文目录</span><Icon name="panel" size={14} /></div>
                    <nav className="toc-list">
                      {headings.map((h) => (
                        <a
                          key={h.slug}
                          href={`#${h.slug}`}
                          className={[activeHeading === h.slug ? "active" : "", h.level === 3 ? "sub" : ""].join(" ").trim()}
                          onClick={(e) => { e.preventDefault(); scrollToHeading(h.slug); }}
                        >
                          {h.text}
                        </a>
                      ))}
                    </nav>
                  </aside>
                )}
              </div>}
      </div>
      <div className={toast ? "toast show" : "toast"} role="status">已复制文档链接</div>
    </section>
  );
}

function ArticleMarkdown({ markdown }: { markdown: string }): React.ReactElement {
  return (
    <div className="article-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={slugify(extractText(children))}>{children}</h1>,
          h2: ({ children }) => <h2 id={slugify(extractText(children))}>{children}</h2>,
          h3: ({ children }) => <h3 id={slugify(extractText(children))}>{children}</h3>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

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
    // Default target path: wiki/<filename without extension>.md
    const stem = name.replace(/\.[^.]+$/, "");
    setTargetPath(`wiki/${stem}.md`);
    try {
      // Try direct text read first.
      const text = await invoke<string>("attachment_read", { root: workspace.root, name });
      setContent(text);
    } catch {
      // If that fails and the file is extractable (PDF/DOCX), try extraction.
      if (isExtractable) {
        try {
          const extracted = await invoke<string>("attachment_extract", { root: workspace.root, name });
          setContent(extracted);
        } catch (reason: unknown) {
          setError(String(reason));
        }
      }
      // Otherwise leave content null — the UI shows "unsupported".
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
    return <div className="empty-state"><div className="empty-icon">↥</div><h2>导入知识文档</h2><p className="muted">请先选择一个工作区。</p></div>;
  }

  return <div className="split-panel">
    <div className="file-tree">
      <strong>已导入文件（{attachments.length}）</strong>
      <button className="primary-button" style={{ margin: "0.5em 0", width: "calc(100% - 1em)" }} disabled={busy} onClick={() => void pickAndImport()}>
        {busy ? "导入中…" : "＋ 选择文件"}
      </button>
      {attachments.length === 0
        ? <p className="muted" style={{ padding: "0 0.5em" }}>暂无已导入文件。选择一个文本文件开始。</p>
        : attachments.map((att) => (
          <button
            className={att.name === selected ? "file-item selected" : "file-item"}
            key={att.name}
            onClick={() => void loadContent(att.name, att.isExtractable)}
          >
            ▤ {att.name}
            <small>{att.isText ? `${(att.size / 1024).toFixed(1)}KB · 文本` : att.isExtractable ? `${(att.size / 1024).toFixed(1)}KB · 可提取` : `${(att.size / 1024).toFixed(1)}KB · 二进制`}</small>
          </button>
        ))}
    </div>
    <article className="document-reader">
      {error && <p style={{ color: "var(--danger, #c0392b)" }}>错误：{error}</p>}
      {selected === null
        ? <><h2>导入知识文档</h2><p className="muted">选择外部文件导入到 attachments/。文本文件直接预览，PDF/DOCX 自动提取文本。</p></>
        : <>
          <span className="eyebrow">{selected}</span>
          <h2>创建草稿写入 wiki</h2>
          {content === null
            ? <p className="muted">正在提取文本…</p>
            : <>
              <label>目标路径
                <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder="wiki/new-doc.md" style={{ width: "100%", margin: "0.25em 0", padding: "0.4em" }} />
              </label>
              <button className="primary-button" style={{ margin: "0.5em 0" }} disabled={!targetPath.trim()} onClick={() => void createDraft()}>创建草稿</button>
              <p className="muted" style={{ fontSize: "0.85em" }}>草稿创建后可在「写入草稿」菜单确认写入。写入时将自动创建备份。</p>
              <h3 style={{ marginTop: "1em" }}>内容预览</h3>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0, padding: "0.75em", background: "var(--surface-2, #f5f5f5)", borderRadius: "6px", maxHeight: "400px", overflow: "auto" }}>
                {content.slice(0, 5000)}{content.length > 5000 ? "\n\n…（预览截断，完整内容将写入草稿）" : ""}
              </pre>
            </>}
        </>}
    </article>
  </div>;
}

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

  // Load the draft list whenever the workspace or refreshKey changes.
  useEffect(() => {
    if (!workspace || !inTauriRuntime()) {
      setDrafts({ status: "error", message: "请先选择一个工作区" });
      return;
    }
    let cancelled = false;
    setDrafts({ status: "loading" });
    void invoke<Draft[]>("draft_list", { root: workspace.root })
      .then((data) => { if (!cancelled) { setDrafts({ status: "ready", data }); setSelectedId(null); } })
      .catch((reason: unknown) => { if (!cancelled) setDrafts({ status: "error", message: String(reason) }); });
    return () => { cancelled = true; };
  }, [workspace, refreshKey]);

  const selectedDraft = drafts.status === "ready" ? drafts.data.find((d) => d.draftId === selectedId) ?? null : null;

  const refresh = (): void => { setActionError(null); setRefreshKey((k) => k + 1); };

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

  if (drafts.status === "loading") return <div className="empty-state"><div className="empty-icon">◒</div><h2>加载草稿列表…</h2></div>;
  if (drafts.status === "error") return <div className="empty-state"><div className="empty-icon">◒</div><h2>无法加载草稿</h2><p>{drafts.message}</p></div>;

  const list = drafts.data;
  const pending = list.filter((d) => d.status === "pending");

  if (list.length === 0) {
    return <div className="empty-state">
      <div className="empty-icon">◒</div>
      <h2>暂无草稿</h2>
      <p className="muted">Pi 生成的写入草稿会出现在这里，等待你确认后再写入 wiki。目前没有草稿。</p>
    </div>;
  }

  return <div className="split-panel">
    <div className="file-tree">
      <strong>草稿（{pending.length} 待确认 · {list.length} 总计）</strong>
      {list.map((draft) => (
        <button
          className={draft.draftId === selectedId ? "file-item selected" : "file-item"}
          key={draft.draftId}
          onClick={() => { setSelectedId(draft.draftId); setActionError(null); }}
        >
          ▒ {draft.targetPath}
          <small>{OPERATION_LABELS[draft.operationType] ?? draft.operationType} · {draft.status}</small>
        </button>
      ))}
    </div>
    <article className="document-reader">
      {actionError && <p style={{ color: "var(--danger, #c0392b)" }}>操作失败：{actionError}</p>}
      {selectedDraft === null
        ? <><h2>选择左侧草稿</h2><p className="muted">共 {pending.length} 个待确认草稿。</p></>
        : <>
          <span className="eyebrow">{OPERATION_LABELS[selectedDraft.operationType] ?? selectedDraft.operationType}</span>
          <h2>{selectedDraft.targetPath}</h2>
          <p className="muted">
            状态：{selectedDraft.status} · 创建者：{selectedDraft.createdBy}
            {selectedDraft.baseDocumentHash && ` · 基准哈希：${selectedDraft.baseDocumentHash.slice(0, 12)}…`}
            {selectedDraft.sourceCitations.length > 0 && ` · 引用 ${selectedDraft.sourceCitations.length} 个来源`}
          </p>
          {selectedDraft.status === "pending"
            ? <div style={{ display: "flex", gap: "0.75em", margin: "1em 0" }}>
              <button className="primary-button" onClick={() => void applyDraft(selectedDraft.draftId)}>确认写入</button>
              <button className="primary-button" style={{ opacity: 0.6 }} onClick={() => void rejectDraft(selectedDraft.draftId)}>拒绝</button>
            </div>
            : <p className="muted" style={{ fontStyle: "italic" }}>此草稿已处理（{selectedDraft.status}）。</p>}
          <h3 style={{ marginTop: "1em" }}>生成内容预览</h3>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0, padding: "0.75em", background: "var(--surface-2, #f5f5f5)", borderRadius: "6px" }}>
            {selectedDraft.generatedContent}
          </pre>
        </>}
    </article>
  </div>;
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

function TasksView({ workspace, onIndexed }: { workspace: WorkspaceInfo | null; onIndexed: () => void }): React.ReactElement {
  const [indexing, setIndexing] = useState(false);
  const [lastResult, setLastResult] = useState<IndexStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runIndex = async (): Promise<void> => {
    if (!workspace || !inTauriRuntime() || indexing) return;
    setIndexing(true);
    setError(null);
    try {
      const stats = await invoke<IndexStats>("index_run", { root: workspace.root });
      setLastResult(stats);
      onIndexed();
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setIndexing(false);
    }
  };

  return <div className="task-list">
    <div className="task-row" style={{ alignItems: "flex-start" }}>
      <span className="task-bullet" />
      <div style={{ flex: 1 }}>
        <strong>索引工作区</strong>
        <p>扫描 <code>wiki/</code> 目录并构建 FTS5 全文索引。支持增量更新(仅处理变更文件)。</p>
        {error && <p style={{ color: "var(--danger, #c0392b)" }}>错误：{error}</p>}
        {lastResult && !indexing && <p className="muted" style={{ marginTop: "0.5em" }}>
          上次结果：扫描 {lastResult.scanned} · 新增 {lastResult.added} · 更新 {lastResult.updated} · 跳过 {lastResult.skipped} · 删除 {lastResult.deleted} · 切片 {lastResult.chunks}
        </p>}
      </div>
      <button
        className="primary-button"
        disabled={!workspace || indexing}
        onClick={() => void runIndex()}
        style={{ whiteSpace: "nowrap" }}
      >
        {indexing ? "索引中…" : "重新索引"}
      </button>
    </div>
    {!workspace && <p className="muted" style={{ padding: "0 1em" }}>请先选择一个工作区。</p>}
  </div>;
}

function SettingsView({ workspace, kbStats }: { workspace: WorkspaceInfo | null; kbStats: KbStats | null }): React.ReactElement {
  const indexed = kbStats?.tablesOk ?? false;
  const fileCount = kbStats?.files ?? 0;
  const chunkCount = kbStats?.chunks ?? 0;
  const vectorAvailable = kbStats?.vectorEnabled ?? false;

  return <div className="settings-grid">
    <div className="setting-card">
      <span className="eyebrow">工作区</span>
      <h2>{workspace?.title ?? "未选择"}</h2>
      <p>{workspace?.root ?? "选择一个本地工作区开始使用。"}</p>
    </div>
    <div className="setting-card">
      <span className="eyebrow">索引状态</span>
      <h2>{indexed ? `${fileCount} 文档` : "未索引"}</h2>
      <p>
        {indexed
          ? `${chunkCount} chunks · ${kbStats?.ftsRecords ?? 0} FTS 记录`
          : "前往「后台任务」点击「重新索引」构建索引。"}
      </p>
    </div>
    <div className="setting-card">
      <span className="eyebrow">存储引擎</span>
      <h2>Rust Core</h2>
      <p>SQLite WAL · FTS5 全文检索{vectorAvailable ? " · 向量检索已启用" : " · FTS-only（向量未启用）"}</p>
    </div>
    <div className="setting-card">
      <span className="eyebrow">写入安全</span>
      <h2>受控写入</h2>
      <p>草稿确认机制 · expectedHash 校验 · 原子写入 · 自动备份</p>
    </div>
  </div>;
}
