import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getModel, type Model } from "@earendil-works/pi-ai/compat";
import type { HostToolContext, HostToolRegistry } from "./host.js";
import type {
  ModelConfig,
  SessionNewRequest,
  SessionSummary,
  StreamEventPayload,
} from "./protocol.js";

export class SessionHostError extends Error {
  constructor(
    readonly code:
      | "PI_MODEL_NOT_CONFIGURED"
      | "PI_SESSION_NOT_FOUND"
      | "PI_SESSION_FAILED"
      | "PI_SESSION_NOT_FOUND_OR_BUSY"
      | "PI_SESSION_CANCELLED"
      | "PI_EMPTY_RESPONSE",
    message: string,
  ) {
    super(message);
  }
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  workspace_get: "Read the llm-wiki workspace manifest (id, title, root).",
  workspace_status: "Report workspace indexing and storage status.",
  document_list: "List documents in the workspace knowledge base.",
  document_search: "Search workspace documents by query and return ranked results.",
  document_read: "Read a workspace document by id.",
  document_read_range: "Read a line range of a workspace document.",
  document_relations: "List relations of a workspace document.",
  document_neighborhood: "List graph neighborhood of a workspace document.",
};

/** Wrap Core host tools as Pi custom tools. Parameters are passed through verbatim. */
export function buildHostCustomTools(
  tools: HostToolRegistry,
  context: HostToolContext,
): ToolDefinition[] {
  return (Object.keys(tools) as (keyof HostToolRegistry)[]).flatMap((name) => {
    const handler = tools[name];
    if (!handler) return [];
    return [
      defineTool({
        name,
        label: name,
        description: TOOL_DESCRIPTIONS[name] ?? `llm-wiki host tool ${name}.`,
        promptSnippet: TOOL_DESCRIPTIONS[name],
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute(_toolCallId, params) {
          const output = await handler(params as Record<string, unknown>, context);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output ?? null) }],
            details: { tool: name },
          };
        },
      }),
    ];
  });
}

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

function hasCredential(model: ModelConfig): boolean {
  if (model.apiKey) return true;
  return Boolean(envApiKeyFor(model));
}

/** Resolves an API key from the environment, including Zhipu Coding Plan vars. */
function envApiKeyFor(model: ModelConfig): string | undefined {
  for (const key of ENV_API_KEYS[model.provider] ?? []) {
    if (process.env[key]) return process.env[key];
  }
  // Zhipu GLM Coding Plan presets route the anthropic API at a custom base
  // URL; accept the Zhipu-specific env vars for those endpoints.
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

interface SessionEntry {
  sessionId: string;
  title: string;
  createdAt: string;
  model: ModelConfig;
  workspaceId: string;
  workspaceRoot: string;
  session: AgentSession;
  promptIds: Set<string>;
}

/** Persisted session metadata (never the API key). */
interface SessionMeta {
  title: string;
  createdAt: string;
  model: ModelConfig;
  workspaceId?: string;
  /** Session JSONL basename inside the session dir (`<timestamp>_<id>.jsonl`). */
  file: string;
}

export type EventSink = (sessionId: string, event: StreamEventPayload) => void;

interface AssistantOutcome {
  text: string;
  thinking: string;
  stopReason?: string;
  errorMessage?: string;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content as { type?: string; text?: string }[]) {
    if (typeof part === "object" && part?.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}

function extractAssistantThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let thinking = "";
  for (const part of content as { type?: string; thinking?: string }[]) {
    if (typeof part === "object" && part?.type === "thinking" && typeof part.thinking === "string") {
      thinking += part.thinking;
    }
  }
  return thinking;
}

/** Outcome of the last assistant message in the given entries. */
export function assistantOutcomeOf(entries: { type: string; message?: unknown }[]): AssistantOutcome {
  let outcome: AssistantOutcome = { text: "", thinking: "" };

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;

    const message = entry.message as {
      role?: string;
      content?: unknown;
      stopReason?: string;
      errorMessage?: string;
    };

    if (message.role !== "assistant") continue;

    outcome = {
      text: extractAssistantText(message.content),
      thinking: extractAssistantThinking(message.content),
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    };
  }

  return outcome;
}

/** Valid thinking levels (subset of the SDK's ThinkingLevel we expose in config). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeThinkingLevel(level: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return level && THINKING_LEVELS.has(level)
    ? (level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : "medium";
}

/**
 * Multi-session host over the embedded Pi SDK agent runtime. Sessions are
 * persisted as JSONL under `<workspaceRoot>/.llm-wiki/pi-sessions/` so they
 * survive sidecar restarts; model credentials come from the request or
 * environment, never from ~/.pi/agent.
 */
