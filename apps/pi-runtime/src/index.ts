#!/usr/bin/env node

import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isAllowedReadOnlyTool,
  PROTOCOL_VERSION,
  response,
  type ReadOnlyTool,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./protocol.js";

interface WorkspaceManifest {
  version: 1;
  id: string;
  title: string;
  root: string;
  createdAt: string;
}

export interface HostToolContext {
  workspaceId: string;
  workspaceRoot: string;
}

export type HostToolHandler = (
  input: Record<string, unknown>,
  context: HostToolContext,
) => Promise<unknown> | unknown;

export type HostToolRegistry = Partial<Record<ReadOnlyTool, HostToolHandler>>;

export class JsonlHostBridge {
  constructor(
    private readonly tools: HostToolRegistry = createDefaultHostTools(),
    private readonly workspaceRoot = process.cwd(),
  ) {}

  async handleLine(line: string): Promise<RuntimeResponse> {
    let request: RuntimeRequest;
    try {
      request = JSON.parse(line) as RuntimeRequest;
    } catch (error) {
      return response("unknown", "error", {
        ok: false,
        error: { code: "PROTOCOL_INVALID_JSON", message: String(error) },
      });
    }
    if (request.protocolVersion !== PROTOCOL_VERSION || typeof request.id !== "string") {
      return response(request.id ?? "unknown", "error", {
        ok: false,
        error: { code: "PROTOCOL_VERSION_UNSUPPORTED", message: "Expected protocolVersion 1." },
      });
    }
    if (request.type === "ping") return response(request.id, "pong");
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
}

export async function runStdio(bridge = new JsonlHostBridge()): Promise<void> {
  const input = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const result = await bridge.handleLine(line);
    stdout.write(`${JSON.stringify(result)}\n`);
  }
}

function createDefaultHostTools(): HostToolRegistry {
  return {
    workspace_get: (_input, context) => {
      const manifest = readManifest(context.workspaceRoot);
      return manifest ? { ...manifest, root: context.workspaceRoot } : { id: context.workspaceId, root: context.workspaceRoot };
    },
    workspace_status: (_input, context) => ({
      workspaceId: context.workspaceId,
      runtime: "pi-runtime",
      core: "rust-contract-ready",
      storage: "sqlite-adapter-pending",
    }),
  };
}

function readManifest(root: string): WorkspaceManifest | null {
  const path = resolve(root, ".llm-wiki", "workspace.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkspaceManifest;
    return value.version === 1 && value.id && value.title ? value : null;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  stderr.write("llm-wiki Pi Runtime JSONL bridge ready\n");
  void runStdio();
}
