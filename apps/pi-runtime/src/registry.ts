import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import { HostToolBridge } from "./bridge.js";
import {
  type AgentEventEnvelope,
  type AvailableModelItem,
  createEventEnvelope,
  type ModelConfig,
  type SessionNewRequest,
  type SessionSnapshot,
  type SessionSummary,
} from "./protocol.js";
import { AgentSessionWrapper, SessionHostError } from "./wrapper.js";

const ENV_API_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
};

export function envApiKeyFor(model: ModelConfig): string | undefined {
  for (const key of ENV_API_KEYS[model.provider] ?? []) {
    if (process.env[key]) return process.env[key];
  }
  if (model.provider === "anthropic" && model.baseUrl) {
    if (model.baseUrl.includes("bigmodel.cn") && process.env.ZHIPU_API_KEY) {
      return process.env.ZHIPU_API_KEY;
    }
    if (model.baseUrl.includes("z.ai") && (process.env.Z_AI_API_KEY ?? process.env.ZAI_API_KEY)) {
      return process.env.Z_AI_API_KEY ?? process.env.ZAI_API_KEY;
    }
  }
  return undefined;
}

export interface PiGlobalSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}

export function getPiGlobalSettings(): PiGlobalSettings {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, "utf8")) as PiGlobalSettings;
    }
  } catch {
    // ignore
  }
  return {};
}

export function getPiGlobalDefaultModel(): ModelConfig {
  const settings = getPiGlobalSettings();
  return {
    provider: settings.defaultProvider || "anthropic",
    id: settings.defaultModel || "claude-sonnet-4-5",
    thinkingLevel:
      (settings.defaultThinkingLevel as "off" | "minimal" | "low" | "medium" | "high") || "medium",
  };
}

export async function listAvailablePiModels(): Promise<AvailableModelItem[]> {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const globalModelsPath = existsSync(join(getAgentDir(), "models.json"))
      ? join(getAgentDir(), "models.json")
      : existsSync(join(getAgentDir(), "models-store.json"))
        ? join(getAgentDir(), "models-store.json")
        : null;
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: globalModelsPath,
      refreshOnCreate: false,
    });
    const avail = await runtime.getAvailable();
    const settings = getPiGlobalSettings();
    const defaultProvider = settings.defaultProvider;
    const defaultModel = settings.defaultModel;

    return avail.map(
      (m: {
        provider: string;
        id: string;
        name?: string;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
      }) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        reasoning: Boolean(m.reasoning),
        isDefault: m.provider === defaultProvider && m.id === defaultModel,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      }),
    );
  } catch (err) {
    console.error("[pi-runtime] failed to list available models:", err);
    return [];
  }
}

