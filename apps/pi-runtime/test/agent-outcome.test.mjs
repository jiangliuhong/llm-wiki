import test from "node:test";
import assert from "node:assert/strict";
import { assistantOutcomeOf } from "../dist/index.js";

function messageEntry(message) {
  return { type: "message", message };
}

function assistant(content, extra = {}) {
  return messageEntry({ role: "assistant", content, ...extra });
}

test("plain assistant text is extracted (array content)", () => {
  const outcome = assistantOutcomeOf([
    messageEntry({ role: "user", content: "hi" }),
    assistant([{ type: "text", text: "Hello" }, { type: "text", text: " there" }], { stopReason: "stop" }),
  ]);
  assert.equal(outcome.text, "Hello there");
  assert.equal(outcome.stopReason, "stop");
  assert.equal(outcome.errorMessage, undefined);
});

test("plain assistant text is extracted (string content)", () => {
  const outcome = assistantOutcomeOf([assistant("hi answer", { stopReason: "stop" })]);
  assert.equal(outcome.text, "hi answer");
});

test("stopReason error carries the provider errorMessage", () => {
  const outcome = assistantOutcomeOf([
    assistant([], { stopReason: "error", errorMessage: "invalid api key" }),
  ]);
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.errorMessage, "invalid api key");
  assert.equal(outcome.text, "");
});

test("error without errorMessage is still surfaced via stopReason", () => {
  const outcome = assistantOutcomeOf([assistant([], { stopReason: "error" })]);
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.errorMessage, undefined);
});

test("successful provider with no text yields empty outcome (empty response)", () => {
  const outcome = assistantOutcomeOf([
    messageEntry({ role: "user", content: "hi" }),
    assistant([], { stopReason: "stop" }),
  ]);
  assert.equal(outcome.text, "");
  assert.equal(outcome.stopReason, "stop");
});

test("partial text before a failure keeps the failure markers", () => {
  const outcome = assistantOutcomeOf([
    assistant([{ type: "text", text: "partial answer" }], { stopReason: "stop" }),
    assistant([{ type: "text", text: "" }], { stopReason: "error", errorMessage: "rate limited" }),
  ]);
  // The last assistant message wins: the runtime maps this to PI_SESSION_FAILED.
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.errorMessage, "rate limited");
});

test("tool-call assistant message followed by a final text answer", () => {
  const outcome = assistantOutcomeOf([
    messageEntry({ role: "user", content: "search docs" }),
    assistant([{ type: "tool_call", id: "t1", name: "document_search" }], { stopReason: "toolUse" }),
    messageEntry({ type: "tool_result", role: "tool", content: "[]" }),
    assistant([{ type: "text", text: "Found 2 docs" }], { stopReason: "stop" }),
  ]);
  assert.equal(outcome.text, "Found 2 docs");
  assert.equal(outcome.stopReason, "stop");
});

test("user abort maps to stopReason aborted", () => {
  const outcome = assistantOutcomeOf([
    assistant([{ type: "text", text: "half" }], { stopReason: "aborted" }),
  ]);
  assert.equal(outcome.stopReason, "aborted");
});

test("non-message entries and user messages are ignored", () => {
  const outcome = assistantOutcomeOf([
    { type: "session_info", title: "t" },
    messageEntry({ role: "user", content: "hi" }),
  ]);
  assert.deepEqual(outcome, { text: "", thinking: "" });
});

test("thinking content is extracted alongside text", () => {
  const outcome = assistantOutcomeOf([
    assistant(
      [
        { type: "thinking", thinking: "Let me consider " },
        { type: "thinking", thinking: "the options." },
        { type: "text", text: "Answer" },
      ],
      { stopReason: "stop" },
    ),
  ]);
  assert.equal(outcome.text, "Answer");
  assert.equal(outcome.thinking, "Let me consider the options.");
});

test("redacted thinking without a text field contributes nothing", () => {
  const outcome = assistantOutcomeOf([
    assistant([{ type: "thinking", thinkingSignature: "opaque" }, { type: "text", text: "ok" }], {
      stopReason: "stop",
    }),
  ]);
  assert.equal(outcome.thinking, "");
  assert.equal(outcome.text, "ok");
});

test("string content yields empty thinking", () => {
  const outcome = assistantOutcomeOf([assistant("plain", { stopReason: "stop" })]);
  assert.equal(outcome.thinking, "");
});
