import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ALLOWED_READ_ONLY_TOOLS,
  isAllowedReadOnlyTool,
  PROTOCOL_VERSION,
  type ReadOnlyTool,
  type ToolRequest,
  type ToolResultResponse,
} from "./protocol.js";

const TOOL_DESCRIPTIONS: Record<ReadOnlyTool, string> = {
  workspace_get: "Read the llm-wiki workspace manifest (id, title, root).",
  workspace_status: "Report workspace indexing and storage status.",
  document_list: "List documents in the workspace knowledge base.",
  document_search: "Search workspace documents by query and return ranked results.",
  document_read: "Read a workspace document by id.",
  document_read_range: "Read a line range of a workspace document.",
  document_relations: "List relations of a workspace document.",
  document_neighborhood: "List graph neighborhood of a workspace document.",
};

export class HostToolBridge {
  private nextRequestId = 0;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly sendRequest: (request: ToolRequest) => void,
    private readonly defaultTimeoutMs: number = 60_000,
  ) {}

  /**
   * Called when a tool_result response is received from the Host.
   */
  handleToolResult(response: ToolResultResponse): boolean {
    const entry = this.pending.get(response.toolCallId) ?? (response.id ? this.pending.get(response.id) : undefined);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(response.toolCallId);
    if (response.id) this.pending.delete(response.id);

    if (response.ok) {
      entry.resolve(response.output);
    } else {
      const errMessage = response.error?.message || "Host tool call failed.";
      const err = new Error(errMessage);
      (err as unknown as { code?: string }).code = response.error?.code || "PI_TOOL_FAILED";
      entry.reject(err);
    }
    return true;
  }

  /**
   * Executes a tool via the Host Bridge by dispatching tool_request and waiting for tool_result.
   */
  async executeTool(
    scope: { sessionId: string; workspaceId: string; workspaceRoot: string },
    tool: string,
    toolCallId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (!isAllowedReadOnlyTool(tool)) {
      const error = new Error(`Tool ${tool} is not in the read-only whitelist.`);
      (error as unknown as { code?: string }).code = "PI_TOOL_NOT_ALLOWED";
      throw error;
    }

    this.nextRequestId += 1;
    const id = `host-tool-${Date.now()}-${this.nextRequestId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        this.pending.delete(id);
        const timeoutError = new Error(`Host tool execution timed out for ${tool}.`);
        (timeoutError as unknown as { code?: string }).code = "PI_TOOL_FAILED";
        reject(timeoutError);
      }, this.defaultTimeoutMs);

      const entry = { resolve, reject, timer };
      this.pending.set(toolCallId, entry);
      this.pending.set(id, entry);

      const request: ToolRequest = {
        protocolVersion: PROTOCOL_VERSION,
        id,
        type: "tool_request",
        sessionId: scope.sessionId,
        workspaceId: scope.workspaceId,
        workspaceRoot: scope.workspaceRoot,
        toolCallId,
        tool,
        input,
      };

      try {
        this.sendRequest(request);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(toolCallId);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Builds custom ToolDefinition array for Pi SDK.
   */
  buildCustomTools(scope: { sessionId: string; workspaceId: string; workspaceRoot: string }): ToolDefinition[] {
    return ALLOWED_READ_ONLY_TOOLS.map((toolName) => {
      return defineTool({
        name: toolName,
        label: toolName,
        description: TOOL_DESCRIPTIONS[toolName] ?? `llm-wiki host tool ${toolName}.`,
        promptSnippet: TOOL_DESCRIPTIONS[toolName],
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async (toolCallId, params) => {
          const output = await this.executeTool(
            scope,
            toolName,
            toolCallId,
            (params || {}) as Record<string, unknown>,
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output ?? null) }],
            details: { tool: toolName },
          };
        },
      });
    });
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("HostToolBridge disposed."));
    }
    this.pending.clear();
  }
}
