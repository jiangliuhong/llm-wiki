export const PROTOCOL_VERSION = "2" as const;

export type AllowedTool =
  | "workspace_get"
  | "workspace_status"
  | "document_list"
  | "document_search"
  | "document_read"
  | "document_read_range"
  | "document_relations"
  | "document_neighborhood"
  | "document_draft_create"
  | "document_draft_get"
  | "document_draft_list"
  | "document_draft_delete"
  | "relation_proposal_create"
  | "relation_proposal_list";

export type ReadOnlyTool = AllowedTool;

export const ALLOWED_TOOLS: readonly AllowedTool[] = [
  "workspace_get",
  "workspace_status",
  "document_list",
  "document_search",
  "document_read",
  "document_read_range",
  "document_relations",
  "document_neighborhood",
  "document_draft_create",
  "document_draft_get",
  "document_draft_list",
  "document_draft_delete",
  "relation_proposal_create",
  "relation_proposal_list",
] as const;

export const ALLOWED_READ_ONLY_TOOLS = ALLOWED_TOOLS;

export function isAllowedTool(tool: string): tool is AllowedTool {
  return (ALLOWED_TOOLS as readonly string[]).includes(tool);
}

export const isAllowedReadOnlyTool = isAllowedTool;

export type AgentErrorCode =
  | "PI_RUNTIME_NOT_FOUND"
  | "PI_RUNTIME_START_FAILED"
  | "PI_RUNTIME_EXITED"
  | "PI_MODEL_NOT_CONFIGURED"
  | "PI_AUTH_REQUIRED"
  | "PI_SESSION_NOT_FOUND"
  | "PI_SESSION_BUSY"
  | "PI_SESSION_FAILED"
  | "PI_SESSION_CANCELLED"
  | "PI_EMPTY_RESPONSE"
  | "PI_TOOL_NOT_ALLOWED"
  | "PI_TOOL_FAILED"
  | "PI_PROTOCOL_ERROR";

export interface AgentError {
  code: AgentErrorCode | string;
  message: string;
  retryable?: boolean;
  sessionId?: string;
  runId?: string;
}

export interface ModelConfig {
  provider: string;
  id: string;
  apiKey?: string;
  baseUrl?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  credentialId?: string;
}

export interface RuntimeScope {
  workspaceId: string;
  workspaceRoot: string;
  sessionId?: string;
  runId?: string;
}

export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: ModelConfig;
  messageCount: number;
  active?: boolean;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface MessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  toolCalls?: ToolCallRecord[];
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
  messages: MessageRecord[];
}

export type AgentEvent =
  | { type: "session_created"; session: SessionSummary }
  | { type: "session_restored"; session: SessionSummary }
  | { type: "agent_start"; runId?: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
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

// Host -> Runtime requests
export interface PingRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "ping";
}

export interface SessionNewRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_new";
  workspaceId: string;
  workspaceRoot: string;
  model: ModelConfig;
  title?: string;
  systemPrompt?: string;
}

export interface SessionListRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_list";
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface SessionGetRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_get";
  sessionId: string;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface SessionPromptRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_prompt";
  sessionId: string;
  text: string;
  workspaceId?: string;
  workspaceRoot?: string;
  model?: ModelConfig;
  runId?: string;
}

export interface SessionCancelRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_cancel";
  sessionId: string;
}

export interface SessionCompactRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_compact";
  sessionId: string;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface SessionForkRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_fork";
  sessionId: string;
  title?: string;
}

export interface SessionDeleteRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_delete";
  sessionId: string;
  workspaceId?: string;
  workspaceRoot?: string;
}

export interface RuntimeShutdownRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "runtime_shutdown";
}

export interface ToolResultResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "tool_result";
  toolCallId: string;
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string };
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

export interface ModelsListRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "models_list";
}

export type HostToRuntimeMessage =
  | PingRequest
  | ModelsListRequest
  | SessionNewRequest
  | SessionListRequest
  | SessionGetRequest
  | SessionPromptRequest
  | SessionCancelRequest
  | SessionCompactRequest
  | SessionForkRequest
  | SessionDeleteRequest
  | RuntimeShutdownRequest
  | ToolResultResponse;

// Runtime -> Host messages
export interface ReadyMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "ready";
}

export interface PongResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "pong";
  ok: true;
}

export interface ToolRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "tool_request";
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface RuntimeResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "response";
  ok: boolean;
  output?: unknown;
  error?: AgentError;
}

export interface RuntimeErrorNotification {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: "runtime_error";
  error: AgentError;
}

export type RuntimeToHostMessage =
  | ReadyMessage
  | PongResponse
  | ToolRequest
  | RuntimeResponse
  | AgentEventEnvelope
  | RuntimeErrorNotification;

export function createResponse(
  id: string,
  ok: boolean,
  output?: unknown,
  error?: AgentError,
): RuntimeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    type: "response",
    ok,
    ...(output !== undefined ? { output } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export function createEventEnvelope(
  sessionId: string,
  workspaceId: string,
  event: AgentEvent,
  runId?: string,
): AgentEventEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    workspaceId,
    ...(runId ? { runId } : {}),
    event,
  };
}
