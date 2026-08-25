import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauriRuntime } from "./RelationsView";

export interface SettingsWorkspace {
  id?: string;
  title: string;
  root: string;
}

export interface SettingsKbStats {
  files: number;
  chunks: number;
  ftsRecords: number;
  vectorRecords: number;
  vectorEnabled: boolean;
  tablesOk: boolean;
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
  exclude: string[];
  defaults: string[];
  defaultExclude: string[];
}

interface PiEnvironmentInfo {
  nodeVersion: string | null;
  piVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  status: string;
  message: string;
}

interface PiUpgradeResult {
  success: boolean;
  message: string;
  output: string;
}

export interface SettingsViewProps {
  workspace: SettingsWorkspace | null;
  kbStats: SettingsKbStats | null;
  knownWorkspaceCount: number;
  onOpenWorkspaceMenu: () => void;
  onIndexed: () => void;
  onWorkspaceRenamed?: (updated: SettingsWorkspace) => void;
}

// --- Inline icons (same 24×24 stroke style as the shared Icon component) ----

const ICONS: Record<string, React.ReactNode> = {
  workspace: (
    <>
      <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11.5Z" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" />
      <path d="M3.5 11.5h17" />
    </>
  ),
  index: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 3v5.2c0 4.6-3.2 8.2-7.5 9.8-4.3-1.6-7.5-5.2-7.5-9.8V6L12 3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </>
  ),
  app: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  cpu: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
};

function Icon({
  name,
  size = 16,
  strokeWidth = 1.7,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] ?? null}
    </svg>
  );
}

