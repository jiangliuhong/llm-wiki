import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauriRuntime } from "./RelationsView";
import { PI_PROVIDERS, type PiModelOption } from "./piModels";

export interface SettingsWorkspace {
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
  defaults: string[];
}

// Zhipu GLM Coding Plan presets: Anthropic-compatible API with separate
// China (bigmodel.cn) and international (z.ai) endpoints. They map onto the
// anthropic provider plus a baseUrl override.
const ZHIPU_PRESETS: Record<string, { label: string; baseUrl: string; envVar: string; models: PiModelOption[] }> = {
  "zhipu-cn": {
    label: "智谱 Coding Plan（中国 · bigmodel.cn）",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    envVar: "ZHIPU_API_KEY",
    models: [
      { id: "glm-5.3", name: "GLM-5.3", reasoning: true },
      { id: "glm-5.2", name: "GLM-5.2", reasoning: true },
      { id: "glm-5-turbo", name: "GLM-5-Turbo", reasoning: true },
      { id: "glm-4.7", name: "GLM-4.7", reasoning: true },
    ],
  },
  "zhipu-global": {
    label: "智谱 Coding Plan（国际 · z.ai）",
    baseUrl: "https://open.z.ai/api/anthropic",
    envVar: "Z_AI_API_KEY",
    models: [
      { id: "glm-5.3", name: "GLM-5.3", reasoning: true },
      { id: "glm-5.2", name: "GLM-5.2", reasoning: true },
      { id: "glm-5-turbo", name: "GLM-5-Turbo", reasoning: true },
      { id: "glm-4.7", name: "GLM-4.7", reasoning: true },
    ],
  },
};

export interface SettingsViewProps {
  workspace: SettingsWorkspace | null;
  kbStats: SettingsKbStats | null;
  knownWorkspaceCount: number;
  onOpenWorkspaceMenu: () => void;
  onIndexed: () => void;
}

// --- Inline icons (same 24×24 stroke style as the shared Icon component) ----