export class SessionHost {
  private readonly sessions = new Map<string, SessionEntry>();
  /** Cumulative text streamed per session (feeds the no-delta fallback). */
  private readonly streamedText = new Map<string, string>();
  /** Cumulative thinking streamed per session (feeds the no-delta fallback). */
  private readonly streamedThinking = new Map<string, string>();
  private activeSessionId: string | undefined;
  private readonly agentDir = mkdtempSync(join(tmpdir(), "llm-wiki-pi-"));

  constructor(
    private readonly tools: HostToolRegistry,
    private readonly emit: EventSink = () => {},
    /** Workspace root used to probe persisted sessions on lazy restore. */
    private readonly defaultWorkspaceRoot: string = process.cwd(),
  ) {}

  private sessionDir(workspaceRoot: string): string {
    return join(workspaceRoot, ".llm-wiki", "pi-sessions");
  }

  /**
   * Locate the JSONL backing a session id. The SDK names files
   * `<timestamp>_<sessionId>.jsonl`, so match by suffix as a fallback when
   * the metadata index has no explicit filename.
   */
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

  private metaFile(workspaceRoot: string): string {
    return join(this.sessionDir(workspaceRoot), "index.json");
  }

  private readMetaIndex(workspaceRoot: string): Record<string, SessionMeta> {
    try {
      return JSON.parse(readFileSync(this.metaFile(workspaceRoot), "utf8")) as Record<string, SessionMeta>;
    } catch {
      return {};
    }
  }

  private writeMetaIndex(workspaceRoot: string, index: Record<string, SessionMeta>): void {
    const dir = this.sessionDir(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.metaFile(workspaceRoot), JSON.stringify(index, null, 2));
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((entry) => this.summarize(entry));
  }

  get active(): string | undefined {
    return this.activeSessionId;
  }

  async newSession(request: SessionNewRequest): Promise<SessionSummary> {
    if (!hasCredential(request.model)) {
      throw new SessionHostError(
        "PI_MODEL_NOT_CONFIGURED",
        `No API key for provider ${request.model.provider}. Pass model.apiKey or set one of: ${(ENV_API_KEYS[request.model.provider] ?? ["<provider env var>"]).join(", ")}.`,
      );
    }
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionDir = this.sessionDir(request.workspaceRoot);
    const manager = SessionManager.create(request.workspaceRoot, sessionDir, { id: sessionId });
    // Persist the title (and force the JSONL file to exist) right away, so an
    // empty session is still restorable after a restart.
    manager.appendSessionInfo(request.title ?? "Untitled session");
    const entry = await this.createEntry({
      sessionId,
      title: request.title ?? "Untitled session",
      model: request.model,
      workspaceId: request.workspaceId,
      workspaceRoot: request.workspaceRoot,
      manager,
      systemPrompt: request.systemPrompt,
    });
    this.persistMeta(entry);
    this.activeSessionId = entry.sessionId;
    return this.summarize(entry);
  }

  async switch(sessionId: string): Promise<SessionSummary> {
    const entry = await this.obtain(sessionId);
    this.activeSessionId = entry.sessionId;
    this.emit(entry.sessionId, { type: "session_switched", sessionId: entry.sessionId });
    return this.summarize(entry);
  }

  async fork(sessionId: string, title?: string): Promise<SessionSummary> {
    const source = await this.obtain(sessionId);
    const forkedId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const manager = SessionManager.create(source.workspaceRoot, this.sessionDir(source.workspaceRoot), { id: forkedId });
    manager.appendSessionInfo(title ?? `${source.title} (fork)`);
    for (const entry of source.session.sessionManager.getEntries()) {
      if ("message" in entry && entry.message) {
        const role = (entry.message as { role?: string }).role;
        if (role === "user" || role === "assistant") {
          manager.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
        }
      }
    }
    const forked = await this.createEntry({
      sessionId: forkedId,
      title: title ?? `${source.title} (fork)`,
      model: source.model,
      workspaceId: source.workspaceId,
      workspaceRoot: source.workspaceRoot,
      manager,
    });
    this.persistMeta(forked);
    this.activeSessionId = forked.sessionId;
    return this.summarize(forked);
  }

