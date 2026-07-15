import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("dist/index.js");

function makeProject() {
  const cwd = mkdtempSync(path.join(tmpdir(), "llm-wiki-cli-test-"));
  const initialized = run(cwd, ["init", "--title", "Test"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("search before index is handled without an unhandled stack trace", () => {
  const cwd = makeProject();
  const result = run(cwd, ["search", "anything"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unable to open database file/);
  assert.doesNotMatch(result.stderr, /at openDatabase/);
});

test("search rejects malformed limits and empty queries", () => {
  const cwd = makeProject();
  for (const value of ["1.5", "2abc", "0", "51"]) {
    const result = run(cwd, ["search", "anything", "--limit", value]);
    assert.equal(result.status, 1, `limit ${value} should fail`);
    assert.match(result.stderr, /Expected an integer between 1 and 50/);
  }

  const empty = run(cwd, ["search", ""]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /must not be empty/);
});
