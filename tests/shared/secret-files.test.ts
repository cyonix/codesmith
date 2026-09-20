import assert from "node:assert/strict";
import test from "node:test";
import {
  argumentsReferenceSecretPath,
  resultContainsSensitiveDiff,
  touchesSecretFile,
} from "../../src/shared/secret-files.js";

void test("accepts only exact schemas for known tool payloads", () => {
  const validPayloads: ReadonlyArray<readonly [string, object]> = [
    ["list_files", {}],
    ["list_files", { path: "src" }],
    ["list_files", { path: "src", offset: 200 }],
    ["search_files", { query: "needle" }],
    ["search_files", { query: "needle", path: "src" }],
    ["read_file", { path: "README.md" }],
    ["read_file", { path: "README.md", start_line: 10 }],
    ["create_file", { path: "note.txt", content: "note" }],
    ["delete_file", { path: "note.txt" }],
    ["apply_patch", { path: "note.txt", expected_content: "old", replacement: "new" }],
    ["git_status", {}],
    ["git_diff", {}],
  ];

  for (const [toolName, argumentsValue] of validPayloads) {
    assert.equal(touchesSecretFile(toolName, JSON.stringify(argumentsValue)), false, toolName);
  }
});

void test("omits every run_command payload before command-policy rejection", () => {
  assert.equal(
    touchesSecretFile("run_command", JSON.stringify({ command: "curl https://example.test" })),
    true,
  );
});

void test("treats unknown and schema-invalid tool payloads as sensitive", () => {
  const invalidPayloads: ReadonlyArray<readonly [string, object]> = [
    ["git_status", { note: "FOO=opaque-value" }],
    ["git_diff", { path: "README.md" }],
    ["list_files", { path: "src", extra: "opaque-value" }],
    ["search_files", { query: "needle", path: 1 }],
    ["read_file", {}],
    ["read_file", { path: "" }],
    ["read_file", { path: "README.md", start_line: 0 }],
    ["list_files", { offset: -1 }],
    ["delete_file", { path: "README.md", start_line: 1 }],
    ["create_file", { path: "note.txt", content: "" }],
    ["list_files", { path: "" }],
    ["create_file", { path: "note.txt", content: "note", mode: "0600" }],
    ["delete_file", { path: 1 }],
    ["apply_patch", { path: "note.txt", expected_content: "old" }],
    ["run_command", { command: "npm test", note: "opaque-value" }],
    ["unknown_tool", { note: "opaque-value" }],
  ];

  for (const [toolName, argumentsValue] of invalidPayloads) {
    assert.equal(touchesSecretFile(toolName, JSON.stringify(argumentsValue)), true, toolName);
  }
});

void test("treats duplicate JSON object keys as sensitive", () => {
  assert.equal(
    touchesSecretFile(
      "create_file",
      '{"path":"note.txt","content":"opaque-secret","content":"safe"}',
    ),
    true,
  );
  assert.equal(
    touchesSecretFile(
      "create_file",
      '{"path":"note.txt","content":"opaque-secret","\\u0063ontent":"safe"}',
    ),
    true,
  );
  assert.equal(
    touchesSecretFile("create_file", JSON.stringify({ path: "note.txt", content: "note" })),
    false,
  );
});

void test("detects conventional secret paths without fail-closed logging rules", () => {
  assert.equal(argumentsReferenceSecretPath('{"path":".env.production"}'), true);
  assert.equal(argumentsReferenceSecretPath('{"path":"README.md"}'), false);
  assert.equal(argumentsReferenceSecretPath("{"), false);
});

void test("treats spaced credential labels in diffs as sensitive", () => {
  assert.equal(
    resultContainsSensitiveDiff(JSON.stringify({ stdout: "+API key: private-value" })),
    true,
  );
  assert.equal(
    resultContainsSensitiveDiff(JSON.stringify({ stdout: "-Private key = private-value" })),
    true,
  );
});
