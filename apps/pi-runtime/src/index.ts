#!/usr/bin/env node

import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stdin, stdout, stderr } from "node:process";
import { HostToolBridge } from "./bridge.js";
import {
  createResponse,
  type HostToRuntimeMessage,
  PROTOCOL_VERSION,
  type ReadyMessage,
  type RuntimeToHostMessage,
} from "./protocol.js";
import { SessionRegistry } from "./registry.js";
import { SessionHostError } from "./wrapper.js";

export class AgentRuntimeServer {
  private readonly bridge: HostToolBridge;
  private readonly registry: SessionRegistry;

  constructor(
    private readonly sendToHost: (message: RuntimeToHostMessage) => void = (msg) => {
      stdout.write(`${JSON.stringify(msg)}\n`);
    },
  ) {
    this.bridge = new HostToolBridge((toolReq) => {
      this.sendToHost(toolReq);
    });

    this.registry = new SessionRegistry(this.bridge, (envelope) => {
      this.sendToHost(envelope);
    });
  }

  getRegistry(): SessionRegistry {
    return this.registry;
  }

  getBridge(): HostToolBridge {
    return this.bridge;
  }

  async handleLine(line: string): Promise<RuntimeToHostMessage | null> {
    let msg: HostToRuntimeMessage;
    try {
      msg = JSON.parse(line) as HostToRuntimeMessage;
    } catch (err) {
      return createResponse("unknown", false, undefined, {
        code: "PI_PROTOCOL_ERROR",
        message: `Invalid JSON payload: ${String(err)}`,
      });
    }

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      return createResponse((msg as { id?: string }).id ?? "unknown", false, undefined, {
        code: "PI_PROTOCOL_ERROR",
        message: `Expected protocolVersion "${PROTOCOL_VERSION}", received "${(msg as { protocolVersion?: string }).protocolVersion}".`,
      });
    }

    if (msg.type === "tool_result") {
      this.bridge.handleToolResult(msg);
      return null;
    }

    if (msg.type === "ping") {
      return { protocolVersion: PROTOCOL_VERSION, id: msg.id, type: "pong", ok: true };
    }

    try {
      switch (msg.type) {
        case "models_list": {
          const models = await this.registry.listAvailableModels();
          return createResponse(msg.id, true, models);
        }

        case "session_new": {
          const summary = await this.registry.newSession(msg);
          return createResponse(msg.id, true, summary);
        }

        case "session_list": {
          const list = await this.registry.list(msg.workspaceId, msg.workspaceRoot);
          return createResponse(msg.id, true, list);
        }

        case "session_get": {
          const snapshot = await this.registry.getSnapshot(msg.sessionId, msg.workspaceRoot);
          return createResponse(msg.id, true, snapshot);
        }

        case "session_prompt": {
          const wrapper = await this.registry.getSession(
            msg.sessionId,
            msg.workspaceRoot,
            msg.model,
          );
          const outcome = await wrapper.sendPrompt(msg.text, msg.runId);
          return createResponse(msg.id, true, outcome);
        }

        case "session_cancel": {
          await this.registry.cancel(msg.sessionId);
          return createResponse(msg.id, true, { cancelled: true });
        }

        case "session_compact": {
          await this.registry.compact(msg.sessionId, msg.workspaceRoot);
          return createResponse(msg.id, true, { compacted: true });
        }

        case "session_fork": {
          const summary = await this.registry.fork(msg.sessionId, msg.title);
          return createResponse(msg.id, true, summary);
        }

        case "session_delete": {
          await this.registry.delete(msg.sessionId, msg.workspaceRoot);
          return createResponse(msg.id, true, { deleted: true });
        }

        case "runtime_shutdown": {
          this.registry.shutdownAll();
          return createResponse(msg.id, true, { shutdown: true });
        }

        default: {
          return createResponse((msg as { id?: string }).id ?? "unknown", false, undefined, {
            code: "PI_PROTOCOL_ERROR",
            message: `Unknown request type: ${(msg as { type?: string }).type}`,
          });
        }
      }
    } catch (err) {
      if (err instanceof SessionHostError) {
        return createResponse(
          msg.id,
          false,
          undefined,
          err.toAgentError(
            (msg as { sessionId?: string }).sessionId,
            (msg as { runId?: string }).runId,
          ),
        );
      }
      return createResponse(msg.id, false, undefined, {
        code: "PI_SESSION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        sessionId: (msg as { sessionId?: string }).sessionId,
        runId: (msg as { runId?: string }).runId,
      });
    }
  }

  startStdio(): void {
    const readyMsg: ReadyMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "ready",
    };
    this.sendToHost(readyMsg);

    const rl = createInterface({ input: stdin, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      void this.handleLine(trimmed)
        .then((response) => {
          if (response) {
            this.sendToHost(response);
          }
        })
        .catch((err) => {
          stderr.write(`[AgentRuntimeServer] unhandled error in handleLine: ${String(err)}\n`);
        });
    });

    rl.on("close", () => {
      this.registry.shutdownAll();
    });
  }
}

export { HostToolBridge } from "./bridge.js";
export { AgentSessionWrapper, SessionHostError, assistantOutcomeOf } from "./wrapper.js";
export { SessionRegistry } from "./registry.js";
export * from "./protocol.js";

// Check if running as main CLI script
const entryUrl = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
  } catch {
    return "";
  }
})();

if (import.meta.url === entryUrl) {
  stderr.write("llm-wiki Pi Agent Runtime v2 starting...\n");
  const server = new AgentRuntimeServer();
  server.startStdio();
}
