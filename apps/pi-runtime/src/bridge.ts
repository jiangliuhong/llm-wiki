import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ALLOWED_TOOLS,
  type AllowedTool,
  isAllowedTool,
  PROTOCOL_VERSION,
  type ToolRequest,
  type ToolResultResponse,
} from "./protocol.js";

const TOOL_DESCRIPTIONS: Record<AllowedTool, string> = {
  workspace_get: "Read the llm-wiki workspace manifest (id, title, root).",
  workspace_status: "Report workspace indexing and storage status.",
  document_list: "List documents in the workspace knowledge base.",
  document_search: "Search workspace documents by query and return ranked results.",
  document_read: "Read a workspace document by fileId or path.",
  document_read_range: "Read a line range of a workspace document.",
  document_relations: "List relations of a workspace document.",
  document_neighborhood: "List graph neighborhood of a workspace document.",
  document_draft_create: "Create a staged draft document in the knowledge base. Target path must be workspace-relative under wiki/ (e.g. 'wiki/overview.md'). Generated content must be complete, high-quality Markdown.",
  document_draft_get: "Get a staged draft document by draftId.",
  document_draft_list: "List staged draft documents in the workspace.",
  document_draft_delete: "Delete a staged draft document by draftId.",
  relation_proposal_create: "Create a staged relation proposal between two documents for the knowledge graph. Requires source and target document paths, relation type, confidence score, rationale, and evidence lines.",
  relation_proposal_list: "List staged relation proposals in the workspace.",
};

const TOOL_SCHEMAS: Record<AllowedTool, any> = {
  workspace_get: Type.Object({}),
  workspace_status: Type.Object({}),
  document_list: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max documents to return (default: 50)" })),
    q: Type.Optional(Type.String({ description: "Filter documents by path or name substring" })),
  }),
  document_search: Type.Object({
    query: Type.String({ description: "Search query text or keywords" }),
    limit: Type.Optional(Type.Number({ description: "Max results to return (default: 20)" })),
  }),
  document_read: Type.Object({
    fileId: Type.Optional(Type.Number({ description: "Numeric ID of the file" })),
    path: Type.Optional(Type.String({ description: "Workspace-relative document path (e.g. 'wiki/welcome.md')" })),
  }),
  document_read_range: Type.Object({
    fileId: Type.Optional(Type.Number({ description: "Numeric ID of the file" })),
    path: Type.Optional(Type.String({ description: "Workspace-relative document path" })),
    startLine: Type.Number({ description: "1-indexed starting line number" }),
    endLine: Type.Number({ description: "1-indexed ending line number" }),
  }),
  document_relations: Type.Object({
    fileId: Type.Optional(Type.Number({ description: "Filter relations by file ID" })),
    path: Type.Optional(Type.String({ description: "Filter relations by document path" })),
  }),
  document_neighborhood: Type.Object({
    fileId: Type.Optional(Type.Number({ description: "Starting document file ID" })),
    path: Type.Optional(Type.String({ description: "Starting document path" })),
    depth: Type.Optional(Type.Number({ description: "Search depth (1-3, default: 1)" })),
  }),
  document_draft_create: Type.Object({
    targetPath: Type.String({ description: "Target workspace-relative file path under wiki/ (e.g. 'wiki/architecture.md')" }),
    generatedContent: Type.String({ description: "Full markdown content of the document to be saved" }),
    operationType: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("append")], { description: "Operation type ('create', 'update', or 'append', default: 'create')" })),
    sourceCitations: Type.Optional(Type.Array(Type.String(), { description: "List of document paths or source files referenced" })),
    sectionSlug: Type.Optional(Type.String({ description: "Section slug if targeting a specific section in an update" })),
    baseDocumentHash: Type.Optional(Type.String({ description: "Base document content hash if updating an existing document" })),
  }),
  document_draft_get: Type.Object({
    draftId: Type.String({ description: "Unique draft ID (e.g. 'draft-...')" }),
  }),
  document_draft_list: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by draft status ('pending', 'applied', 'rejected')" })),
  }),
  document_draft_delete: Type.Object({
    draftId: Type.String({ description: "Unique draft ID to delete" }),
  }),
  relation_proposal_create: Type.Object({
    sourcePath: Type.String({ description: "Source document path (e.g. 'wiki/order.md')" }),
    targetPath: Type.String({ description: "Target document path (e.g. 'wiki/payment.md')" }),
    relationType: Type.String({ description: "Relation type (e.g. 'depends_on', 'implements', 'extends', 'references', 'related_to')" }),
    confidence: Type.Number({ description: "Confidence score between 0.0 and 1.0 (e.g. 0.9)" }),
    rationale: Type.String({ description: "Reason why this relationship exists" }),
    evidencePath: Type.Optional(Type.String({ description: "Path of document containing the evidence" })),
    evidenceStartLine: Type.Optional(Type.Number({ description: "Start line of evidence snippet" })),
    evidenceEndLine: Type.Optional(Type.Number({ description: "End line of evidence snippet" })),
    evidenceText: Type.Optional(Type.String({ description: "Text snippet supporting the proposal" })),
  }),
  relation_proposal_list: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by proposal status ('pending', 'approved', 'rejected')" })),
  }),
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
    if (!isAllowedTool(tool)) {
      const error = new Error(`Tool ${tool} is not in the allowed tools whitelist.`);
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
    return ALLOWED_TOOLS.map((toolName) => {
      return defineTool({
        name: toolName,
        label: toolName,
        description: TOOL_DESCRIPTIONS[toolName] ?? `llm-wiki host tool ${toolName}.`,
        promptSnippet: TOOL_DESCRIPTIONS[toolName],
        parameters: TOOL_SCHEMAS[toolName] ?? Type.Object({}, { additionalProperties: true }),
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
