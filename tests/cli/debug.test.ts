import assert from "node:assert/strict";
import test from "node:test";
import { formatDebugEvent } from "../../src/cli/debug.js";

void test("formats tagged debug lines for all agent events", () => {
  assert.equal(formatDebugEvent({ type: "status", phase: "thinking" }), "[status] thinking");
  assert.equal(
    formatDebugEvent({ type: "assistant_text", text: "Created HelloWorld.swift." }),
    "[assistant_text] Created HelloWorld.swift.",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_proposed",
      call: {
        id: "create-1",
        function: {
          name: "create_file",
          arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello\\")"}',
        },
      },
    }),
    '[tool_proposed] create_file {"path":"HelloWorld.swift","content":"print(\\"Hello\\")"}',
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
    '[tool_started] create_file {"path":"HelloWorld.swift","content":"print(\\"Hello\\")"}',
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
    '[tool_finished] create_file {"status":"created","path":"HelloWorld.swift"}',
  );
  assert.equal(
    formatDebugEvent({
      type: "approval_requested",
      requestId: "req-1",
      kind: "edit",
      summary: "Create HelloWorld.swift.",
    }),
    "[approval_requested] edit",
  );
  assert.equal(
    formatDebugEvent({
      type: "memory_recorded",
      episodeId: "episode-1",
      kind: "tool",
    }),
    "[memory_recorded] tool episode-1",
  );
  assert.equal(
    formatDebugEvent({
      type: "memory_retrieved",
      episodes: [{ id: "episode-1", kind: "tool", score: 0.9 }],
    }),
    "[memory_retrieved] 1",
  );
  assert.equal(formatDebugEvent({ type: "memory_cleared", count: 3 }), "[memory_cleared] 3");
  assert.equal(
    formatDebugEvent({
      type: "memory_failed",
      phase: "retrieval",
      message: "The local episodic-memory subsystem failed unexpectedly.",
      blocksFutureSubmissions: true,
    }),
    "[memory_failed] retrieval The local episodic-memory subsystem failed unexpectedly.",
  );
  assert.equal(
    formatDebugEvent({
      type: "provider_request",
      round: 0,
      toolCount: 9,
      messages: [
        { role: "system", preview: "You are CodeSmith." },
        { role: "user", preview: "Create HelloWorld.swift." },
      ],
    }),
    [
      "[provider_request] round=0 messages=2 tools=9",
      "[provider_request] [system] You are CodeSmith.",
      "[provider_request] [user] Create HelloWorld.swift.",
    ].join("\n"),
  );
});

void test("redacts credentials and omits secret-file payloads", () => {
  assert.equal(
    formatDebugEvent({
      type: "approval_requested",
      requestId: "req-env",
      kind: "edit",
      summary: 'Create ".env":\n+ FOO=opaque-value',
    }),
    "[approval_requested] edit",
  );
  assert.equal(
    formatDebugEvent({
      type: "error",
      message: "provider failed sk-abcdefghijklmnopqrstuvwxyz",
    }),
    "[error] provider failed [REDACTED]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "forged-log",
        function: { name: "create_file\n[status] complete", arguments: "{}" },
      },
    }),
    "[tool_started] create_file [status] complete [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "invalid-git-status",
        function: { name: "git_status", arguments: '{"note":"FOO=opaque-value"}' },
      },
    }),
    "[tool_started] git_status [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "disallowed-command",
        function: { name: "run_command", arguments: '{"command":"curl https://example.test"}' },
      },
    }),
    "[tool_started] run_command [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "read-env",
        function: { name: "read_file", arguments: '{"path":".env"}' },
      },
    }),
    "[tool_started] read_file [omitted secret file]",
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
    "[tool_started] create_file [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "tool_started",
      call: {
        id: "duplicate-content",
        function: {
          name: "create_file",
          arguments: '{"path":"note.txt","content":"opaque-secret","content":"safe"}',
        },
      },
    }),
    "[tool_started] create_file [omitted secret file]",
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
    "[tool_finished] read_file [omitted secret file]",
  );
  assert.equal(
    formatDebugEvent({
      type: "assistant_text",
      text: "The API key is private-value",
    }),
    "[assistant_text] The API key [REDACTED]",
  );
  for (const type of ["tool_proposed", "tool_started"] as const) {
    const line = formatDebugEvent({
      type,
      call: {
        id: "create-config",
        function: {
          name: "create_file",
          arguments: '{"path":"app.ts","content":"DATABASE_URL=opaque-value"}',
        },
      },
    });
    assert.match(line, new RegExp(`^\\[${type}\\] create_file `));
    assert.match(line, /\[REDACTED\]/);
    assert.doesNotMatch(line, /opaque-value/);
    assert.doesNotMatch(line, /omitted secret file/);
  }
});