export default function SettingsView({
  workspace,
  kbStats,
  knownWorkspaceCount,
  onOpenWorkspaceMenu,
  onIndexed,
  onWorkspaceRenamed,
}: SettingsViewProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<"workspace" | "app">("workspace");

  // Index pass state
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [lastIndexResult, setLastIndexResult] = useState<IndexStats | null>(null);

  // Workspace rename state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  // Index directory config state
  const [includeDirs, setIncludeDirs] = useState<string[]>([]);
  const [defaultDirs, setDefaultDirs] = useState<string[]>([]);
  const [dirInput, setDirInput] = useState("");
  const [dirSaving, setDirSaving] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Exclude / Ignore rules config state
  const [excludeRules, setExcludeRules] = useState<string[]>([]);
  const [defaultExclude, setDefaultExclude] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState("");
  const [excludeSaving, setExcludeSaving] = useState(false);
  const [excludeError, setExcludeError] = useState<string | null>(null);

  // Pi Environment & Upgrade state
  const [piInfo, setPiInfo] = useState<PiEnvironmentInfo | null>(null);
  const [piChecking, setPiChecking] = useState(false);
  const [piUpgrading, setPiUpgrading] = useState(false);
  const [piError, setPiError] = useState<string | null>(null);
  const [piUpgradeOutput, setPiUpgradeOutput] = useState<string | null>(null);

  // Sync workspace title
  useEffect(() => {
    setEditingTitle(false);
    setTitleInput(workspace?.title ?? "");
    setTitleError(null);
  }, [workspace]);

  // Load the workspace's index and exclude configs
  useEffect(() => {
    setDirInput("");
    setDirError(null);
    setExcludeInput("");
    setExcludeError(null);
    if (!workspace || !inTauriRuntime()) {
      setIncludeDirs([]);
      setDefaultDirs([]);
      setExcludeRules([]);
      setDefaultExclude([]);
      return;
    }
    let cancelled = false;
    void invoke<KbConfigInfo>("kb_config_get", { root: workspace.root })
      .then((config) => {
        if (!cancelled) {
          setIncludeDirs(config.include || []);
          setDefaultDirs(config.defaults || ["wiki", "docs"]);
          setExcludeRules(config.exclude || []);
          setDefaultExclude(config.defaultExclude || []);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setDirError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  // Initial Pi check on mount
  useEffect(() => {
    if (!inTauriRuntime()) return;
    let cancelled = false;
    void invoke<PiEnvironmentInfo>("pi_environment_check")
      .then((info) => {
        if (!cancelled) setPiInfo(info);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPiError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveTitle = async (): Promise<void> => {
    if (!workspace || titleSaving) return;
    const trimmed = titleInput.trim();
    if (!trimmed) {
      setTitleError("工作区名称不能为空");
      return;
    }
    setTitleSaving(true);
    setTitleError(null);
    try {
      const updated = await invoke<SettingsWorkspace>("workspace_rename", {
        root: workspace.root,
        title: trimmed,
      });
      setEditingTitle(false);
      onWorkspaceRenamed?.(updated);
    } catch (reason: unknown) {
      setTitleError(String(reason));
    } finally {
      setTitleSaving(false);
    }
  };

  const saveIncludeDirs = async (next: string[]): Promise<void> => {
    if (!workspace || dirSaving) return;
    setDirSaving(true);
    setDirError(null);
    try {
      const config = await invoke<KbConfigInfo>("kb_config_set_include", {
        root: workspace.root,
        include: next,
      });
      setIncludeDirs(config.include);
    } catch (reason: unknown) {
      setDirError(String(reason));
    } finally {
      setDirSaving(false);
    }
  };

  const addDir = (): void => {
    const value = dirInput.trim().replace(/^\/+|\/+$/g, "");
    if (!value) return;
    if (includeDirs.includes(value)) {
      setDirError(`目录 ${value} 已在索引列表中。`);
      return;
    }
    setDirInput("");
    void saveIncludeDirs([...includeDirs, value]);
  };

  const saveExcludeRules = async (next: string[]): Promise<void> => {
    if (!workspace || excludeSaving) return;
    setExcludeSaving(true);
    setExcludeError(null);
    try {
      const config = await invoke<KbConfigInfo>("kb_config_set_exclude", {
        root: workspace.root,
        exclude: next,
      });
      setExcludeRules(config.exclude);
    } catch (reason: unknown) {
      setExcludeError(String(reason));
    } finally {
      setExcludeSaving(false);
    }
  };

  const addExcludeRule = (): void => {
    const value = excludeInput.trim().replace(/^\/+/, "");
    if (!value) return;
    if (excludeRules.includes(value)) {
      setExcludeError(`规则 ${value} 已在忽略列表中。`);
      return;
    }
    setExcludeInput("");
    void saveExcludeRules([...excludeRules, value]);
  };

  const checkPi = async (): Promise<void> => {
    if (piChecking || !inTauriRuntime()) return;
    setPiChecking(true);
    setPiError(null);
    setPiUpgradeOutput(null);
    try {
      const res = await invoke<PiEnvironmentInfo>("pi_environment_check");
      setPiInfo(res);
    } catch (reason: unknown) {
      setPiError(String(reason));
    } finally {
      setPiChecking(false);
    }
  };

  const upgradePi = async (): Promise<void> => {
    if (piUpgrading || !inTauriRuntime()) return;
    setPiUpgrading(true);
    setPiError(null);
    setPiUpgradeOutput(null);
    try {
      const res = await invoke<PiUpgradeResult>("pi_upgrade");
      setPiUpgradeOutput(res.output || res.message);
      await checkPi();
    } catch (reason: unknown) {
      setPiError(String(reason));
    } finally {
      setPiUpgrading(false);
    }
  };

  const runIndex = async (): Promise<void> => {
    if (!workspace || !inTauriRuntime() || indexing) return;
    setIndexing(true);
    setIndexError(null);
    try {
      const stats = await invoke<IndexStats>("index_run", { root: workspace.root });
      setLastIndexResult(stats);
      onIndexed();
    } catch (reason: unknown) {
      setIndexError(String(reason));
    } finally {
      setIndexing(false);
    }
  };

  const indexed = kbStats?.tablesOk ?? false;

  return (
    <div className="settings-page">
      <div className="sg-scroll">
        <header className="sg-header">
          <h1>设置</h1>
          <p>知识库工作区与全局应用运行时的配置中心。</p>
        </header>

        {/* Tab Navigator */}
        <nav className="sg-nav-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "workspace"}
            className={`sg-nav-tab ${activeTab === "workspace" ? "active" : ""}`}
            onClick={() => setActiveTab("workspace")}
          >
            <Icon name="workspace" size={15} />
            <span>工作区设置</span>
            {workspace && <span className="sg-nav-badge">{workspace.title}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "app"}
            className={`sg-nav-tab ${activeTab === "app" ? "active" : ""}`}
            onClick={() => setActiveTab("app")}
          >
            <Icon name="app" size={15} />
            <span>应用全局设置</span>
            {piInfo?.hasUpdate && (
              <span className="sg-badge warning" style={{ fontSize: 10 }}>
                有更新
              </span>
            )}
          </button>
        </nav>

        {/* ----------------- TAB 1: WORKSPACE SETTINGS ----------------- */}
        {activeTab === "workspace" && (
          <>
            <p className="sg-tab-lead">
              当前工作区专属配置，规则与数据库独立保存在{" "}
              <code>{workspace ? `${workspace.title}/.llm-wiki/` : ".llm-wiki/"}</code> 中。
            </p>

            {!workspace ? (
              <div className="sg-empty-state">
                <h3>未选择工作区</h3>
                <p>请先打开或创建一个本地知识库工作区，以配置索引目录和排除规则。</p>
                <button type="button" className="sg-button primary" onClick={onOpenWorkspaceMenu}>
                  选择工作区
                </button>
              </div>
            ) : (
              <>
                {/* 1.1 Workspace Basic Info & Renaming */}
                <section className="sg-section">
                  <div className="sg-section-head">
                    <span className="sg-section-icon">
                      <Icon name="workspace" />
                    </span>
                    <div>
                      <strong>工作区基础信息</strong>
                      <p>当前连接的本地知识库工作区，支持在线重命名与切换。</p>
                    </div>
                    <button type="button" className="sg-button" onClick={onOpenWorkspaceMenu}>
                      切换工作区
                    </button>
                  </div>
                  <div className="sg-kv">
                    <div className="sg-kv-row">
                      <span>工作区名称</span>
                      {editingTitle ? (
                        <div className="sg-title-edit">
                          <input
                            value={titleInput}
                            onChange={(e) => setTitleInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleSaveTitle();
                              if (e.key === "Escape") setEditingTitle(false);
                            }}
                            disabled={titleSaving}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="sg-inline-btn primary"
                            disabled={titleSaving || !titleInput.trim()}
                            onClick={() => void handleSaveTitle()}
                          >
                            {titleSaving ? "保存中…" : "保存"}
                          </button>
                          <button
                            type="button"
                            className="sg-inline-btn"
                            disabled={titleSaving}
                            onClick={() => {
                              setEditingTitle(false);
                              setTitleInput(workspace?.title ?? "");
                            }}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <strong>{workspace.title}</strong>
                          {inTauriRuntime() && (
                            <button
                              type="button"
                              className="sg-inline-btn"
                              onClick={() => {
                                setEditingTitle(true);
                                setTitleInput(workspace.title);
                                setTitleError(null);
                              }}
                            >
                              修改名称
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {titleError && (
                      <div className="sg-kv-row" style={{ color: "var(--danger)" }}>
                        <span>错误</span>
                        <span>{titleError}</span>
                      </div>
                    )}
                    <div className="sg-kv-row">
                      <span>根目录路径</span>
                      <code>{workspace.root}</code>
                    </div>
                    <div className="sg-kv-row">
                      <span>配置文件路径</span>
                      <code>{workspace.root}/.llm-wiki/config.json</code>
                    </div>
                  </div>
                </section>

                {/* 1.2 Index Directory Settings */}
                <section className="sg-section">
                  <div className="sg-section-head">
                    <span className="sg-section-icon">
                      <Icon name="folder" />
                    </span>
                    <div>
                      <strong>索引目录</strong>
                      <p>
                        相对于工作区根目录的扫描路径，修改后需重新索引生效。默认为{" "}
                        <code>{defaultDirs.join(" / ") || "wiki / docs"}</code>。
                      </p>
                    </div>
                    {includeDirs.length !== defaultDirs.length ||
                    !defaultDirs.every((d) => includeDirs.includes(d)) ? (
                      <button
                        type="button"
                        className="sg-button"
                        disabled={dirSaving}
                        onClick={() => void saveIncludeDirs(defaultDirs)}
                      >
                        恢复默认
                      </button>
                    ) : null}
                  </div>
                  <div className="sg-dirs">
                    {includeDirs.map((dir) => (
                      <span key={dir} className="sg-dir-chip">
                        <code>{dir}</code>
                        <button
                          type="button"
                          aria-label={`移除 ${dir}`}
                          disabled={dirSaving || includeDirs.length <= 1}
                          onClick={() => void saveIncludeDirs(includeDirs.filter((v) => v !== dir))}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <form
                    className="sg-dir-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addDir();
                    }}
                  >
                    <input
                      value={dirInput}
                      placeholder="例如 docs 或 packages/kb/src"
                      disabled={dirSaving}
                      onChange={(event) => {
                        setDirInput(event.target.value);
                        setDirError(null);
                      }}
                    />
                    <button
                      type="submit"
                      className="sg-button"
                      disabled={dirSaving || !dirInput.trim()}
                    >
                      添加目录
                    </button>
                  </form>
                  {dirError && <p className="sg-error">错误:{dirError}</p>}
                  <p className="sg-hint">
                    至少保留一个目录；路径必须位于工作区内，不支持 <code>..</code>{" "}
                    或绝对路径。排除项将在下方规则中生效。
                  </p>
                </section>

                {/* 1.3 Ignore / Exclude Rules */}
                <section className="sg-section">
                  <div className="sg-section-head">
                    <span className="sg-section-icon">
                      <Icon name="ban" />
                    </span>
                    <div>
                      <strong>忽略文档与目录</strong>
                      <p>
                        匹配的文件或目录将不会被扫描和索引，例如 <code>AGENTS.md</code> 或{" "}
                        <code>*.log</code>。修改后重新索引生效。
                      </p>
                    </div>
                    {excludeRules.length !== defaultExclude.length ||
                    !defaultExclude.every((d) => excludeRules.includes(d)) ? (
                      <button
                        type="button"
                        className="sg-button"
                        disabled={excludeSaving}
                        onClick={() => void saveExcludeRules(defaultExclude)}
                      >
                        恢复默认
                      </button>
                    ) : null}
                  </div>
                  <div className="sg-dirs">
                    {excludeRules.map((rule) => (
                      <span key={rule} className="sg-dir-chip">
                        <code>{rule}</code>
                        <button
                          type="button"
                          aria-label={`移除规则 ${rule}`}
                          disabled={excludeSaving}
                          onClick={() =>
                            void saveExcludeRules(excludeRules.filter((v) => v !== rule))
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <form
                    className="sg-dir-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      addExcludeRule();
                    }}
                  >
                    <input
                      value={excludeInput}
                      placeholder="例如 AGENTS.md 或 *.tmp 或 docs/drafts"
                      disabled={excludeSaving}
                      onChange={(event) => {
                        setExcludeInput(event.target.value);
                        setExcludeError(null);
                      }}
                    />
                    <button
                      type="submit"
                      className="sg-button"
                      disabled={excludeSaving || !excludeInput.trim()}
                    >
                      添加忽略
                    </button>
                  </form>
                  {excludeError && <p className="sg-error">错误:{excludeError}</p>}
                  <p className="sg-hint">
                    支持精确文件名（如 <code>AGENTS.md</code>）、通配符扩展名（如 <code>*.tmp</code>
                    ）或子目录名。修改后点击重新索引即刻生效。
                  </p>
                </section>

                {/* 1.4 Indexing & Database for this workspace */}
                <section className="sg-section">
                  <div className="sg-section-head">
                    <span className="sg-section-icon">
                      <Icon name="index" />
                    </span>
                    <div>
                      <strong>知识库索引与存储</strong>
                      <p>扫描索引目录构建工作区专属 FTS5 全文索引，支持增量更新与自动排除规则。</p>
                    </div>
                    <button
                      type="button"
                      className="sg-button primary"
                      disabled={indexing}
                      onClick={() => void runIndex()}
                    >
                      {indexing ? "索引中…" : "重新索引"}
                    </button>
                  </div>
                  <div className="sg-kv">
                    <div className="sg-kv-row">
                      <span>索引状态</span>
                      <strong>{indexed ? "已就绪" : "未索引"}</strong>
                    </div>
                    <div className="sg-kv-row">
                      <span>文档 / 切片</span>
                      <strong>
                        {indexed
                          ? `${kbStats?.files ?? 0} 文档 · ${kbStats?.chunks ?? 0} chunks`
                          : "—"}
                      </strong>
                    </div>
                    <div className="sg-kv-row">
                      <span>FTS 记录数</span>
                      <strong>{indexed ? String(kbStats?.ftsRecords ?? 0) : "—"}</strong>
                    </div>
                    <div className="sg-kv-row">
                      <span>向量检索</span>
                      <strong>
                        {kbStats?.vectorEnabled
                          ? `已启用 · ${kbStats.vectorRecords} 条`
                          : "未启用 (FTS-only)"}
                      </strong>
                    </div>
                    <div className="sg-kv-row">
                      <span>工作区数据库</span>
                      <code>{workspace.root}/.llm-wiki/knowledge.db</code>
                    </div>
                  </div>
                  {indexError && <p className="sg-error">错误:{indexError}</p>}
                  {lastIndexResult && !indexing && (
                    <p className="sg-hint">
                      上次结果:扫描 {lastIndexResult.scanned} · 新增 {lastIndexResult.added} · 更新{" "}
                      {lastIndexResult.updated} · 跳过 {lastIndexResult.skipped} · 删除{" "}
                      {lastIndexResult.deleted} · 切片 {lastIndexResult.chunks}
                    </p>
                  )}
                </section>

                {/* 1.5 Write Safety */}
                <section className="sg-section">
                  <div className="sg-section-head">
                    <span className="sg-section-icon">
                      <Icon name="shield" />
                    </span>
                    <div>
                      <strong>工作区写入安全</strong>
                      <p>所有文档变更均受控执行，严格防止意外覆盖或数据丢失。</p>
                    </div>
                  </div>
                  <div className="sg-tags">
                    <span>草稿确认机制</span>
                    <span>expectedHash 校验</span>
                    <span>原子写入与事务回滚</span>
                    <span>自动安全备份</span>
                  </div>
                </section>
              </>
            )}
          </>
        )}

        {/* ----------------- TAB 2: GLOBAL APP SETTINGS ----------------- */}
        {activeTab === "app" && (
          <>
            <p className="sg-tab-lead">
              应用全局运行时环境、AI Agent 引擎管理与系统偏好，对所有工作区生效。
            </p>

            {/* 2.1 AI Agent Runtime (Pi) */}
            <section className="sg-section">
              <div className="sg-section-head">
                <span className="sg-section-icon">
                  <Icon name="spark" />
                </span>
                <div>
                  <strong>AI Agent 运行时 (Pi)</strong>
                  <p>原生接入 Pi CLI 运行时引擎，模型与认证由系统全局 Pi CLI 统一管理。</p>
                </div>
                <div className="sg-section-actions">
                  <button
                    type="button"
                    className="sg-button"
                    disabled={piChecking || piUpgrading}
                    onClick={() => void checkPi()}
                  >
                    {piChecking ? "检查中…" : "Pi 检查"}
                  </button>
                  <button
                    type="button"
                    className="sg-button primary"
                    disabled={piChecking || piUpgrading}
                    onClick={() => void upgradePi()}
                  >
                    {piUpgrading ? "升级中…" : "版本升级"}
                  </button>
                </div>
              </div>
              <div className="sg-kv">
                <div className="sg-kv-row">
                  <span>环境状态</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>
                      {piInfo?.message ??
                        (piChecking
                          ? "正在检测 Pi 运行环境…"
                          : "点击右上角「Pi 检查」检测运行环境")}
                    </strong>
                    {piInfo?.hasUpdate && <span className="sg-badge warning">发现新版本</span>}
                    {piInfo?.status === "ready" && !piInfo.hasUpdate && (
                      <span className="sg-badge success">已是最新</span>
                    )}
                  </div>
                </div>
                <div className="sg-kv-row">
                  <span>Node.js / Pi CLI</span>
                  <strong>
                    {piInfo?.nodeVersion ? `Node ${piInfo.nodeVersion}` : "未检测到 Node"} ·{" "}
                    {piInfo?.piVersion ? `Pi CLI ${piInfo.piVersion}` : "未安装全局 Pi CLI"}
                  </strong>
                </div>
                <div className="sg-kv-row">
                  <span>官方最新版本</span>
                  <strong>
                    {piInfo?.latestVersion
                      ? `npm @earendil-works/pi-coding-agent @ ${piInfo.latestVersion}`
                      : "—"}
                  </strong>
                </div>
                <div className="sg-kv-row">
                  <span>运行协议</span>
                  <strong>Pi Agent Protocol v2 · 单进程 stdio</strong>
                </div>
                <div className="sg-kv-row">
                  <span>凭据与认证</span>
                  <code>在终端使用 pi auth login 或 pi settings 配置全局模型与密钥</code>
                </div>
              </div>
              {piError && <p className="sg-error">Pi 检查或升级异常：{piError}</p>}
              {piUpgradeOutput && <pre className="sg-log">{piUpgradeOutput}</pre>}
            </section>

            {/* 2.2 Workspaces Registry */}
            <section className="sg-section">
              <div className="sg-section-head">
                <span className="sg-section-icon">
                  <Icon name="workspace" />
                </span>
                <div>
                  <strong>工作区注册与历史</strong>
                  <p>本地记录的所有已知工作区清单。</p>
                </div>
                <button type="button" className="sg-button" onClick={onOpenWorkspaceMenu}>
                  打开工作区菜单
                </button>
              </div>
              <div className="sg-kv">
                <div className="sg-kv-row">
                  <span>已记录工作区</span>
                  <strong>{knownWorkspaceCount} 个工作区</strong>
                </div>
                <div className="sg-kv-row">
                  <span>存储位置</span>
                  <code>应用本地存储 (localStorage & Native Manifest)</code>
                </div>
              </div>
            </section>

            {/* 2.3 Core Engine Architecture */}
            <section className="sg-section">
              <div className="sg-section-head">
                <span className="sg-section-icon">
                  <Icon name="cpu" />
                </span>
                <div>
                  <strong>核心引擎与技术栈</strong>
                  <p>LLM Wiki 原生多层混合架构与单机存储保障。</p>
                </div>
              </div>
              <div className="sg-kv">
                <div className="sg-kv-row">
                  <span>底层架构</span>
                  <strong>Rust Core · SQLite 3 (WAL 模式) · FTS5 全文搜索</strong>
                </div>
                <div className="sg-kv-row">
                  <span>通信与 IPC</span>
                  <strong>Tauri IPC v2 · 进程隔离与安全沙箱</strong>
                </div>
                <div className="sg-kv-row">
                  <span>数据隐私</span>
                  <strong>全本地索引与向量存储，绝不上传本地代码与知识文档</strong>
                </div>
              </div>
            </section>

            {/* 2.4 About */}
            <section className="sg-section">
              <div className="sg-section-head">
                <span className="sg-section-icon">
                  <Icon name="info" />
                </span>
                <div>
                  <strong>关于 LLM Wiki Desktop</strong>
                  <p>轻量、高响应、AI 原生的本地知识库管理与推理工具。</p>
                </div>
              </div>
              <div className="sg-kv">
                <div className="sg-kv-row">
                  <span>版本号</span>
                  <strong>v0.1.0 (Desktop Edition)</strong>
                </div>
                <div className="sg-kv-row">
                  <span>开源许可</span>
                  <strong>MIT License</strong>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
