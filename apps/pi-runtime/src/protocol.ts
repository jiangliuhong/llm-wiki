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

export type RuntimeRequest = ToolCallRequest | PingRequest;

export interface RuntimeResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  type: "tool_result" | "pong" | "error";
  ok: boolean;
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
