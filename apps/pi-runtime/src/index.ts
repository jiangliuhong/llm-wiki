#!/usr/bin/env node

import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stdin, stdout, stderr } from "node:process";
import {
  eventResponse,
  isAllowedReadOnlyTool,
  PROTOCOL_VERSION,
  response,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./protocol.js";
import { createDefaultHostTools, type HostToolRegistry } from "./host.js";
import { SessionHost, SessionHostError } from "./agent.js";

export class JsonlHostBridge {
  private readonly sessionHost: SessionHost;
  private pendingEvents: RuntimeResponse[] = [];

  constructor(
    private readonly tools: HostToolRegistry = createDefaultHostTools(),
    private readonly workspaceRoot = process.cwd(),
    /** When set, streaming events are written here as they happen. */
    private readonly onEvent: ((response: RuntimeResponse) => void) | undefined = undefined,
  ) {
    this.sessionHost = new SessionHost(
      tools,
      (sessionId, event) => {
        const message = eventResponse("stream", sessionId, event);
        this.pendingEvents.push(message);
        this.onEvent?.(message);
      },
      this.workspaceRoot,
    );
  }

  async handleLine(line: string): Promise<RuntimeResponse[]> {
    let request: RuntimeRequest;
    try {
      request = JSON.parse(line) as RuntimeRequest;
    } catch (error) {
      return [
        response("unknown", "error", {
          ok: false,
          error: { code: "PROTOCOL_INVALID_JSON", message: String(error) },
        }),
      ];
    }
    if (request.protocolVersion !== PROTOCOL_VERSION || typeof request.id !== "string") {
      return [
        response(request.id ?? "unknown", "error", {
          ok: false,
          error: { code: "PROTOCOL_VERSION_UNSUPPORTED", message: "Expected protocolVersion 1." },
        }),
      ];
    }
    if (request.type === "ping") return [response(request.id, "pong")];
    if (request.type === "tool_call") return [await this.handleToolCall(request)];
    return await this.handleSessionRequest(request);
  }

  private async handleToolCall(request: Extract<RuntimeRequest, { type: "tool_call" }>): Promise<RuntimeResponse> {
    if (!isAllowedReadOnlyTool(request.tool)) {
      return response(request.id, "tool_result", {
        ok: false,
        error: { code: "PI_TOOL_NOT_ALLOWED", message: `Tool ${request.tool} is not exposed to Pi.` },
      });
    }
    const handler = this.tools[request.tool];
    if (!handler) {
      return response(request.id, "tool_result", {
        ok: false,
        error: { code: "CORE_TOOL_NOT_CONFIGURED", message: `Core tool ${request.tool} is not configured.` },
      });
    }
    try {
      const output = await handler(request.input, {
        workspaceId: request.workspaceId,
        workspaceRoot: this.workspaceRoot,
      });
      return response(request.id, "tool_result", { ok: true, output });
    } catch (error) {
      return response(request.id, "tool_result", {
        ok: false,
        error: { code: "PI_TOOL_FAILED", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async handleSessionRequest(request: Exclude<RuntimeRequest, { type: "ping" | "tool_call" }>): Promise<RuntimeResponse[]> {
    this.pendingEvents = [];
    try {
      switch (request.type) {
        case "session_new":
          return [response(request.id, "tool_result", { ok: true, output: await this.sessionHost.newSession(request) })];
        case "session_list":
          return [response(request.id, "tool_result", { ok: true, output: this.sessionHost.list() })];
        case "session_switch":
          return [response(request.id, "tool_result", { ok: true, output: await this.sessionHost.switch(request.sessionId) })];
        case "session_fork":
          return [response(request.id, "tool_result", { ok: true, output: await this.sessionHost.fork(request.sessionId, request.title) })];
        case "session_delete":
          await this.sessionHost.delete(request.sessionId);
          return [response(request.id, "tool_result", { ok: true, output: { deleted: request.sessionId } })];
        case "session_cancel":
          await this.sessionHost.cancel(request.sessionId);
          return [response(request.id, "tool_result", { ok: true, output: { cancelled: request.sessionId } })];
        case "session_compact":
          await this.sessionHost.compact(request.sessionId);
          return [response(request.id, "tool_result", { ok: true, output: { compacted: request.sessionId } })];
        case "prompt": {
          const { text: answerText } = await this.sessionHost.prompt(
            request.sessionId,
            request.text,
            request.id,
            request.model,
          );
          const events = this.pendingEvents.map((event) => ({ ...event, id: request.id }));
          const completion = response(request.id, "tool_result", {
            ok: true,
            output: { completed: true, text: answerText },
          });
          return this.onEvent ? [completion] : [...events, completion];
        }
        default:
          return [
            response((request as { id: string }).id, "error", {
              ok: false,
              error: { code: "PROTOCOL_UNKNOWN_REQUEST", message: `Unknown request type ${(request as { type: string }).type}.` },
            }),
          ];
      }
    } catch (error) {
      const code = error instanceof SessionHostError ? error.code : "PI_SESSION_FAILED";
      return [
        response(request.id, "tool_result", {
          ok: false,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        }),
      ];
    }
  }
}

export async function runStdio(bridge = new JsonlHostBridge(undefined, process.cwd(), (r) => {
  stdout.write(`${JSON.stringify(r)}\n`);
})): Promise<void> {
  const input = createInterface({ input: stdin, crlfDelay: Infinity });
  // Requests are handled concurrently so that session_cancel can abort an
  // in-flight prompt instead of queueing behind it. Responses are id-routed,
  // so out-of-order completion is safe.
  for await (const line of input) {
    if (!line.trim()) continue;
    void bridge.handleLine(line).then((results) => {
      for (const result of results) stdout.write(`${JSON.stringify(result)}\n`);
    }, (error) => {
      stderr.write(`handleLine failed: ${String(error)}\n`);
    });
  }
}

export { SessionHost, SessionHostError, assistantOutcomeOf } from "./agent.js";
export { buildHostCustomTools } from "./agent.js";
export type { HostToolContext, HostToolHandler, HostToolRegistry } from "./host.js";
export { createDefaultHostTools } from "./host.js";

// Compare via a real file URL (with symlink resolution) so paths with spaces,
// unicode, or symlinked directories still match.
const entryUrl = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
  } catch {
    return "";
  }
})();
if (import.meta.url === entryUrl) {
  stderr.write("llm-wiki Pi Runtime JSONL bridge ready\n");
  void runStdio();
}
