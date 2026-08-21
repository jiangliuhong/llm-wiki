import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const PROTOCOL_VERSION = "2" as const;

export interface ModelConfig {
  provider: string;
  id: string;
  apiKey?: string;
  baseUrl?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  credentialId?: string;
}

export interface CreateSessionInput {
  workspaceRoot: string;
  title?: string;
  model?: ModelConfig;
}

export interface SessionInfo {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: ModelConfig;
  messageCount: number;
  pinned?: boolean;
  archived?: boolean;
  active?: boolean;
}

export interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  toolCalls?: ToolCallItem[];
  createdAt: number;
  stopReason?: string;
  errorMessage?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: ModelConfig;
  messages: ChatMessageItem[];
}

export interface RunOutcome {
  text: string;
  thinking?: string;
}

export type AgentEvent =
  | { type: "session_created"; session: SessionInfo }
  | { type: "session_restored"; session: SessionInfo }
  | { type: "agent_start"; runId?: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "agent_end"; text?: string; stopReason?: string }
  | { type: "agent_error"; code: string; message: string; retryable: boolean }
  | { type: "session_deleted"; sessionId: string };

export interface AgentEventEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  workspaceId: string;
  runId?: string;
  event: AgentEvent;
}

export interface AvailableModelItem {
  provider: string;
  providerName?: string;
  id: string;
  name: string;
  reasoning?: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface AgentClient {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  listSessions(workspaceRoot: string): Promise<SessionInfo[]>;
  getSession(workspaceRoot: string, sessionId: string): Promise<SessionSnapshot>;
  prompt(workspaceRoot: string, sessionId: string, text: string, model?: ModelConfig): Promise<RunOutcome>;
  cancel(sessionId: string): Promise<void>;
  compact(workspaceRoot: string, sessionId: string): Promise<void>;
  fork(workspaceRoot: string, sessionId: string, title?: string): Promise<SessionInfo>;
  deleteSession(workspaceRoot: string, sessionId: string): Promise<void>;
  listAvailableModels(): Promise<AvailableModelItem[]>;
  updateSessionMeta(
    workspaceRoot: string,
    sessionId: string,
    meta: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<SessionInfo>;
  subscribe(listener: (eventEnvelope: AgentEventEnvelope) => void): () => void;
}

export function inTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export class TauriAgentClient implements AgentClient {
  private readonly listeners = new Set<(eventEnvelope: AgentEventEnvelope) => void>();
  private unlistenFn: UnlistenFn | null = null;

  constructor() {
    this.initEventListener();
  }

  private initEventListener(): void {
    if (!inTauriRuntime()) return;

    void listen<AgentEventEnvelope | { event?: AgentEvent; sessionId?: string; workspaceId?: string }>("agent-event", (event) => {
      const payload = event.payload;
      if (!payload || !payload.event) return;

      const envelope: AgentEventEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: payload.sessionId ?? "",
        workspaceId: payload.workspaceId ?? "",
        event: payload.event,
      };

      for (const listener of this.listeners) {
        try {
          listener(envelope);
        } catch (err) {
          console.error("[TauriAgentClient] error in event listener:", err);
        }
      }
    }).then((unlisten) => {
      this.unlistenFn = unlisten;
    });
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const res = await invoke<{ ok?: boolean; output?: SessionInfo } & Record<string, unknown>>(
      "pi_session_new",
      { root: input.workspaceRoot, title: input.title, model: input.model },
    );
    const summary = res.output;
    if (!summary || !summary.sessionId) {
      throw new Error("创建会话失败：未收到有效的 Session 信息。");
    }
    return summary;
  }

  async listSessions(workspaceRoot: string): Promise<SessionInfo[]> {
    interface SqliteSessionRecord {
      id: string;
      workspaceId: string;
      title: string;
      modelProvider: string;
      modelId: string;
      createdAt: string;
      updatedAt: string;
      archived: boolean;
      pinned: boolean;
    }

    const records = await invoke<SqliteSessionRecord[]>("pi_session_list", { root: workspaceRoot });
    return (records || []).map((r) => ({
      sessionId: r.id,
      workspaceId: r.workspaceId,
      workspaceRoot,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      model: {
        provider: r.modelProvider,
        id: r.modelId,
      },
      messageCount: 0,
      pinned: r.pinned,
      archived: r.archived,
    }));
  }

  async getSession(workspaceRoot: string, sessionId: string): Promise<SessionSnapshot> {
    const res = await invoke<{ ok?: boolean; output?: SessionSnapshot } & Record<string, unknown>>(
      "pi_session_get",
      { root: workspaceRoot, sessionId },
    );
    const snapshot = res.output;
    if (!snapshot || !snapshot.sessionId) {
      throw new Error(`获取会话快照失败 (${sessionId})`);
    }
    return snapshot;
  }

  async prompt(
    workspaceRoot: string,
    sessionId: string,
    text: string,
    model?: ModelConfig,
  ): Promise<RunOutcome> {
    const res = await invoke<{ ok?: boolean; output?: RunOutcome } & Record<string, unknown>>(
      "pi_prompt",
      { root: workspaceRoot, sessionId, text, model },
    );
    return res.output ?? { text: "" };
  }

  async cancel(sessionId: string): Promise<void> {
    await invoke("pi_session_cancel", { sessionId });
  }

  async compact(workspaceRoot: string, sessionId: string): Promise<void> {
    await invoke("pi_session_compact", { root: workspaceRoot, sessionId });
  }

  async fork(workspaceRoot: string, sessionId: string, title?: string): Promise<SessionInfo> {
    const res = await invoke<{ ok?: boolean; output?: SessionInfo } & Record<string, unknown>>(
      "pi_session_fork",
      { root: workspaceRoot, sessionId, title },
    );
    const summary = res.output;
    if (!summary || !summary.sessionId) {
      throw new Error("分叉会话失败：未收到有效的 Session 信息。");
    }
    return summary;
  }

  async deleteSession(workspaceRoot: string, sessionId: string): Promise<void> {
    await invoke("pi_session_delete", { root: workspaceRoot, sessionId });
  }

  async listAvailableModels(): Promise<AvailableModelItem[]> {
    const res = await invoke<{ ok?: boolean; output?: AvailableModelItem[] } & Record<string, unknown>>(
      "pi_models_list",
    );
    return res.output ?? [];
  }

  async updateSessionMeta(
    workspaceRoot: string,
    sessionId: string,
    meta: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<SessionInfo> {
    const record = await invoke<{
      id: string;
      workspaceId: string;
      title: string;
      modelProvider: string;
      modelId: string;
      createdAt: string;
      updatedAt: string;
      archived: boolean;
      pinned: boolean;
    }>("pi_session_update_meta", {
      root: workspaceRoot,
      sessionId,
      title: meta.title,
      pinned: meta.pinned,
      archived: meta.archived,
    });

    return {
      sessionId: record.id,
      workspaceId: record.workspaceId,
      workspaceRoot,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      model: {
        provider: record.modelProvider,
        id: record.modelId,
      },
      messageCount: 0,
      pinned: record.pinned,
      archived: record.archived,
    };
  }

  subscribe(listener: (eventEnvelope: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.unlistenFn) {
      this.unlistenFn();
      this.unlistenFn = null;
    }
    this.listeners.clear();
  }
}

export class MockAgentClient implements AgentClient {
  private sessions: SessionInfo[] = [];
  private messagesMap = new Map<string, ChatMessageItem[]>();
  private readonly listeners = new Set<(eventEnvelope: AgentEventEnvelope) => void>();

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const now = new Date().toISOString();
    const sessionId = `mock-session-${Date.now()}`;
    const session: SessionInfo = {
      sessionId,
      workspaceId: input.workspaceRoot,
      workspaceRoot: input.workspaceRoot,
      title: input.title ?? "新对话",
      createdAt: now,
      updatedAt: now,
      model: { provider: "mock", id: "mock-model" },
      messageCount: 0,
    };
    this.sessions.unshift(session);
    this.messagesMap.set(sessionId, []);
    return session;
  }

  async listSessions(_workspaceRoot: string): Promise<SessionInfo[]> {
    return [...this.sessions];
  }

  async getSession(workspaceRoot: string, sessionId: string): Promise<SessionSnapshot> {
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    const messages = this.messagesMap.get(sessionId) ?? [];
    return {
      sessionId,
      workspaceId: workspaceRoot,
      workspaceRoot,
      title: session?.title ?? "模拟对话",
      createdAt: session?.createdAt ?? new Date().toISOString(),
      updatedAt: session?.updatedAt ?? new Date().toISOString(),
      model: session?.model ?? { provider: "mock", id: "mock-model" },
      messages,
    };
  }

  async prompt(_workspaceRoot: string, sessionId: string, text: string): Promise<RunOutcome> {
    const messages = this.messagesMap.get(sessionId) ?? [];
    messages.push({
      id: `msg-${Date.now()}-user`,
      role: "user",
      text,
      createdAt: Date.now(),
    });

    const reply = `[预览模式模拟回复] 您提出了："${text}"。在 Tauri 桌面端运行可与真实的 Pi 智能体对话。`;
    messages.push({
      id: `msg-${Date.now()}-assistant`,
      role: "assistant",
      text: reply,
      createdAt: Date.now(),
    });
    this.messagesMap.set(sessionId, messages);

    return { text: reply };
  }

  async cancel(_sessionId: string): Promise<void> {}
  async compact(_workspaceRoot: string, _sessionId: string): Promise<void> {}
  async fork(workspaceRoot: string, _sessionId: string, title?: string): Promise<SessionInfo> {
    return this.createSession({ workspaceRoot, title: title ?? "分叉会话" });
  }
  async deleteSession(_workspaceRoot: string, sessionId: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
    this.messagesMap.delete(sessionId);
  }
  async listAvailableModels(): Promise<AvailableModelItem[]> {
    return [
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", isDefault: true },
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
    ];
  }
  async updateSessionMeta(_workspaceRoot: string, sessionId: string, meta: { title?: string; pinned?: boolean; archived?: boolean }): Promise<SessionInfo> {
    let session = this.sessions.find((s) => s.sessionId === sessionId);
    if (!session) throw new Error("Session not found");
    if (meta.title !== undefined) session.title = meta.title;
    if (meta.pinned !== undefined) session.pinned = meta.pinned;
    if (meta.archived !== undefined) session.archived = meta.archived;
    return session;
  }
  subscribe(listener: (eventEnvelope: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export function createAgentClient(): AgentClient {
  return inTauriRuntime() ? new TauriAgentClient() : new MockAgentClient();
}
