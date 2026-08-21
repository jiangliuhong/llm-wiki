import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type AgentError,
  type AgentEvent,
  type MessageRecord,
  type ModelConfig,
  type SessionSnapshot,
  type SessionSummary,
  type ToolCallRecord,
} from "./protocol.js";

export class SessionHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "SessionHostError";
  }

  toAgentError(sessionId?: string, runId?: string): AgentError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
    };
  }
}

export interface AssistantOutcome {
  text: string;
  thinking: string;
  stopReason?: string;
  errorMessage?: string;
}

export function extractAssistantText(content: unknown): string {
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

export function extractAssistantThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let thinking = "";
  for (const part of content as { type?: string; thinking?: string }[]) {
    if (typeof part === "object" && part?.type === "thinking" && typeof part.thinking === "string") {
      thinking += part.thinking;
    }
  }
  return thinking;
}

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

export interface AgentSessionWrapperOptions {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  model: ModelConfig;
  session: AgentSession;
  createdAt?: string;
  updatedAt?: string;
}

export class AgentSessionWrapper {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  title: string;
  model: ModelConfig;
  readonly session: AgentSession;
  readonly createdAt: string;
  updatedAt: string;

  private running = false;
  private alive = true;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private streamedText = "";
  private streamedThinking = "";

  constructor(options: AgentSessionWrapperOptions) {
    this.sessionId = options.sessionId;
    this.workspaceId = options.workspaceId;
    this.workspaceRoot = options.workspaceRoot;
    this.title = options.title;
    this.model = options.model;
    this.session = options.session;
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.updatedAt = options.updatedAt ?? this.createdAt;

    this.session.subscribe((event) => {
      if (!this.alive) return;

      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          this.streamedText += update.delta;
          this.emit({ type: "text_delta", delta: update.delta });
        } else if (update.type === "thinking_delta") {
          this.streamedThinking += update.delta;
          this.emit({ type: "thinking_delta", delta: update.delta });
        }
      } else if (event.type === "tool_execution_start") {
        this.emit({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        this.emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      }
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  isRunning(): boolean {
    return this.running;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[AgentSessionWrapper] listener error:", err);
      }
    }
  }

  getSummary(active = false): SessionSummary {
    const { apiKey: _apiKey, ...safeModel } = this.model;
    const entries = this.session.sessionManager.getEntries();
    const messageCount = entries.filter((e) => "message" in e && Boolean(e.message)).length;

    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      workspaceRoot: this.workspaceRoot,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      model: safeModel,
      messageCount,
      active,
    };
  }

  getSnapshot(): SessionSnapshot {
    const { apiKey: _apiKey, ...safeModel } = this.model;
    const entries = this.session.sessionManager.getEntries();
    const messages: MessageRecord[] = [];

    // Collect all tool results from tool messages/entries
    const toolResults = new Map<string, { result: unknown; isError?: boolean }>();

    for (const entry of entries) {
      if (!entry) continue;
      const msg = (entry as { message?: unknown }).message as {
        role?: string;
        toolCallId?: string;
        id?: string;
        content?: unknown;
        isError?: boolean;
      } | undefined;

      if (msg && msg.role === "tool") {
        const id = msg.toolCallId || msg.id;
        if (id) {
          let content = msg.content;
          if (Array.isArray(content)) {
            for (const p of content as { type?: string; text?: string; result?: unknown }[]) {
              if (p?.text) content = p.text;
              else if (p?.result !== undefined) content = p.result;
            }
          }
          toolResults.set(id, { result: content, isError: Boolean(msg.isError) });
        }
      }
    }

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || !("message" in entry) || !entry.message) continue;

      const rawMsg = entry.message as {
        role?: "user" | "assistant" | "system" | "tool";
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
        timestamp?: number;
      };

      // Skip standalone tool result messages from the visible chat messages array
      if (rawMsg.role === "tool") {
        continue;
      }

      const role = rawMsg.role ?? "user";
      const text = extractAssistantText(rawMsg.content);
      const thinking = role === "assistant" ? extractAssistantThinking(rawMsg.content) : undefined;
      const createdAt = rawMsg.timestamp ?? (Date.now() - (entries.length - i) * 1000);

