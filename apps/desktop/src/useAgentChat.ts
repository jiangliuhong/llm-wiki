import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentClient,
  type AgentEventEnvelope,
  type AvailableModelItem,
  type ChatMessageItem,
  createAgentClient,
  type ModelConfig,
  type SessionInfo,
  type ToolCallItem,
} from "./agentClient";

export interface UseAgentChatOptions {
  workspaceRoot: string | null;
  client?: AgentClient;
}

export interface StreamingState {
  text: string;
  thinking: string;
  phase: "idle" | "thinking" | "answering" | "complete";
  toolCalls: ToolCallItem[];
}

export function useAgentChat({ workspaceRoot, client: customClient }: UseAgentChatOptions) {
  const clientRef = useRef<AgentClient>(customClient ?? createAgentClient());
  const client = clientRef.current;

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModelItem[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({
    text: "",
    thinking: "",
    phase: "idle",
    toolCalls: [],
  });
  const [error, setError] = useState<string | null>(null);

  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const streamingRef = useRef<StreamingState>(streaming);
  streamingRef.current = streaming;

  // Load available models authenticated in Pi
  const refreshAvailableModels = useCallback(async (): Promise<void> => {
    try {
      const list = await client.listAvailableModels();
      setAvailableModels(list);
    } catch (err) {
      console.error("[useAgentChat] failed to list available models:", err);
    }
  }, [client]);

  useEffect(() => {
    void refreshAvailableModels();
  }, [refreshAvailableModels]);

  // Load sessions when workspaceRoot changes
  const refreshSessions = useCallback(async (): Promise<void> => {
    if (!workspaceRoot) {
      setSessions([]);
      setActiveSessionId(null);
      setMessages([]);
      return;
    }
    try {
      const list = await client.listSessions(workspaceRoot);
      setSessions(list);
      // If active session was deleted, clear it
      if (activeSessionIdRef.current && !list.some((s) => s.sessionId === activeSessionIdRef.current)) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("[useAgentChat] failed to list sessions:", err);
    }
  }, [client, workspaceRoot]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Load active session messages snapshot
  const loadSession = useCallback(async (sessionId: string): Promise<void> => {
    if (!workspaceRoot) return;
    setLoadingSession(true);
    setError(null);
    try {
      const snapshot = await client.getSession(workspaceRoot, sessionId);
      setMessages(snapshot.messages || []);
      setActiveSessionId(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSession(false);
    }
  }, [client, workspaceRoot]);

  const selectSession = useCallback((sessionId: string | null): void => {
    setActiveSessionId(sessionId);
    setError(null);
    if (!sessionId) {
      setMessages([]);
      return;
    }
    void loadSession(sessionId);
  }, [loadSession]);

  // Subscribe to agent events
  useEffect(() => {
    const unsubscribe = client.subscribe((envelope: AgentEventEnvelope) => {
      const currentActive = activeSessionIdRef.current;
      if (!currentActive || envelope.sessionId !== currentActive) {
        return;
      }

      const ev = envelope.event;
      if (ev.type === "thinking_delta") {
        setStreaming((prev) => ({
          ...prev,
          thinking: prev.thinking + ev.delta,
          phase: prev.text ? "answering" : "thinking",
        }));
      } else if (ev.type === "text_delta") {
        setStreaming((prev) => ({
          ...prev,
          text: prev.text + ev.delta,
          phase: "answering",
        }));
      } else if (ev.type === "tool_execution_start") {
        setStreaming((prev) => {
          const updated = [...prev.toolCalls];
          const idx = updated.findIndex((t) => t.toolCallId === ev.toolCallId);
          if (idx >= 0) {
            updated[idx] = { ...updated[idx], ...ev };
          } else {
            updated.push({
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              args: ev.args,
            });
          }
          return { ...prev, toolCalls: updated };
        });
      } else if (ev.type === "tool_execution_end") {
        setStreaming((prev) => {
          const updated = prev.toolCalls.map((t) =>
            t.toolCallId === ev.toolCallId
              ? { ...t, result: ev.result, isError: ev.isError }
              : t,
          );
          return { ...prev, toolCalls: updated };
        });
      } else if (ev.type === "agent_end") {
        setStreaming((prev) => ({
          ...prev,
          phase: "complete",
        }));
      } else if (ev.type === "agent_error") {
        setError(ev.message);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [client]);

  // Create new session
  const createSession = useCallback(async (title?: string, model?: ModelConfig): Promise<string> => {
    if (!workspaceRoot) throw new Error("No workspace selected");
    const summary = await client.createSession({ workspaceRoot, title, model });
    await refreshSessions();
    setActiveSessionId(summary.sessionId);
    setMessages([]);
    return summary.sessionId;
  }, [client, refreshSessions, workspaceRoot]);

  // Send prompt
  const sendMessage = useCallback(async (text: string, model?: ModelConfig): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || !workspaceRoot || sending) return;

    setSending(true);
    setError(null);

    let targetSessionId = activeSessionIdRef.current;
    if (!targetSessionId) {
      try {
        targetSessionId = await createSession(trimmed.slice(0, 30), model);
      } catch (err) {
        setSending(false);
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const userMessage: ChatMessageItem = {
      id: `msg-${Date.now()}-user`,
      role: "user",
      text: trimmed,
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setStreaming({ text: "", thinking: "", phase: "thinking", toolCalls: [] });

    try {
      const outcome = await client.prompt(workspaceRoot, targetSessionId, trimmed, model);
      const assistantMessage: ChatMessageItem = {
        id: `msg-${Date.now()}-assistant`,
        role: "assistant",
        text: outcome.text || streamingRef.current.text,
        thinking: outcome.thinking || streamingRef.current.thinking,
        toolCalls: streamingRef.current.toolCalls.length > 0 ? streamingRef.current.toolCalls : undefined,
        createdAt: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      await refreshSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Keep partial streamed content if any
      const cur = streamingRef.current;
      if (cur.text || cur.thinking) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-assistant-partial`,
            role: "assistant",
            text: cur.text,
            thinking: cur.thinking,
            toolCalls: cur.toolCalls.length > 0 ? cur.toolCalls : undefined,
            errorMessage: msg,
            createdAt: Date.now(),
          },
        ]);
      }
    } finally {
      setSending(false);
      setStreaming({ text: "", thinking: "", phase: "idle", toolCalls: [] });
    }
  }, [client, createSession, refreshSessions, sending, workspaceRoot]);

  const cancelPrompt = useCallback(async (): Promise<void> => {
    const cur = activeSessionIdRef.current;
    if (!cur) return;
    try {
      await client.cancel(cur);
    } catch (err) {
      console.error("[useAgentChat] cancel failed:", err);
    }
  }, [client]);

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    if (!workspaceRoot) return;
    try {
      await client.deleteSession(workspaceRoot, sessionId);
      if (activeSessionIdRef.current === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, refreshSessions, workspaceRoot]);

  const forkSession = useCallback(async (sessionId: string, title?: string): Promise<string> => {
    if (!workspaceRoot) throw new Error("No workspace selected");
    const summary = await client.fork(workspaceRoot, sessionId, title);
    await refreshSessions();
    setActiveSessionId(summary.sessionId);
    await loadSession(summary.sessionId);
    return summary.sessionId;
  }, [client, loadSession, refreshSessions, workspaceRoot]);

  const compactSession = useCallback(async (sessionId: string): Promise<void> => {
    if (!workspaceRoot) return;
    try {
      await client.compact(workspaceRoot, sessionId);
      await loadSession(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, loadSession, workspaceRoot]);

  const togglePin = useCallback(async (sessionId: string): Promise<void> => {
    if (!workspaceRoot) return;
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;
    try {
      await client.updateSessionMeta(workspaceRoot, sessionId, { pinned: !session.pinned });
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, refreshSessions, sessions, workspaceRoot]);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) ?? null;

  return {
    sessions,
    activeSessionId,
    activeSession,
    messages,
    availableModels,
    loadingSession,
    sending,
    streaming,
    error,
    selectSession,
    createSession,
    sendMessage,
    cancelPrompt,
    deleteSession,
    forkSession,
    compactSession,
    togglePin,
    refreshSessions,
    refreshAvailableModels,
  };
}
