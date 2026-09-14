import assert from "node:assert/strict";
import test from "node:test";
import { formatDebugEvent } from "../../src/cli/debug.js";

void test("formats turn debug lines for status, goal, and tools", () => {
  assert.equal(formatDebugEvent({ type: "status", phase: "thinking" }), "[status] thinking");
  assert.equal(
    formatDebugEvent({
      type: "goal_stated",
      summary: "Create HelloWorld.swift.",
      completionCriteria: ["HelloWorld.swift exists."],
      replaced: false,
      secretTainted: false,
    }),
    "[goal] Create HelloWorld.swift. replaced=false tests=1",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "create-1",
        function: {
          name: "create_file",
          arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello\\")"}',
        },
      },
    }),
    '[tool] [start] create_file {"path":"HelloWorld.swift","content":"print(\\"Hello\\")"}',
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "forged-log",
        function: { name: "create_file\n[status] complete", arguments: "{}" },
      },
    }),
    "[tool] [start] create_file [status] complete [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_finished",
      call: {
        id: "create-1",
        function: {
          name: "create_file",
          arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello\\")"}',
        },
      },
      result: '{"status":"created","path":"HelloWorld.swift"}',
    }),
    '[tool] [done] create_file {"status":"created","path":"HelloWorld.swift"}',
  );
  assert.equal(
    formatDebugEvent({
      type: "provider_request",
      round: 0,
      toolCount: 10,
      secretTainted: false,
      messages: [
        { role: "system", preview: "You are CodeSmith." },
        { role: "user", preview: "Create HelloWorld.swift." },
      ],
    }),
    [
      "[llm] round=0 messages=2 tools=10",
      "[llm] [system] You are CodeSmith.",
      "[llm] [user] Create HelloWorld.swift.",
    ].join("\n"),
  );
});

void test("omits model-controlled previews after secret access", () => {
  const providerPreview = formatDebugEvent({
    type: "provider_request",
    round: 1,
    toolCount: 10,
    secretTainted: true,
    messages: [{ role: "assistant", preview: "FOO=opaque-value" }],
  });
  assert.equal(
    providerPreview,
    "[llm] round=1 messages=1 tools=10\n[llm] [omitted after secret access]",
  );
  const toolPreview = formatDebugEvent({
    type: "tool_started",
    secretTainted: true,
    call: {
      id: "search-secret",
      function: { name: "search_files", arguments: '{"query":"opaque-value"}' },
    },
  });
  assert.equal(toolPreview, "[tool] [start] [omitted after secret access]");
  assert.equal(`${providerPreview}\n${toolPreview}`.includes("opaque-value"), false);
  const goalPreview = formatDebugEvent({
    type: "goal_stated",
    summary: "Use FOO=opaque-value.",
    completionCriteria: ["Complete the secret task."],
    replaced: false,
    secretTainted: true,
  });
  assert.equal(goalPreview, "[goal] [omitted after secret access] replaced=false tests=1");
  assert.equal(goalPreview?.includes("opaque-value"), false);
});

void test("redacts credentials and skips noisy events", () => {
  assert.equal(
    formatDebugEvent({
      type: "error",
      message: "provider failed Bearer tok_secret",
    }),
    "[error] provider failed [REDACTED]",
  );
  assert.equal(
    formatDebugEvent({
      type: "approval_requested",
      requestId: "req-1",
      kind: "edit",
      summary: "Create HelloWorld.swift.",
    }),
    undefined,
  );
  assert.equal(
    formatDebugEvent({ type: "assistant_text", text: "Created HelloWorld.swift." }),
    undefined,
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "invalid-git-status",
        function: { name: "git_status", arguments: '{"note":"FOO=opaque-value"}' },
      },
    }),
    "[tool] [start] git_status [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "disallowed-command",
        function: { name: "run_command", arguments: '{"command":"curl https://example.test"}' },
      },
    }),
    "[tool] [start] run_command [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "read-env",
        function: { name: "read_file", arguments: '{"path":".env"}' },
      },
    }),
    "[tool] [start] read_file [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "malformed-env",
        function: {
          name: "create_file",
          arguments: '{"path":".env","content":"FOO=opaque-value"',
        },
      },
    }),
    "[tool] [start] create_file [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "invalid-secret-target",
        function: {
          name: "create_file",
          arguments: '{"path":123,"content":"FOO=opaque-value"}',
        },
      },
    }),
    "[tool] [start] create_file [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_finished",
      call: {
        id: "read-env",
        function: { name: "read_file", arguments: '{"path":".env"}' },
      },
      result: '{"content":"FOO=opaque-value"}',
    }),
    "[tool] [done] read_file [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_finished",
      call: {
        id: "read-netrc",
        function: { name: "read_file", arguments: '{"path":".netrc"}' },
      },
      result: '{"content":"machine example.com login user password opaque-value"}',
    }),
    "[tool] [done] read_file [omitted secret file]",
  );
});
