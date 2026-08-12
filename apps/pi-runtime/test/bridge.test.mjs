import test from "node:test";
import assert from "node:assert/strict";
import { JsonlHostBridge } from "../dist/index.js";

test("Pi bridge answers ping using protocol v1", async () => {
  const bridge = new JsonlHostBridge({}, "/tmp/example-workspace");
  const result = await bridge.handleLine(
    JSON.stringify({ protocolVersion: "1", id: "ping-1", type: "ping" }),
  );
  assert.deepEqual(result, {
    protocolVersion: "1",
    id: "ping-1",
    type: "pong",
    ok: true,
  });
});

test("Pi bridge rejects tools outside the read-only allowlist", async () => {
  const bridge = new JsonlHostBridge({}, "/tmp/example-workspace");
  const result = await bridge.handleLine(
    JSON.stringify({
      protocolVersion: "1",
      id: "tool-1",
      type: "tool_call",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      tool: "document_write",
      input: {},
    }),
  );
  assert.equal(result.type, "tool_result");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PI_TOOL_NOT_ALLOWED");
});

test("Pi bridge returns a structured error for unavailable Core tools", async () => {
  const bridge = new JsonlHostBridge({}, "/tmp/example-workspace");
  const result = await bridge.handleLine(
    JSON.stringify({
      protocolVersion: "1",
      id: "tool-2",
      type: "tool_call",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      tool: "document_relations",
      input: { documentId: "doc-1" },
    }),
  );
  assert.equal(result.error?.code, "CORE_TOOL_NOT_CONFIGURED");
});
