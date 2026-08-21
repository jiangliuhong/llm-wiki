import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntimeServer,
  ALLOWED_TOOLS,
  HostToolBridge,
  PROTOCOL_VERSION,
} from "../dist/index.js";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "llm-wiki-pi-test-"));
}

function sessionNewRequest(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: "new-1",
    type: "session_new",
    workspaceId: "workspace-1",
    workspaceRoot: "/tmp/example-workspace",
    model: { provider: "anthropic", id: "claude-sonnet-4-5", apiKey: "test-key" },
    ...overrides,
  };
}

test("AgentRuntimeServer answers ping using protocol v2", async () => {
  const server = new AgentRuntimeServer(() => {});
  const result = await server.handleLine(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "ping-1", type: "ping" }),
  );
  assert.deepEqual(result, {
    protocolVersion: PROTOCOL_VERSION,
    id: "ping-1",
    type: "pong",
    ok: true,
  });
});

test("AgentRuntimeServer rejects unsupported protocol versions", async () => {
  const server = new AgentRuntimeServer(() => {});
  const result = await server.handleLine(
    JSON.stringify({ protocolVersion: "1", id: "ping-old", type: "ping" }),
  );
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, "PI_PROTOCOL_ERROR");
});

test("session_new without credentials returns PI_MODEL_NOT_CONFIGURED", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const server = new AgentRuntimeServer(() => {});
  const result = await server.handleLine(
    JSON.stringify(
      sessionNewRequest({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } }),
    ),
  );
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, "PI_MODEL_NOT_CONFIGURED");
});

test("session lifecycle: new, list, get snapshot, fork, delete", async () => {
  const root = tempWorkspace();
  const events = [];
  const server = new AgentRuntimeServer((msg) => {
    events.push(msg);
  });

  // 1. Create session
  const created = await server.handleLine(
    JSON.stringify(sessionNewRequest({ id: "new-1", title: "KB Q&A", workspaceRoot: root })),
  );
  assert.equal(created?.ok, true, JSON.stringify(created));
  const sessionId = created.output.sessionId;
  assert.equal(created.output.title, "KB Q&A");

  // 2. Metadata was written to disk without apiKey
  const metaIndex = JSON.parse(
    readFileSync(join(root, ".llm-wiki", "pi-sessions", "index.json"), "utf8"),
  );
  assert.equal(metaIndex[sessionId].title, "KB Q&A");
  assert.equal(metaIndex[sessionId].model.apiKey, undefined, "apiKey should never be persisted on disk");

  // 3. List sessions
  const listed = await server.handleLine(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "list-1", type: "session_list", workspaceRoot: root }),
  );
  assert.equal(listed?.ok, true);
  assert.equal(listed.output.length, 1);
  assert.equal(listed.output[0].sessionId, sessionId);

  // 4. Get snapshot
  const snapshot = await server.handleLine(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "get-1", type: "session_get", sessionId, workspaceRoot: root }),
  );
  assert.equal(snapshot?.ok, true);
  assert.equal(snapshot.output.sessionId, sessionId);
  assert.ok(Array.isArray(snapshot.output.messages));

  // 5. Fork session
  const forked = await server.handleLine(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "fork-1", type: "session_fork", sessionId, title: "Forked Session" }),
  );
  assert.equal(forked?.ok, true);
  assert.equal(forked.output.title, "Forked Session");
  assert.notEqual(forked.output.sessionId, sessionId);

  // 6. Delete original session
  const deleted = await server.handleLine(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: "del-1", type: "session_delete", sessionId, workspaceRoot: root }),
  );
  assert.equal(deleted?.ok, true);

  // 7. Verify deletion from disk
  const metaAfter = JSON.parse(
    readFileSync(join(root, ".llm-wiki", "pi-sessions", "index.json"), "utf8"),
  );
  assert.equal(metaAfter[sessionId], undefined);
});