const ICONS: Record<string, React.ReactNode> = {
  workspace: (<><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11.5Z" /></>),
  folder: (<><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z" /><path d="M3.5 11.5h17" /></>),
  index: (<><ellipse cx="12" cy="6" rx="7.5" ry="3" /><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" /></>),
  shield: (<><path d="M12 3l7.5 3v5.2c0 4.6-3.2 8.2-7.5 9.8-4.3-1.6-7.5-5.2-7.5-9.8V6L12 3Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>),
  spark: (<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></>),
};

function Icon({ name, size = 16, strokeWidth = 1.7 }: { name: string; size?: number; strokeWidth?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] ?? null}
    </svg>
  );
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export default function SettingsView({ workspace, kbStats, knownWorkspaceCount, onOpenWorkspaceMenu, onIndexed }: SettingsViewProps): React.ReactElement {
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [lastIndexResult, setLastIndexResult] = useState<IndexStats | null>(null);

  const [includeDirs, setIncludeDirs] = useState<string[]>([]);
  const [defaultDirs, setDefaultDirs] = useState<string[]>([]);
  const [dirInput, setDirInput] = useState("");
  const [dirSaving, setDirSaving] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelThinkingLevel, setModelThinkingLevel] = useState("medium");
  const [customModel, setCustomModel] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [ModelError, setModelError] = useState<string | null>(null);

  /** Zhipu preset key when the configured baseUrl matches one of their endpoints. */
  const zhipuPresetKey = Object.keys(ZHIPU_PRESETS).find((key) => ZHIPU_PRESETS[key]!.baseUrl === modelBaseUrl);
  const activeProvider = PI_PROVIDERS.find((p) => p.value === modelProvider);
  const providerOptions = modelProvider && !activeProvider
    ? [...PI_PROVIDERS, { value: modelProvider, label: `${modelProvider} (自定义)`, envVar: "", models: [] }]
    : PI_PROVIDERS;
  const modelOptions = zhipuPresetKey ? ZHIPU_PRESETS[zhipuPresetKey]!.models : (activeProvider?.models ?? []);
  const selectedModel = modelOptions.find((m) => m.id === modelId);
  const envVarHint = zhipuPresetKey ? ZHIPU_PRESETS[zhipuPresetKey]!.envVar : activeProvider?.envVar;

  // Load the Pi model config whenever the workspace changes.
  useEffect(() => {
    setModelError(null);
    setCustomModel(false);
    if (!workspace || !inTauriRuntime()) {
      setModelProvider(""); setModelId(""); setModelApiKey(""); setModelBaseUrl(""); setModelThinkingLevel("medium");
      return;
    }
    let cancelled = false;
    void invoke<{ provider: string; id: string; apiKey?: string; baseUrl?: string; thinkingLevel?: string } | null>("pi_config_get", { root: workspace.root })
      .then((model) => {
        if (cancelled) return;
        const provider = model?.provider ?? "";
        const id = model?.id ?? "";
        const baseUrl = model?.baseUrl ?? "";
        setModelProvider(provider);
        setModelId(id);
        setModelApiKey(model?.apiKey ?? "");
        setModelBaseUrl(baseUrl);
        setModelThinkingLevel(model?.thinkingLevel ?? "medium");
        const presetMatched = Object.values(ZHIPU_PRESETS).some((preset) => preset.baseUrl === baseUrl);
        setCustomModel(id !== "" && !presetMatched && !PI_PROVIDERS.some((p) => p.value === provider && p.models.some((m) => m.id === id)));
      })
      .catch((reason: unknown) => { if (!cancelled) setModelError(String(reason)); });
    return () => { cancelled = true; };
  }, [workspace]);

  const onProviderChange = (value: string): void => {
    setModelError(null);
    const zhipu = ZHIPU_PRESETS[value];
    if (zhipu) {
      setModelProvider("anthropic");
      setModelBaseUrl(zhipu.baseUrl);
      if (!zhipu.models.some((m) => m.id === modelId)) {
        setModelId("");
        setCustomModel(false);
      }
      return;
    }
    setModelProvider(value);
    setModelBaseUrl("");
    const models = PI_PROVIDERS.find((p) => p.value === value)?.models ?? [];
    if (!models.some((m) => m.id === modelId)) {
      setModelId("");
      setCustomModel(false);
    }
  };

  const saveModel = async (): Promise<void> => {
    if (!workspace || modelSaving) return;
    setModelSaving(true);
    setModelError(null);
    try {
      await invoke("pi_config_set", {
        root: workspace.root,
        model: {
          provider: modelProvider.trim(),
          id: modelId.trim(),
          apiKey: modelApiKey.trim() || undefined,
          baseUrl: modelBaseUrl.trim() || undefined,
          thinkingLevel: modelThinkingLevel,
        },
      });
    } catch (reason: unknown) {
      setModelError(String(reason));
    } finally {
      setModelSaving(false);
    }
  };

  // Load the workspace's index-directory config whenever the workspace changes.
  useEffect(() => {
    setDirInput("");
    setDirError(null);
    if (!workspace || !inTauriRuntime()) {
      setIncludeDirs([]);
      setDefaultDirs([]);
      return;
    }
    let cancelled = false;
    void invoke<KbConfigInfo>("kb_config_get", { root: workspace.root })
      .then((config) => { if (!cancelled) { setIncludeDirs(config.include); setDefaultDirs(config.defaults); } })
      .catch((reason: unknown) => { if (!cancelled) setDirError(String(reason)); });
    return () => { cancelled = true; };
  }, [workspace]);

  const saveIncludeDirs = async (next: string[]): Promise<void> => {
    if (!workspace || dirSaving) return;
    setDirSaving(true);
    setDirError(null);
    try {
      const config = await invoke<KbConfigInfo>("kb_config_set_include", { root: workspace.root, include: next });
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
          <p>运行时、工作区与索引的管理中心。</p>
        </header>

        <section className="sg-section">
          <div className="sg-section-head">
            <span className="sg-section-icon"><Icon name="workspace" /></span>
            <div>
              <strong>工作区</strong>
              <p>当前连接的本地知识库工作区。</p>
            </div>
            <button type="button" className="sg-button" onClick={onOpenWorkspaceMenu}>切换工作区</button>
          </div>
          <div className="sg-kv">
            <div className="sg-kv-row">
              <span>名称</span>
              <strong>{workspace?.title ?? "未选择"}</strong>
            </div>
            <div className="sg-kv-row">
              <span>根目录</span>
              <code>{workspace?.root ?? "选择一个本地工作区开始使用。"}</code>
            </div>
            <div className="sg-kv-row">
              <span>已知工作区</span>
              <strong>{knownWorkspaceCount} 个</strong>
            </div>
          </div>
        </section>

        <section className="sg-section">
          <div className="sg-section-head">
            <span className="sg-section-icon"><Icon name="folder" /></span>
            <div>
              <strong>索引目录</strong>
              <p>相对于工作区根目录的扫描路径,修改后需重新索引生效。默认为 <code>{defaultDirs.join(" / ") || "wiki"}</code>。</p>
            </div>
            {includeDirs.length > defaultDirs.length || !defaultDirs.every((d) => includeDirs.includes(d)) ? (
              <button type="button" className="sg-button" disabled={!workspace || dirSaving} onClick={() => void saveIncludeDirs(defaultDirs)}>恢复默认</button>
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
            onSubmit={(event) => { event.preventDefault(); addDir(); }}
          >
            <input
              value={dirInput}
              placeholder="例如 docs 或 packages/kb/src"
              disabled={!workspace || dirSaving}
              onChange={(event) => { setDirInput(event.target.value); setDirError(null); }}
            />
            <button type="submit" className="sg-button" disabled={!workspace || dirSaving || !dirInput.trim()}>添加目录</button>
          </form>
          {dirError && <p className="sg-error">错误:{dirError}</p>}
          <p className="sg-hint">至少保留一个目录;路径必须位于工作区内,不支持 <code>..</code> 或绝对路径。node_modules、.git 等目录始终被排除。</p>
        </section>

        <section className="sg-section">
          <div className="sg-section-head">
            <span className="sg-section-icon"><Icon name="spark" /></span>
            <div>
              <strong>AI 模型 (Pi)</strong>
              <p>配置后聊天页使用 Pi 生成式问答;未配置时回退为 FTS5 关键词检索。API Key 也可留空,改用环境变量(如 ANTHROPIC_API_KEY)。</p>
            </div>
            <button
              type="button"
              className="sg-button primary"
              disabled={!workspace || modelSaving || !modelProvider.trim() || !modelId.trim()}
              onClick={() => void saveModel()}
            >
              {modelSaving ? "保存中…" : "保存模型配置"}
            </button>
          </div>
          <div className="sg-model-form">
            <label className="sg-field">
              <span>Provider</span>
              <select
                value={zhipuPresetKey ?? modelProvider}
                disabled={!workspace}
                onChange={(event) => onProviderChange(event.target.value)}
              >
                <option value="" disabled>选择 Provider…</option>
                {Object.entries(ZHIPU_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>{preset.label}</option>
                ))}
                {providerOptions.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </label>
            <label className="sg-field">
              <span>模型</span>
              {customModel ? (
                <input
                  className="mono"
                  value={modelId}
                  placeholder="输入模型 ID,例如 glm-4.7"
                  autoFocus
                  disabled={!workspace}
                  onChange={(event) => { setModelId(event.target.value); setModelError(null); }}
                  onBlur={() => { if (modelOptions.some((m) => m.id === modelId.trim())) setCustomModel(false); }}
                />
              ) : (
                <select
                  value={modelOptions.some((m) => m.id === modelId) ? modelId : ""}
                  disabled={!workspace}
                  onChange={(event) => {
                    setModelError(null);
                    if (event.target.value === "__custom") { setCustomModel(true); setModelId(""); }
                    else setModelId(event.target.value);
                  }}
                >
                  <option value="" disabled>{modelOptions.length > 0 ? "选择模型…" : "先选择 Provider"}</option>
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                  <option value="__custom">自定义模型 ID…</option>
                </select>
              )}
              {selectedModel && (
                <em className="sg-model-meta">
                  {selectedModel.id}
                  {selectedModel.contextWindow ? ` · ${formatContext(selectedModel.contextWindow)} 上下文` : ""}
                  {selectedModel.reasoning ? " · 支持推理" : ""}
                </em>
              )}
            </label>
            <label className="sg-field">
              <span>思考级别</span>
              <select
                value={modelThinkingLevel}
                disabled={!workspace}
                onChange={(event) => { setModelThinkingLevel(event.target.value); setModelError(null); }}
              >
                <option value="off">关闭</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
              <em className="sg-model-meta">仅对支持推理的模型生效;新建会话后应用</em>
            </label>
            <label className="sg-field sg-field-wide">
              <span>API Key(可选)</span>
              <span className="sg-key-row">
                <input
                  className="mono"
                  type={showApiKey ? "text" : "password"}
                  value={modelApiKey}
                  placeholder={envVarHint ? `留空则使用环境变量 ${envVarHint}` : "留空则使用环境变量"}
                  disabled={!workspace}
                  onChange={(event) => { setModelApiKey(event.target.value); setModelError(null); }}
                />
                <button
                  type="button"
                  aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                  disabled={!workspace}
                  onClick={() => setShowApiKey((v) => !v)}
                >
                  {showApiKey ? "隐藏" : "显示"}
                </button>
              </span>
            </label>
            {modelBaseUrl && (
              <div className="sg-field sg-field-wide">
                <span>API 端点</span>
                <code className="sg-endpoint">{modelBaseUrl}</code>
              </div>
            )}
          </div>
          {ModelError && <p className="sg-error">错误:{ModelError}</p>}
          <p className="sg-hint">模型配置保存在工作区 <code>.llm-wiki/config.json</code>,不会上传到任何服务器。</p>
        </section>

        <section className="sg-section">
          <div className="sg-section-head">
            <span className="sg-section-icon"><Icon name="index" /></span>
            <div>
              <strong>索引与存储</strong>
              <p>扫描索引目录构建 FTS5 全文索引,支持增量更新。</p>
            </div>
            <button
              type="button"
              className="sg-button primary"
              disabled={!workspace || indexing}
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
              <strong>{indexed ? `${kbStats?.files ?? 0} 文档 · ${kbStats?.chunks ?? 0} chunks` : "—"}</strong>
            </div>
            <div className="sg-kv-row">
              <span>FTS 记录</span>
              <strong>{indexed ? String(kbStats?.ftsRecords ?? 0) : "—"}</strong>
            </div>
            <div className="sg-kv-row">
              <span>向量检索</span>
              <strong>{kbStats?.vectorEnabled ? `已启用 · ${kbStats.vectorRecords} 条` : "未启用(FTS-only)"}</strong>
            </div>
            <div className="sg-kv-row">
              <span>存储引擎</span>
              <strong>Rust Core · SQLite WAL · FTS5</strong>
            </div>
          </div>
          {indexError && <p className="sg-error">错误:{indexError}</p>}
          {lastIndexResult && !indexing && (
            <p className="sg-hint">上次结果:扫描 {lastIndexResult.scanned} · 新增 {lastIndexResult.added} · 更新 {lastIndexResult.updated} · 跳过 {lastIndexResult.skipped} · 删除 {lastIndexResult.deleted} · 切片 {lastIndexResult.chunks}</p>
          )}
        </section>

        <section className="sg-section">
          <div className="sg-section-head">
            <span className="sg-section-icon"><Icon name="shield" /></span>
            <div>
              <strong>写入安全</strong>
              <p>所有写入均受控执行,保证工作区内容可追溯、可恢复。</p>
            </div>
          </div>
          <div className="sg-tags">
            <span>草稿确认机制</span>
            <span>expectedHash 校验</span>
            <span>原子写入</span>
            <span>自动备份</span>
          </div>
        </section>
      </div>
    </div>
  );
}
