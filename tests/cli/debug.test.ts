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
    }),
    "[goal] Create HelloWorld.swift. replaced=false tests=1",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "create-1",
        function: { name: "create_file", arguments: '{"path":"HelloWorld.swift"}' },
      },
    }),
    '[tool] [start] create_file {"path":"HelloWorld.swift"}',
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_finished",
      call: {
        id: "create-1",
        function: { name: "create_file", arguments: '{"path":"HelloWorld.swift"}' },
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
        id: "read-env",
        function: { name: "read_file", arguments: '{"path":".env"}' },
      },
    }),
    "[tool] [start] read_file [omitted secret file]",
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
