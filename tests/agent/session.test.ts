import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../../src/agent/session.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { AssistantResponse, ChatProvider } from "../../src/shared/types.js";

void test("session pauses for approval and emits UI-ready lifecycle events", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        {
          id: "create-1",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
    { content: "Created HelloWorld.swift.", toolCalls: [] },
  ]);
  const session = await AgentSession.create({ projectRoot: root, provider });
  const events: AgentEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "approval_requested")
      assert.equal(session.approve(event.requestId, true), true);
  });

  const result = await session.submit("Create HelloWorld.swift.");

  assert.equal(result, "Created HelloWorld.swift.");
  assert.equal(
    await readFile(path.join(root, "HelloWorld.swift"), "utf8"),
    'print("Hello, World!")\n',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "status",
      "tool_proposed",
      "tool_started",
      "status",
      "approval_requested",
      "tool_finished",
      "status",
      "assistant_text",
      "status",
    ],
  );
  assert.equal(events.at(-1)?.type, "status");
  assert.deepEqual(events.at(-1), { type: "status", phase: "complete" });
});

void test("session rejects unknown approval IDs", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const session = await AgentSession.create({
    projectRoot: root,
    provider: new MockProvider([]),
    autoApprove: true,
  });

  assert.equal(session.approve("unknown", true), false);
});

void test("closed sessions reject new prompts", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const session = await AgentSession.create({
    projectRoot: root,
    provider: new MockProvider([]),
    autoApprove: true,
  });
  session.close();

  await assert.rejects(() => session.submit("Create a file."), /session is closed/);
});

void test("closing during approval denies the tool and stops the active run", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        {
          id: "create-1",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
  ]);
  const session = await AgentSession.create({ projectRoot: root, provider });
  session.subscribe((event) => {
    if (event.type === "approval_requested") session.close();
  });

  await assert.rejects(() => session.submit("Create HelloWorld.swift."), /session is closed/);
  await assert.rejects(() => readFile(path.join(root, "HelloWorld.swift")));
});

void test("closing from tool_started prevents an auto-approved edit", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        {
          id: "create-1",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
  ]);
  const session = await AgentSession.create({ projectRoot: root, provider, autoApprove: true });
  session.subscribe((event) => {
    if (event.type === "tool_started") session.close();
  });

  await assert.rejects(() => session.submit("Create HelloWorld.swift."), /session is closed/);
  await assert.rejects(() => readFile(path.join(root, "HelloWorld.swift")));
});

class MockProvider implements ChatProvider {
  private index = 0;

  constructor(private readonly responses: AssistantResponse[]) {}

  complete(): Promise<AssistantResponse> {
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error("Mock provider exhausted.");
    return Promise.resolve(response);
  }
}