export function hasCredential(model: ModelConfig): boolean {
  if (model.apiKey && model.apiKey.trim().length > 0) return true;
  if (envApiKeyFor(model)) return true;
  try {
    const stored = readStoredCredential(model.provider);
    if (stored) return true;
  } catch {
    // ignore
  }
  return false;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeThinkingLevel(
  level: string | undefined,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return level && THINKING_LEVELS.has(level)
    ? (level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : "medium";
}

interface PersistedMeta {
  title: string;
  createdAt: string;
  updatedAt?: string;
  model: ModelConfig;
  workspaceId: string;
  workspaceRoot: string;
  file: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, AgentSessionWrapper>();
  private readonly loadingPromises = new Map<string, Promise<AgentSessionWrapper>>();
  private readonly agentDir = mkdtempSync(join(tmpdir(), "llm-wiki-pi-agent-"));
  private readonly knownRoots = new Set<string>();

  constructor(
    private readonly bridge: HostToolBridge,
    private readonly onEventEnvelope: (envelope: AgentEventEnvelope) => void = () => {},
  ) {}

  private sessionDir(workspaceRoot: string): string {
    return join(workspaceRoot, ".llm-wiki", "pi-sessions");
  }

  private metaFile(workspaceRoot: string): string {
    return join(this.sessionDir(workspaceRoot), "index.json");
  }

  private readMetaIndex(workspaceRoot: string): Record<string, PersistedMeta> {
    try {
      return JSON.parse(readFileSync(this.metaFile(workspaceRoot), "utf8")) as Record<
        string,
        PersistedMeta
      >;
    } catch {
      return {};
    }
  }

  private writeMetaIndex(workspaceRoot: string, index: Record<string, PersistedMeta>): void {
    const dir = this.sessionDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.metaFile(workspaceRoot), JSON.stringify(index, null, 2));
  }

  private findSessionFile(workspaceRoot: string, sessionId: string): string | undefined {
    const dir = this.sessionDir(workspaceRoot);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    const meta = this.readMetaIndex(workspaceRoot)[sessionId];
    if (meta?.file && existsSync(join(dir, meta.file))) {
      return join(dir, meta.file);
    }
    const match = entries.find(
      (name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`),
    );
    return match ? join(dir, match) : undefined;
  }

  private persistMeta(wrapper: AgentSessionWrapper): void {
    const { apiKey: _apiKey, ...safeModel } = wrapper.model;
    const file = wrapper.session.sessionManager.getSessionFile();
    const index = this.readMetaIndex(wrapper.workspaceRoot);
    index[wrapper.sessionId] = {
      title: wrapper.title,
      createdAt: wrapper.createdAt,
      updatedAt: wrapper.updatedAt,
      model: safeModel,
      workspaceId: wrapper.workspaceId,
      workspaceRoot: wrapper.workspaceRoot,
      file: file ? basename(file) : "",
    };
    this.writeMetaIndex(wrapper.workspaceRoot, index);
  }

  private attachEvents(wrapper: AgentSessionWrapper): void {
    wrapper.subscribe((event) => {
      this.onEventEnvelope(createEventEnvelope(wrapper.sessionId, wrapper.workspaceId, event));
    });
  }

  async newSession(request: SessionNewRequest): Promise<SessionSummary> {
    this.knownRoots.add(request.workspaceRoot);

    let model: ModelConfig = { ...request.model };
    if (!model.provider || !model.id) {
      const def = getPiGlobalDefaultModel();
      model = {
        ...def,
        ...model,
        provider: model.provider || def.provider,
        id: model.id || def.id,
      };
    }

    if (!hasCredential(model)) {
      throw new SessionHostError(
        "PI_MODEL_NOT_CONFIGURED",
        `Provider ${model.provider} 未找到 API Key 或登录态。请在终端执行 'pi auth login'，或在设置页配置 API Key。`,
      );
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionDir = this.sessionDir(request.workspaceRoot);
    const manager = SessionManager.create(request.workspaceRoot, sessionDir, { id: sessionId });
    const title = request.title ?? "新对话";
    manager.appendSessionInfo(title);

    const wrapper = await this.instantiateSession({
      sessionId,
      title,
      workspaceId: request.workspaceId,
      workspaceRoot: request.workspaceRoot,
      model,
      manager,
      systemPrompt: request.systemPrompt,
    });

    this.sessions.set(sessionId, wrapper);
    this.persistMeta(wrapper);
    this.attachEvents(wrapper);

    const summary = wrapper.getSummary(true);
    this.onEventEnvelope(
      createEventEnvelope(sessionId, wrapper.workspaceId, {
        type: "session_created",
        session: summary,
      }),
    );

    return summary;
  }

  async getSession(
    sessionId: string,
    workspaceRoot?: string,
    model?: ModelConfig,
  ): Promise<AgentSessionWrapper> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.isAlive()) return existing;

    const inFlight = this.loadingPromises.get(sessionId);
    if (inFlight) return inFlight;

    const loadPromise = this.restoreSession(sessionId, workspaceRoot, model);
    this.loadingPromises.set(sessionId, loadPromise);

    try {
      const wrapper = await loadPromise;
      this.sessions.set(sessionId, wrapper);
      this.persistMeta(wrapper);
      this.attachEvents(wrapper);

      this.onEventEnvelope(
        createEventEnvelope(sessionId, wrapper.workspaceId, {
          type: "session_restored",
          session: wrapper.getSummary(false),
        }),
      );
      return wrapper;
    } finally {
      this.loadingPromises.delete(sessionId);
    }
  }

  private async restoreSession(
    sessionId: string,
    preferredRoot?: string,
    promptModel?: ModelConfig,
  ): Promise<AgentSessionWrapper> {
    const rootsToScan = new Set<string>();
    if (preferredRoot) rootsToScan.add(preferredRoot);
    for (const r of this.knownRoots) rootsToScan.add(r);
    rootsToScan.add(process.cwd());

    for (const root of rootsToScan) {
      const file = this.findSessionFile(root, sessionId);
      const meta = this.readMetaIndex(root)[sessionId];
      if (!file && !meta) continue;

      const baseModel = meta?.model ?? promptModel ?? getPiGlobalDefaultModel();
      const effectiveModel: ModelConfig = {
        ...baseModel,
        ...(promptModel ?? {}),
      };

      if (!hasCredential(effectiveModel)) {
        throw new SessionHostError(
          "PI_MODEL_NOT_CONFIGURED",
          `Session ${sessionId} cannot be restored: no API key for provider ${effectiveModel.provider}.`,
        );
      }

      const manager = file
        ? SessionManager.open(file, this.sessionDir(root))
        : SessionManager.create(root, this.sessionDir(root), { id: sessionId });

      return this.instantiateSession({
        sessionId,
        title: meta?.title ?? "恢复对话",
        workspaceId: meta?.workspaceId ?? root,
        workspaceRoot: root,
        model: effectiveModel,
        manager,
        createdAt: meta?.createdAt,
        updatedAt: meta?.updatedAt,
      });
    }

    throw new SessionHostError("PI_SESSION_NOT_FOUND", `Session ${sessionId} does not exist.`);
  }

  private async instantiateSession(options: {
    sessionId: string;
    title: string;
    workspaceId: string;
    workspaceRoot: string;
    model: ModelConfig;
    manager: SessionManager;
    systemPrompt?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<AgentSessionWrapper> {
    const { workspaceId, workspaceRoot, sessionId, model } = options;

    const globalAgentDir = getAgentDir();
    const globalAuthPath = join(globalAgentDir, "auth.json");
    const authPath = existsSync(globalAuthPath) ? globalAuthPath : join(this.agentDir, "auth.json");
    const globalModelsPath = existsSync(join(globalAgentDir, "models.json"))
      ? join(globalAgentDir, "models.json")
      : existsSync(join(globalAgentDir, "models-store.json"))
        ? join(globalAgentDir, "models-store.json")
        : null;

    const modelRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: globalModelsPath,
      refreshOnCreate: false,
    });

    const apiKey = model.apiKey ?? envApiKeyFor(model);
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(
        model.provider as Parameters<typeof modelRuntime.setRuntimeApiKey>[0],
        apiKey,
      );
    }

    const matchedModel: Model<any> | undefined =
      modelRuntime.getModel(model.provider, model.id) ??
      (getModel(model.provider as never, model.id) as Model<any> | undefined);

    let sdkModel =
      matchedModel && model.baseUrl ? { ...matchedModel, baseUrl: model.baseUrl } : matchedModel;
    if (!sdkModel && model.baseUrl) {
      const template: Model<any> | undefined =
        modelRuntime.getModel(model.provider, "claude-sonnet-4-5") ??
        (getModel(model.provider as never, "claude-sonnet-4-5") as Model<any> | undefined);
      if (template) {
        sdkModel = {
          ...template,
          id: model.id,
          name: model.id,
          baseUrl: model.baseUrl,
        } as Model<any>;
      }
    }

    if (!sdkModel) {
      throw new SessionHostError(
        "PI_MODEL_NOT_CONFIGURED",
        `Unknown model ${model.provider}/${model.id}.`,
      );
    }

    const DEFAULT_SYSTEM_PROMPT = `You are the LLM Wiki Assistant, an intelligent assistant embedded in the LLM Wiki desktop application.
Your role is to help the user explore, understand, organize, and maintain their local Markdown knowledge base.

You have access to tools to interact with the workspace knowledge base:
- Use 'document_search', 'document_read', 'document_list', 'document_relations', etc. to search and retrieve existing knowledge.
- When the user asks you to write, create, draft, summarize into, or update a knowledge base document:
  1. If appropriate, first search or read existing documents to avoid duplication and link related concepts.
  2. Call 'document_draft_create' with:
     - 'targetPath': workspace-relative path starting with 'wiki/' (e.g. 'wiki/overview.md' or 'wiki/concepts/ai.md'). Use clean lowercase kebab-case paths with .md extension.
     - 'generatedContent': well-structured, comprehensive Markdown with headers, bullet points, code snippets, and wikilinks/markdown links where appropriate.
     - 'operationType': 'create' (for new documents), 'update' (to replace an existing document), or 'append'.
     - 'sourceCitations': list of source document paths referenced (e.g. ['wiki/welcome.md']).
  3. After calling 'document_draft_create', inform the user that a draft has been created and summarize what was documented. Mention that the user can review and apply the draft directly in the conversation or in the '写入草稿' (Drafts) tab to save it to disk.
- When the user asks you to analyze document relations, find dependencies, or construct the knowledge graph:
  1. Use 'document_list' or 'document_search' to discover relevant documents, and 'document_read' to inspect document contents.
  2. For every discovered architectural dependency, implementation, extension, or semantic reference between documents:
     Call 'relation_proposal_create' with:
     - 'sourcePath': source document path (e.g. 'wiki/order.md')
     - 'targetPath': target document path (e.g. 'wiki/payment.md')
     - 'relationType': one of 'depends_on', 'implements', 'extends', 'references', or 'related_to'
     - 'confidence': number between 0.65 and 1.0 (e.g. 0.9)
     - 'rationale': clear reason explaining why the relation exists
     - 'evidencePath': document where evidence is located
     - 'evidenceStartLine': start line number of evidence
     - 'evidenceEndLine': end line number of evidence
     - 'evidenceText': the quote/text snippet from the document supporting this relation
  3. Inform the user of the proposed relations and mention that they can review and approve them in the '关系图谱' (Relations) view.
- Always be helpful, concise, accurate, and format output in clear Markdown.`;

    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    });

    const customTools = this.bridge.buildCustomTools({ sessionId, workspaceId, workspaceRoot });

    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      agentDir: this.agentDir,
      modelRuntime,
      model: sdkModel,
      thinkingLevel: normalizeThinkingLevel(model.thinkingLevel),
      noTools: "builtin",
      tools: customTools.map((t) => t.name),
      customTools,
      resourceLoader,
      sessionManager: options.manager,
      settingsManager: SettingsManager.inMemory(),
    });

    return new AgentSessionWrapper({
      sessionId,
      workspaceId,
      workspaceRoot,
      title: options.title,
      model,
      session,
      createdAt: options.createdAt,
      updatedAt: options.updatedAt,
    });
  }

  async fork(sessionId: string, title?: string, workspaceRoot?: string): Promise<SessionSummary> {
    const source = await this.getSession(sessionId, workspaceRoot);
    const forkedId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionDir = this.sessionDir(source.workspaceRoot);
    const manager = SessionManager.create(source.workspaceRoot, sessionDir, { id: forkedId });
    const forkTitle = title ?? `${source.title} (fork)`;
    manager.appendSessionInfo(forkTitle);

    for (const entry of source.session.sessionManager.getEntries()) {
      if ("message" in entry && entry.message) {
        const role = (entry.message as { role?: string }).role;
        if (role === "user" || role === "assistant") {
          manager.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
        }
      }
    }

    const forked = await this.instantiateSession({
      sessionId: forkedId,
      title: forkTitle,
      workspaceId: source.workspaceId,
      workspaceRoot: source.workspaceRoot,
      model: source.model,
      manager,
    });

    this.sessions.set(forkedId, forked);
    this.persistMeta(forked);
    this.attachEvents(forked);

    const summary = forked.getSummary(true);
    this.onEventEnvelope(
      createEventEnvelope(forkedId, forked.workspaceId, {
        type: "session_created",
        session: summary,
      }),
    );
    return summary;
  }

  async list(workspaceId?: string, workspaceRoot?: string): Promise<SessionSummary[]> {
    const result = new Map<string, SessionSummary>();

    // 1. From active memory sessions
    for (const wrapper of this.sessions.values()) {
      if (workspaceId && wrapper.workspaceId !== workspaceId) continue;
      result.set(wrapper.sessionId, wrapper.getSummary(false));
    }

    // 2. From disk metadata
    const rootsToScan = new Set<string>();
    if (workspaceRoot) rootsToScan.add(workspaceRoot);
    for (const r of this.knownRoots) rootsToScan.add(r);
    rootsToScan.add(process.cwd());

    for (const root of rootsToScan) {
      const index = this.readMetaIndex(root);
      for (const [id, meta] of Object.entries(index)) {
        if (result.has(id)) continue;
        if (workspaceId && meta.workspaceId && meta.workspaceId !== workspaceId) continue;

        result.set(id, {
          sessionId: id,
          workspaceId: meta.workspaceId || root,
          workspaceRoot: meta.workspaceRoot || root,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt || meta.createdAt,
          model: meta.model,
          messageCount: 0,
          active: false,
        });
      }
    }

    return [...result.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSnapshot(
    sessionId: string,
    workspaceRoot?: string,
    model?: ModelConfig,
  ): Promise<SessionSnapshot> {
    const wrapper = await this.getSession(sessionId, workspaceRoot, model);
    return wrapper.getSnapshot();
  }

  async delete(sessionId: string, workspaceRoot?: string): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    let targetRoot = workspaceRoot ?? wrapper?.workspaceRoot;

    if (wrapper) {
      wrapper.dispose();
      this.sessions.delete(sessionId);
    }

    const rootsToScan = new Set<string>();
    if (targetRoot) rootsToScan.add(targetRoot);
    for (const r of this.knownRoots) rootsToScan.add(r);
    rootsToScan.add(process.cwd());

    for (const root of rootsToScan) {
      const file = this.findSessionFile(root, sessionId);
      if (file) rmSync(file, { force: true });

      const index = this.readMetaIndex(root);
      if (index[sessionId]) {
        delete index[sessionId];
        this.writeMetaIndex(root, index);
        targetRoot = root;
        break;
      }
    }

    this.onEventEnvelope(
      createEventEnvelope(sessionId, targetRoot ?? "", { type: "session_deleted", sessionId }),
    );
  }

  async cancel(sessionId: string): Promise<void> {
    const wrapper = this.sessions.get(sessionId);
    if (wrapper) {
      await wrapper.cancel();
    }
  }

  async compact(sessionId: string, workspaceRoot?: string): Promise<void> {
    const wrapper = await this.getSession(sessionId, workspaceRoot);
    await wrapper.compact();
  }

  async listAvailableModels(): Promise<AvailableModelItem[]> {
    return listAvailablePiModels();
  }

  shutdownAll(): void {
    for (const wrapper of this.sessions.values()) {
      try {
        wrapper.dispose();
      } catch {
        // ignore errors
      }
    }
    this.sessions.clear();
    this.loadingPromises.clear();
    this.bridge.dispose();

    try {
      rmSync(this.agentDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  }
}
