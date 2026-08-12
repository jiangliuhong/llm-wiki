import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type View = "chat" | "documents" | "relations" | "imports" | "drafts" | "tasks" | "settings";

interface WorkspaceInfo {
  id: string;
  title: string;
  root: string;
  resolvedBy: string;
}

type WorkspaceMode = "recent" | "open" | "create";
type RuntimeMode = "pi" | "preview";

const WORKSPACE_STORAGE_KEY = "llm-wiki.desktop.workspaces";

const previewWorkspace: WorkspaceInfo = {
  id: "preview",
  title: "LLM Wiki",
  root: "本地工作空间",
  resolvedBy: "preview",
};

function inTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function readStoredWorkspaces(): WorkspaceInfo[] {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WorkspaceInfo => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === "string" && typeof candidate.title === "string" && typeof candidate.root === "string";
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
        setKnownWorkspaces((previous) => {
          const next = [current, ...previous.filter((item) => item.id !== current.id)];
          saveStoredWorkspaces(next);
          return next;
        });
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
                  onClick={() => setView(item.id)}
                >
                  <span>{item.icon}</span>{item.label}
                  {item.id === "drafts" && <em>2</em>}
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
              <button className="search-button" aria-label="搜索工作空间"><span>⌕</span>搜索 <kbd>⌘ K</kbd></button>
              <span className="connection-pill"><span className="status-dot" />本地</span>
              <div className="runtime-selector">
                <button className="runtime-picker" aria-label="选择 Pi Runtime" aria-expanded={runtimeMenuOpen} onClick={() => { setRuntimeMenuOpen((open) => !open); setWorkspaceMenuOpen(false); }}>✦ Pi <span>⌄</span></button>
                {runtimeMenuOpen && <RuntimeMenu selected={runtimeMode} onSelect={(mode) => { setRuntimeMode(mode); setRuntimeMenuOpen(false); }} />}
              </div>
              <button className="icon-button" aria-label="更多操作">•••</button>
            </div>
          </header>
          <div className="content-pane">
            {error && <div className="error-banner">Core 尚未连接：{error}</div>}
            {view === "chat" && <ChatView />}
            {view === "documents" && <DocumentsView />}
            {view === "relations" && <RelationsView />}
            {view === "imports" && <ImportsView />}
            {view === "drafts" && <DraftsView />}
            {view === "tasks" && <TasksView />}
            {view === "settings" && <SettingsView />}
          </div>
        </section>
      </div>
      <footer className="statusbar">148 documents · 2,481 chunks · index ready <span>Rust Core · SQLite · FTS5</span></footer>
      {workspaceMenuOpen && <>
        <button className="workspace-modal-backdrop" type="button" aria-label="关闭工作区选择器" onClick={() => setWorkspaceMenuOpen(false)} />
        <WorkspaceMenu mode={workspaceMode} setMode={setWorkspaceMode} workspace={workspace} workspaces={knownWorkspaces} onSelect={selectWorkspace} path={workspacePath} setPath={setWorkspacePath} title={workspaceTitle} setTitle={setWorkspaceTitle} onOpen={openWorkspace} onCreate={createWorkspace} onClose={() => setWorkspaceMenuOpen(false)} error={workspaceError} />
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
  path: string;
  setPath: (path: string) => void;
  title: string;
  setTitle: (title: string) => void;
  onOpen: () => Promise<void>;
  onCreate: () => Promise<void>;
  onClose: () => void;
  error: string | null;
}

function WorkspaceMenu({ mode, setMode, workspace, workspaces, onSelect, path, setPath, title, setTitle, onOpen, onCreate, onClose, error }: WorkspaceMenuProps): React.ReactElement {
  return <div className="workspace-menu" role="dialog" aria-label="工作区选择器">
    <div className="workspace-menu-header"><div><strong>工作区</strong><small>{workspace?.root ?? "选择一个本地知识库"}</small></div><button className="menu-close" onClick={onClose} aria-label="关闭工作区选择器">×</button></div>
    <div className="workspace-tabs">
      <button className={mode === "recent" ? "active" : ""} onClick={() => setMode("recent")}>最近使用</button>
      <button className={mode === "open" ? "active" : ""} onClick={() => setMode("open")}>打开</button>
      <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>新建</button>
    </div>
    {mode === "recent" && <div className="workspace-list">
      {workspaces.length === 0 && <p className="menu-empty">还没有记录，打开一个本地工作区开始使用。</p>}
      {workspaces.map((item) => <button key={item.id} className={item.id === workspace?.id ? "workspace-entry active" : "workspace-entry"} onClick={() => void onSelect(item)}>
        <span className="workspace-entry-avatar">{item.title.slice(0, 2)}</span><span><strong>{item.title}</strong><small>{item.root}</small></span>{item.id === workspace?.id && <span className="workspace-check">✓</span>}
      </button>)}
    </div>}
    {(mode === "open" || mode === "create") && <div className="workspace-form">
      {mode === "create" && <label>工作区名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品知识库" /></label>}
      <label>目录路径<input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void (mode === "open" ? onOpen() : onCreate()); }} placeholder="/Users/you/Documents/wiki" autoFocus /></label>
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

function ChatView(): React.ReactElement {
  return <div className="chat-page"><div className="welcome-block"><div className="hero-icon">✦</div><h2>你好，有什么可以帮忙？</h2><p>Pi 会先检索当前工作空间，再基于真实文档回答，并保留可追溯引用。</p></div><div className="suggestions"><button><span>⌕</span>总结国家数据权限的关键约束</button><button><span>⌁</span>这个模块依赖哪些文档？</button></div><div className="chat-composer"><div className="composer-inner"><textarea placeholder="询问当前工作空间…" /><div className="composer-toolbar"><button className="composer-tool">＋ <span>添加上下文</span></button><button className="send-button" aria-label="发送">↑</button></div></div><p className="composer-note">LLM Wiki AI 可能会出错，请核对重要信息。</p></div></div>;
}

function DocumentsView(): React.ReactElement {
  return <div className="split-panel"><div className="file-tree"><strong>知识文档</strong>{["系统整体架构.md", "数据模型.md", "国家数据权限.md", "预测规则.md", "月度结果表.md", "指标管理.md"].map((name, index) => <button className={index === 2 ? "file-item selected" : "file-item"} key={name}>▤ {name}<small>{index * 8 + 18} chunks</small></button>)}</div><article className="document-reader"><span className="eyebrow">wiki / P&amp;L</span><h2>国家数据权限设计</h2><p className="muted">更新于 2026-08-10 · 42 个切片 · 已索引</p><h3>1. 权限范围</h3><p>最终可访问国家集合由请求参数、用户与组织权限、应用配置三者交集计算。</p><h3>2. 后端约束</h3><p>列表、汇总、导出和异步任务必须调用统一权限服务。</p></article></div>;
}

function RelationsView(): React.ReactElement {
  return <div className="relation-layout"><div className="graph-card"><div className="graph-node center">国家数据权限</div><div className="graph-line line-a" /><div className="graph-line line-b" /><div className="graph-node node-a">系统整体架构</div><div className="graph-node node-b">预测规则</div><div className="graph-node node-c">月度结果表</div></div><div className="relation-list"><h3>已发布关系</h3><RelationRow label="系统整体架构.md" type="depends_on" direction="入边" /><RelationRow label="预测规则.md" type="references" direction="出边" /><RelationRow label="月度结果表.md" type="implements" direction="出边" /><p className="muted">Agent 候选关系只有审核通过后才会进入图谱。</p></div></div>;
}

function RelationRow({ label, type, direction }: { label: string; type: string; direction: string }): React.ReactElement {
  return <div className="relation-row"><strong>{label}</strong><span>{type} · {direction}</span></div>;
}

function ImportsView(): React.ReactElement { return <div className="empty-state"><div className="empty-icon">↥</div><h2>导入知识文档</h2><p>原始文件保留在 attachments，确认整理方案后才写入 wiki。</p><button className="primary-button">选择文件</button><div className="task-card">业务需求说明.docx <span>等待确认 · Pi 拆分为 4 份文档</span></div></div>; }
function DraftsView(): React.ReactElement { return <div className="panel-stack"><div className="draft-card"><div><span className="eyebrow">待确认 · Pi</span><h2>更新国家数据权限.md</h2><p>wiki/P&amp;L/国家数据权限.md · 基于 SHA-256 生成</p></div><button className="primary-button">查看 Diff</button></div><div className="diff-preview"><div><del>没有配置权限时按全部国家处理。</del><ins>没有配置权限时默认拒绝，不得自动扩大到全部国家。</ins></div></div></div>; }
function TasksView(): React.ReactElement { return <div className="task-list"><Task label="增量索引" detail="更新 3 个文档，新增 67 个切片" state="完成" /><Task label="提取规则评审.pdf" detail="文本提取与标题识别" state="运行中 · 64%" /><Task label="MCP document_search" detail="调用方：Codex · 只读模式" state="完成" /></div>; }
function Task({ label, detail, state }: { label: string; detail: string; state: string }): React.ReactElement { return <div className="task-row"><span className="task-bullet" /><div><strong>{label}</strong><p>{detail}</p></div><span className="task-state">{state}</span></div>; }
function SettingsView(): React.ReactElement { return <div className="settings-grid"><div className="setting-card"><span className="eyebrow">Pi Runtime</span><h2>连接正常</h2><p>Sidecar Host Bridge · 禁用 Bash / Write / Edit</p></div><div className="setting-card"><span className="eyebrow">MCP 集成</span><h2>只读</h2><p>外部 Agent 只能搜索、读取和查看关系图谱。</p></div><div className="setting-card"><span className="eyebrow">索引与存储</span><h2>本地 SQLite</h2><p>WAL · FTS5 · 向量能力不可用时自动 FTS-only。</p></div></div>; }
