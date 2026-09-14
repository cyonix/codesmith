import assert from "node:assert/strict";
import test from "node:test";
import { touchesSecretFile } from "../../src/shared/secret-files.js";

void test("accepts only exact schemas for known tool payloads", () => {
  const validPayloads: ReadonlyArray<readonly [string, object]> = [
    ["list_files", {}],
    ["list_files", { path: "src" }],
    ["search_files", { query: "needle" }],
    ["search_files", { query: "needle", path: "src" }],
    ["read_file", { path: "README.md" }],
    ["create_file", { path: "note.txt", content: "note" }],
    ["delete_file", { path: "note.txt" }],
    ["apply_patch", { path: "note.txt", expected_content: "old", replacement: "new" }],
    ["git_status", {}],
    ["git_diff", {}],
    ["run_command", { command: "npm test" }],
    ["state_goal", { summary: "Run tests", completion_criteria: ["The test suite passes"] }],
  ];

  for (const [toolName, argumentsValue] of validPayloads) {
    assert.equal(touchesSecretFile(toolName, JSON.stringify(argumentsValue)), false, toolName);
  }
});

void test("treats unknown and schema-invalid tool payloads as sensitive", () => {
  const invalidPayloads: ReadonlyArray<readonly [string, object]> = [
    ["git_status", { note: "FOO=opaque-value" }],
    ["git_diff", { path: "README.md" }],
    ["list_files", { path: "src", extra: "opaque-value" }],
    ["search_files", { query: "needle", path: 1 }],
    ["read_file", {}],
    ["create_file", { path: "note.txt", content: "note", mode: "0600" }],
    ["delete_file", { path: 1 }],
    ["apply_patch", { path: "note.txt", expected_content: "old" }],
    ["run_command", { command: "npm test", note: "opaque-value" }],
    ["state_goal", { summary: "Run tests", completion_criteria: [], note: "opaque-value" }],
    ["unknown_tool", { note: "opaque-value" }],
  ];

  for (const [toolName, argumentsValue] of invalidPayloads) {
    assert.equal(touchesSecretFile(toolName, JSON.stringify(argumentsValue)), true, toolName);
  }
});