test("HostToolBridge dispatches tool_request and handles tool_result", async () => {
  const toolRequests = [];
  const bridge = new HostToolBridge((req) => {
    toolRequests.push(req);
  });

  const scope = {
    sessionId: "s1",
    workspaceId: "w1",
    workspaceRoot: "/path/to/root",
  };

  // Start tool execution in background
  const toolPromise = bridge.executeTool(scope, "document_search", "call-1", { query: "rust", limit: 5 });

  assert.equal(toolRequests.length, 1);
  assert.equal(toolRequests[0].type, "tool_request");
  assert.equal(toolRequests[0].tool, "document_search");
  assert.equal(toolRequests[0].toolCallId, "call-1");
  assert.deepEqual(toolRequests[0].input, { query: "rust", limit: 5 });

  // Simulate Host responding with tool_result
  const handled = bridge.handleToolResult({
    protocolVersion: PROTOCOL_VERSION,
    id: toolRequests[0].id,
    type: "tool_result",
    toolCallId: "call-1",
    ok: true,
    output: [{ id: 1, path: "wiki/index.md" }],
  });

  assert.equal(handled, true);
  const result = await toolPromise;
  assert.deepEqual(result, [{ id: 1, path: "wiki/index.md" }]);
});

test("HostToolBridge rejects non-whitelisted tools", async () => {
  const bridge = new HostToolBridge(() => {});
  const scope = { sessionId: "s1", workspaceId: "w1", workspaceRoot: "/root" };

  await assert.rejects(
    async () => {
      await bridge.executeTool(scope, "bash_exec", "call-99", { cmd: "rm -rf /" });
    },
    (err) => {
      assert.equal(err.code, "PI_TOOL_NOT_ALLOWED");
      return true;
    },
  );
});

test("HostToolBridge builds custom tools for Pi SDK", async () => {
  const toolRequests = [];
  const bridge = new HostToolBridge((req) => {
    toolRequests.push(req);
  });

  const customTools = bridge.buildCustomTools({
    sessionId: "session-abc",
    workspaceId: "ws-1",
    workspaceRoot: "/ws-root",
  });

  assert.equal(customTools.length, ALLOWED_TOOLS.length);
  const searchTool = customTools.find((t) => t.name === "document_search");
  assert.ok(searchTool);
  const draftCreateTool = customTools.find((t) => t.name === "document_draft_create");
  assert.ok(draftCreateTool);

  const execPromise = searchTool.execute("call-10", { query: "test" }, undefined, undefined, undefined);

  assert.equal(toolRequests.length, 1);
  bridge.handleToolResult({
    protocolVersion: PROTOCOL_VERSION,
    id: toolRequests[0].id,
    type: "tool_result",
    toolCallId: "call-10",
    ok: true,
    output: { count: 1 },
  });

  const execResult = await execPromise;
  assert.deepEqual(JSON.parse(execResult.content[0].text), { count: 1 });
});

test("HostToolBridge dispatches document_draft_create request", async () => {
  const toolRequests = [];
  const bridge = new HostToolBridge((req) => {
    toolRequests.push(req);
  });

  const scope = {
    sessionId: "s1",
    workspaceId: "w1",
    workspaceRoot: "/path/to/root",
  };

  const draftInput = {
    targetPath: "wiki/agent.md",
    generatedContent: "# Agent Overview\n\nContent here.",
    operationType: "create",
    sourceCitations: ["wiki/welcome.md"],
  };

  const draftPromise = bridge.executeTool(scope, "document_draft_create", "call-draft-1", draftInput);

  assert.equal(toolRequests.length, 1);
  assert.equal(toolRequests[0].tool, "document_draft_create");
  assert.equal(toolRequests[0].toolCallId, "call-draft-1");
  assert.deepEqual(toolRequests[0].input, draftInput);

  bridge.handleToolResult({
    protocolVersion: PROTOCOL_VERSION,
    id: toolRequests[0].id,
    type: "tool_result",
    toolCallId: "call-draft-1",
    ok: true,
    output: {
      draftId: "draft-123456",
      targetPath: "wiki/agent.md",
      status: "pending",
    },
  });

  const res = await draftPromise;
  assert.deepEqual(res, {
    draftId: "draft-123456",
    targetPath: "wiki/agent.md",
    status: "pending",
  });
});