      // Collect tool calls if content contains tool_call parts
      const toolCalls: ToolCallRecord[] = [];
      if (Array.isArray(rawMsg.content)) {
        for (const part of rawMsg.content as {
          type?: string;
          id?: string;
          toolCallId?: string;
          name?: string;
          toolName?: string;
          input?: unknown;
          args?: unknown;
          arguments?: unknown;
          result?: unknown;
          isError?: boolean;
        }[]) {
          const isToolCall =
            part?.type === "tool_use" ||
            part?.type === "tool_call" ||
            part?.type === "toolCall" ||
            part?.type === "tool-call";

          if (isToolCall) {
            const toolId = part.id ?? part.toolCallId ?? `tool-${Math.random().toString(36).slice(2, 8)}`;
            const toolName = part.name ?? part.toolName ?? "unknown";
            const args = part.input ?? part.args ?? part.arguments ?? {};
            const matchedResult = toolResults.get(toolId);
            const result = part.result !== undefined ? part.result : matchedResult?.result;
            const isError = part.isError !== undefined ? part.isError : matchedResult?.isError;

            toolCalls.push({
              toolCallId: toolId,
              toolName,
              args,
              ...(result !== undefined ? { result } : {}),
              ...(isError !== undefined ? { isError } : {}),
            });
          }
        }
      }

      messages.push({
        id: `msg-${i}-${this.sessionId}`,
        role,
        text,
        ...(thinking ? { thinking } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        createdAt,
        ...(rawMsg.stopReason ? { stopReason: rawMsg.stopReason } : {}),
        ...(rawMsg.errorMessage ? { errorMessage: rawMsg.errorMessage } : {}),
      });
    }

    return {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      workspaceRoot: this.workspaceRoot,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      model: safeModel,
      messages,
    };
  }

  async sendPrompt(text: string, runId?: string): Promise<{ text: string; thinking: string }> {
    if (!this.alive) {
      throw new SessionHostError("PI_SESSION_NOT_FOUND", `Session ${this.sessionId} is no longer alive.`);
    }
    if (this.running) {
      throw new SessionHostError("PI_SESSION_BUSY", `Session ${this.sessionId} is currently running another request.`);
    }

    this.running = true;
    this.emit({ type: "agent_start", runId });

    const entriesBefore = this.session.sessionManager.getEntries().length;
    const streamedBefore = this.streamedText;
    const streamedThinkingBefore = this.streamedThinking;

    try {
      await this.session.prompt(text);

      const newEntries = this.session.sessionManager.getEntries().slice(entriesBefore);
      const outcome = assistantOutcomeOf(newEntries);

      if (outcome.stopReason === "error") {
        throw new SessionHostError(
          "PI_SESSION_FAILED",
          outcome.errorMessage || "模型请求失败，但 Provider 未返回具体原因。",
          true,
        );
      }

      if (outcome.stopReason === "aborted") {
        throw new SessionHostError(
          "PI_SESSION_CANCELLED",
          outcome.errorMessage || "生成已取消。",
          false,
        );
      }

      const streamedDelta = this.streamedText.slice(streamedBefore.length);
      const streamedThinkingDelta = this.streamedThinking.slice(streamedThinkingBefore.length);
      const finalText = streamedDelta || outcome.text;
      const finalThinking = streamedThinkingDelta || outcome.thinking;

      if (!finalText.trim() && !finalThinking.trim()) {
        throw new SessionHostError(
          "PI_EMPTY_RESPONSE",
          "模型请求成功结束，但没有返回文本内容。",
          false,
        );
      }

      if (!streamedThinkingDelta && outcome.thinking) {
        this.emit({ type: "thinking_delta", delta: outcome.thinking });
      }

      if (!streamedDelta && outcome.text) {
        this.emit({ type: "text_delta", delta: outcome.text });
      }

      this.updatedAt = new Date().toISOString();
      this.emit({ type: "agent_end", text: finalText, stopReason: outcome.stopReason });

      return { text: finalText, thinking: finalThinking };
    } catch (error) {
      const code = error instanceof SessionHostError ? error.code : "PI_SESSION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof SessionHostError ? error.retryable : false;

      this.emit({ type: "agent_error", code, message, retryable });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.alive) return;
    await this.session.abort();
  }

  async compact(): Promise<void> {
    if (!this.alive) {
      throw new SessionHostError("PI_SESSION_NOT_FOUND", `Session ${this.sessionId} is no longer alive.`);
    }
    if (this.running) {
      throw new SessionHostError("PI_SESSION_BUSY", `Session ${this.sessionId} is busy.`);
    }

    this.running = true;
    try {
      await this.session.compact();
      this.updatedAt = new Date().toISOString();
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.running = false;
    try {
      this.session.dispose();
    } catch {
      // ignore disposal errors
    }
    this.listeners.clear();
  }
}
