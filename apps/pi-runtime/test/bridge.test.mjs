import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlHostBridge } from "../dist/index.js";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "llm-wiki-pi-test-"));
}

test("Pi bridge answers ping using protocol v1", async () => {
  const bridge = new JsonlHostBridge({}, "/tmp/example-workspace");
  const [result] = await bridge.handleLine(
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
  const [result] = await bridge.handleLine(
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
  const [result] = await bridge.handleLine(
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

function sessionNewRequest(overrides = {}) {
  return {
    protocolVersion: "1",
    id: "new-1",
    type: "session_new",
    workspaceId: "workspace-1",
    workspaceRoot: "/tmp/example-workspace",
    model: { provider: "anthropic", id: "claude-sonnet-4-5", apiKey: "test-key" },
    ...overrides,
  };
}

test("sessions persist to disk and are restored by a fresh host", async (t) => {
  const root = tempWorkspace();
  const bridge = new JsonlHostBridge({}, root);
  const request = (body) => bridge.handleLine(JSON.stringify(body));

  const [created] = await request(sessionNewRequest({ id: "new-p1", title: "Persisted", workspaceRoot: root }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.output.sessionId;

  // The SDK only writes the JSONL once an assistant message exists, so an
  // unanswered session persists via the metadata index alone.
  const metaIndex = JSON.parse(readFileSync(join(root, ".llm-wiki", "pi-sessions", "index.json"), "utf8"));
  assert.equal(metaIndex[sessionId].title, "Persisted");
  assert.equal(metaIndex[sessionId].model.apiKey, undefined, "api key never persisted");

  // Simulate a sidecar restart: a fresh host lazily restores from disk. API
  // keys are never persisted, so the restart picks credentials up from env.
  process.env.ANTHROPIC_API_KEY = "env-test-key";
  const restarted = new JsonlHostBridge({}, root);
  const [switched] = await restarted.handleLine(
    JSON.stringify({ protocolVersion: "1", id: "switch-p1", type: "session_switch", sessionId }),
  );
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.output.sessionId, sessionId);
  assert.equal(switched.output.title, "Persisted");

  // Deleting removes the metadata entry and any session file.
  const [deleted] = await restarted.handleLine(
    JSON.stringify({ protocolVersion: "1", id: "delete-p1", type: "session_delete", sessionId }),
  );
  assert.equal(deleted.ok, true);
  const metaAfter = JSON.parse(readFileSync(join(root, ".llm-wiki", "pi-sessions", "index.json"), "utf8"));
  assert.equal(metaAfter[sessionId], undefined);
  delete process.env.ANTHROPIC_API_KEY;
});

test("session_new without credentials returns PI_MODEL_NOT_CONFIGURED", async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  const bridge = new JsonlHostBridge({}, "/tmp/example-workspace");
  const [result] = await bridge.handleLine(
    JSON.stringify(
      sessionNewRequest({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } }),
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PI_MODEL_NOT_CONFIGURED");
});

test("session lifecycle: new, list, switch, fork, delete", async (t) => {
  const root = tempWorkspace();
  const callLog = [];
  const bridge = new JsonlHostBridge(
    {
      workspace_get: (input, context) => {
        callLog.push({ tool: "workspace_get", input, context });
        return { ok: true };
      },
    },
    root,
  );
  const request = (body) => bridge.handleLine(JSON.stringify(body));

  const [created] = await request(sessionNewRequest({ id: "new-1", title: "KB Q&A", workspaceRoot: root }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.output.sessionId;
  assert.equal(created.output.title, "KB Q&A");
  assert.equal(created.output.active, true);

  const second = sessionNewRequest({ id: "new-2", title: "Second", workspaceRoot: root });
  const [created2] = await request(second);
  assert.equal(created2.output.active, true);

  const [listed] = await request({ protocolVersion: "1", id: "list-1", type: "session_list" });
  assert.equal(listed.output.length, 2);
  assert.equal(listed.output.filter((s) => s.active).length, 1);
  assert.equal(listed.output.find((s) => s.sessionId === sessionId).active, false);

  const [switched] = await request({
    protocolVersion: "1",
    id: "switch-1",
    type: "session_switch",
    sessionId,
  });
  assert.equal(switched.output.active, true);
  assert.equal(switched.output.sessionId, sessionId);

  const [forked] = await request({
    protocolVersion: "1",
    id: "fork-1",
    type: "session_fork",
    sessionId,
    title: "KB Q&A branch",
  });
  assert.equal(forked.ok, true, JSON.stringify(forked));
  assert.equal(forked.output.title, "KB Q&A branch");
  assert.notEqual(forked.output.sessionId, sessionId);

  const [deleted] = await request({
    protocolVersion: "1",
    id: "delete-1",
    type: "session_delete",
    sessionId,
  });
  assert.equal(deleted.ok, true);
  const [afterDelete] = await request({
    protocolVersion: "1",
    id: "switch-missing",
    type: "session_switch",
    sessionId,
  });
  assert.equal(afterDelete.error?.code, "PI_SESSION_NOT_FOUND");
});

test("host tools are bridged as Pi custom tools", async () => {
  const { buildHostCustomTools } = await import("../dist/index.js");
  const tools = buildHostCustomTools(
    { workspace_status: () => ({ status: "ok" }) },
    { workspaceId: "workspace-1", workspaceRoot: "/tmp/example-workspace" },
  );
  const status = tools.find((tool) => tool.name === "workspace_status");
  assert.ok(status, "workspace_status custom tool exists");
  const result = await status.execute("call-1", {}, undefined, undefined, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { status: "ok" });
});