  async delete(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session.dispose();
      this.sessions.delete(sessionId);
      const file = this.findSessionFile(entry.workspaceRoot, sessionId);
      if (file) rmSync(file, { force: true });
      const index = this.readMetaIndex(entry.workspaceRoot);
      delete index[sessionId];
      this.writeMetaIndex(entry.workspaceRoot, index);
    } else {
      // Not in memory: clean up any persisted leftovers by scanning roots we know.
      for (const root of this.knownWorkspaceRoots()) {
        const file = this.findSessionFile(root, sessionId);
        const index = this.readMetaIndex(root);
        if (file || index[sessionId]) {
          if (file) rmSync(file, { force: true });
          delete index[sessionId];
          this.writeMetaIndex(root, index);
          break;
        }
      }
    }
    if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
  }

  async cancel(sessionId: string): Promise<void> {
    await (await this.obtain(sessionId)).session.abort();
  }

  async compact(sessionId: string): Promise<void> {
    await (await this.obtain(sessionId)).session.compact();
  }

  /** Send a prompt and stream agent events through the EventSink until completion. */
  async prompt(sessionId: string, text: string, requestId: string, model?: ModelConfig): Promise<{ text: string }> {
    const entry = await this.obtain(sessionId, model);
    entry.promptIds.add(requestId);
    const entriesBefore = entry.session.sessionManager.getEntries().length;
    const streamedBefore = this.streamedText.get(sessionId) ?? "";
    const streamedThinkingBefore = this.streamedThinking.get(sessionId) ?? "";
    try {
      await entry.session.prompt(text);
      const newEntries = entry.session.sessionManager.getEntries().slice(entriesBefore);
      const outcome = assistantOutcomeOf(newEntries);

      if (outcome.stopReason === "error") {
        throw new SessionHostError(
          "PI_SESSION_FAILED",
          outcome.errorMessage || "模型请求失败，但 Provider 未返回具体原因。",
        );
      }

      if (outcome.stopReason === "aborted") {
        throw new SessionHostError(
          "PI_SESSION_CANCELLED",
          outcome.errorMessage || "生成已取消。",
        );
      }

      // Some providers return the whole message without text_delta events;
      // deliver the assistant text produced by this prompt as a delta when
      // nothing streamed, so the UI never shows an empty answer. Thinking
      // gets the same treatment (emitted first so the UI phase order holds).
      const streamedNow = this.streamedText.get(sessionId) ?? "";
      const streamed = streamedNow.slice(streamedBefore.length);
      const streamedThinkingNow = this.streamedThinking.get(sessionId) ?? "";
      const streamedThinking = streamedThinkingNow.slice(streamedThinkingBefore.length);
      const answerText = streamed || outcome.text;

      if (!answerText.trim()) {
        throw new SessionHostError(
          "PI_EMPTY_RESPONSE",
          "模型请求成功结束，但没有返回文本内容。",
        );
      }

      if (!streamedThinking && outcome.thinking) {
        this.emit(sessionId, { type: "thinking_delta", delta: outcome.thinking });
      }

      if (!streamed && outcome.text) {
        this.emit(sessionId, { type: "text_delta", delta: outcome.text });
      }

      return { text: answerText };
    } catch (error) {
      this.emit(
        entry.sessionId,
        { type: "error", message: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    } finally {
      entry.promptIds.delete(requestId);
    }
  }

  private require(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new SessionHostError("PI_SESSION_NOT_FOUND", `Session ${sessionId} does not exist.`);
    }
    return entry;
  }

  /**
   * Resolve a session by id, lazily restoring it from disk when the sidecar
   * restarted and lost its in-memory state. Restoration needs the model from
   * the persisted metadata; API keys are re-resolved from the environment.
   */
  private async obtain(sessionId: string, promptModel?: ModelConfig): Promise<SessionEntry> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    for (const root of this.knownWorkspaceRoots()) {
      const file = this.findSessionFile(root, sessionId);
      const meta = this.readMetaIndex(root)[sessionId];
      if (!file && !meta) continue;
      if (!meta?.model) {
        throw new SessionHostError("PI_SESSION_NOT_FOUND", `Session ${sessionId} has no persisted model config.`);
      }
      // Prefer the model config carried by the prompt (it may include an API
      // key that is never persisted); env vars are the fallback.
      const model: ModelConfig = promptModel?.apiKey
        ? { ...meta.model, apiKey: promptModel.apiKey }
        : meta.model;
      if (!hasCredential(model)) {
        throw new SessionHostError(
          "PI_MODEL_NOT_CONFIGURED",
          `Session ${sessionId} cannot be restored: no API key for provider ${model.provider}. Re-enter the API key in settings or set one of: ${(ENV_API_KEYS[model.provider] ?? ["<provider env var>"]).join(", ")}.`,
        );
      }
      // The SDK only writes the JSONL once an assistant message exists; a
      // session that was created but never answered restores as empty.
      const manager = file
        ? SessionManager.open(file, this.sessionDir(root))
        : SessionManager.create(root, this.sessionDir(root), { id: sessionId });
      const entry = await this.createEntry({
        sessionId,
        title: meta.title,
        model,
        workspaceId: meta.workspaceId ?? root,
        workspaceRoot: root,
        manager,
      });
      this.activeSessionId = entry.sessionId;
      return entry;
    }
    throw this.require(sessionId);
  }

  /** Roots whose persisted session dirs should be probed on restore. */
  private knownWorkspaceRoots(): string[] {
    const roots = new Set<string>();
    for (const entry of this.sessions.values()) roots.add(entry.workspaceRoot);
    roots.add(this.defaultWorkspaceRoot);
    roots.add(process.cwd());
    return [...roots];
  }

  private persistMeta(entry: SessionEntry): void {
    const { apiKey: _apiKey, ...model } = entry.model;
    const file = entry.session.sessionManager.getSessionFile();
    const index = this.readMetaIndex(entry.workspaceRoot);
    index[entry.sessionId] = {
      title: entry.title,
      createdAt: entry.createdAt,
      model,
      workspaceId: entry.workspaceId,
      file: file ? basename(file) : "",
    };
    this.writeMetaIndex(entry.workspaceRoot, index);
  }

  private async createEntry(options: {
    sessionId: string;
    title: string;
    model: ModelConfig;
    workspaceId: string;
    workspaceRoot: string;
    manager: SessionManager;
    systemPrompt?: string;
  }): Promise<SessionEntry> {
    const { workspaceId, workspaceRoot } = options;
    const modelRuntime = await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const apiKey = options.model.apiKey ?? envApiKeyFor(options.model);
    if (apiKey) {
      await modelRuntime.setRuntimeApiKey(
        options.model.provider as Parameters<typeof modelRuntime.setRuntimeApiKey>[0],
        apiKey,
      );
    }
    const model: Model<any> | undefined =
      modelRuntime.getModel(options.model.provider, options.model.id) ??
      (getModel(options.model.provider as never, options.model.id) as Model<any> | undefined);
    // Anthropic/OpenAI-compatible endpoint override (e.g. Zhipu GLM Coding Plan
    // routes the anthropic API at open.bigmodel.cn / open.z.ai). Model ids at
    // those endpoints (glm-*) are not in the builtin catalog, so synthesize a
    // model from a same-provider template when a baseUrl override is given.
    let sdkModel = model && options.model.baseUrl ? { ...model, baseUrl: options.model.baseUrl } : model;
    if (!sdkModel && options.model.baseUrl) {
      const template: Model<any> | undefined =
        modelRuntime.getModel(options.model.provider, "claude-sonnet-4-5") ??
        (getModel(options.model.provider as never, "claude-sonnet-4-5") as Model<any> | undefined);
      if (template) {
        sdkModel = {
          ...template,
          id: options.model.id,
          name: options.model.id,
          baseUrl: options.model.baseUrl,
        } as Model<any>;
      }
    }
    if (!sdkModel) {
      throw new SessionHostError(
        "PI_MODEL_NOT_CONFIGURED",
        `Unknown model ${options.model.provider}/${options.model.id}.`,
      );
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt,
    });
    const customTools = buildHostCustomTools(this.tools, { workspaceId, workspaceRoot });
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      agentDir: this.agentDir,
      modelRuntime,
      model: sdkModel,
      thinkingLevel: normalizeThinkingLevel(options.model.thinkingLevel),
      noTools: "builtin",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager: options.manager,
      settingsManager: SettingsManager.inMemory(),
    });
    const sessionId = options.sessionId;
    const entry: SessionEntry = {
      sessionId,
      title: options.title,
      createdAt: new Date().toISOString(),
      model: options.model,
      workspaceId,
      workspaceRoot,
      session,
      promptIds: new Set(),
    };
    session.subscribe((event) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;

        if (update.type === "text_delta") {
          this.streamedText.set(sessionId, (this.streamedText.get(sessionId) ?? "") + update.delta);
          this.emit(sessionId, { type: "text_delta", delta: update.delta });
        } else if (update.type === "thinking_delta") {
          this.streamedThinking.set(
            sessionId,
            (this.streamedThinking.get(sessionId) ?? "") + update.delta,
          );
          this.emit(sessionId, { type: "thinking_delta", delta: update.delta });
        }
      } else if (event.type === "tool_execution_start") {
        this.emit(sessionId, {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        this.emit(sessionId, {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      } else if (event.type === "agent_end") {
        this.emit(sessionId, { type: "agent_end" });
      }
    });
    this.sessions.set(sessionId, entry);
    return entry;
  }

  private summarize(entry: SessionEntry): SessionSummary {
    const { apiKey: _apiKey, ...model } = entry.model;
    return {
      sessionId: entry.sessionId,
      title: entry.title,
      createdAt: entry.createdAt,
      model,
      messageCount: entry.session.sessionManager.getEntries().filter((e) => "message" in e).length,
      active: entry.sessionId === this.activeSessionId,
    };
  }
}
