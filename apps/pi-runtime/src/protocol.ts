export const PROTOCOL_VERSION = "1" as const;

export type ReadOnlyTool =
  | "workspace_get"
  | "workspace_status"
  | "document_list"
  | "document_search"
  | "document_read"
  | "document_read_range"
  | "document_relations"
  | "document_neighborhood";

export interface ToolCallRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "tool_call";
  sessionId: string;
  workspaceId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface PingRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "ping";
}

export interface ModelConfig {
  provider: string;
  id: string;
  apiKey?: string;
  /** Optional Anthropic/OpenAI-compatible endpoint override (e.g. Zhipu GLM Coding Plan). */
  baseUrl?: string;
  /** Reasoning effort for the session; unknown values fall back to "medium". */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
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
}

export interface SessionSwitchRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "session_switch";
  sessionId: string;
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
}

export interface PromptRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "prompt";
  sessionId: string;
  text: string;
  /** Current model config; used to re-credential a lazily restored session. */
  model?: ModelConfig;
}

export type SessionRequest =
  | SessionNewRequest
  | SessionListRequest
  | SessionSwitchRequest
  | SessionForkRequest
  | SessionDeleteRequest
  | SessionCancelRequest
  | SessionCompactRequest
  | PromptRequest;

export type RuntimeRequest = ToolCallRequest | PingRequest | SessionRequest;

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  model: ModelConfig;
  messageCount: number;
  active: boolean;
}

export type StreamEventPayload =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "agent_end" }
  | { type: "session_switched"; sessionId: string }
  | { type: "error"; message: string };

export interface RuntimeResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "tool_result" | "pong" | "error" | "event";
  ok: boolean;
  sessionId?: string;
  event?: StreamEventPayload;
  output?: unknown;
  error?: { code: string; message: string };
}

export function response(
  id: string,
  type: RuntimeResponse["type"],
  value: Omit<RuntimeResponse, "protocolVersion" | "id" | "type"> = { ok: true },
): RuntimeResponse {
  return { protocolVersion: PROTOCOL_VERSION, id, type, ...value };
}

export function eventResponse(
  id: string,
  sessionId: string,
  event: StreamEventPayload,
): RuntimeResponse {
  return { protocolVersion: PROTOCOL_VERSION, id, type: "event", ok: true, sessionId, event };
}

export function isAllowedReadOnlyTool(tool: string): tool is ReadOnlyTool {
  return [
    "workspace_get",
    "workspace_status",
    "document_list",
    "document_search",
    "document_read",
    "document_read_range",
    "document_relations",
    "document_neighborhood",
  ].includes(tool);
}
