import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent } from "../../src/agent/events.js";
import { AgentLoop } from "../../src/agent/loop.js";
import {
  EpisodicMemory,
  configureSemanticMemory,
  type EmbeddingModel,
  type MemoryEventSink,
} from "../../src/agent/episodic-memory.js";
import { ToolExecutor } from "../../src/workspace/tools.js";
import type { AssistantResponse, ChatMessage, ChatProvider } from "../../src/shared/types.js";

void test("tool loop reads a file using a mocked provider", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "Hello from TypeScript");
  const provider = new MockProvider([
    {
      toolCalls: [
        { id: "read-1", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
      ],
    },
    { content: "The README contains a TypeScript greeting.", toolCalls: [] },
  ]);
  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "What is in the README?",
  );
  assert.equal(result, "The README contains a TypeScript greeting.");
  assert.ok(
    provider.messages
      .flat()
      .some(
        (message) => message.role === "tool" && message.content?.includes("Hello from TypeScript"),
      ),
  );
});
void test("tool loop retains prior prompts and creates the first project file", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    { content: "What should I name the file?", toolCalls: [] },
    {
      toolCalls: [
        stateGoalCall(),
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
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await loop.run("Create a standalone hello world program.");
  const result = await loop.run("Name it HelloWorld.swift and proceed.");

  assert.equal(result, "Created HelloWorld.swift.");
  assert.equal(
    await (await import("node:fs/promises")).readFile(path.join(root, "HelloWorld.swift"), "utf8"),
    'print("Hello, World!")\n',
  );
  assert.ok(
    provider.messages[1].some(
      (message) => message.role === "user" && message.content?.includes("standalone hello world"),
    ),
  );
});
void test("tool loop interprets yes as confirmation of the preceding file-removal question", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "HelloWorld.swift"), 'print("Hello, World!")\n');
  await writeFile(path.join(root, "PrintPrimes.swift"), "print([2, 3, 5])\n");
  const provider = new MockProvider([
    {
      content: "I created PrintPrimes.swift. Would you like me to remove HelloWorld.swift?",
      toolCalls: [],
    },
    {
      toolCalls: [
        stateGoalCall("goal-delete", "Remove HelloWorld.swift.", [
          "HelloWorld.swift no longer exists.",
        ]),
        {
          id: "delete-1",
          function: { name: "delete_file", arguments: '{"path":"HelloWorld.swift"}' },
        },
      ],
    },
    { content: "Removed HelloWorld.swift.", toolCalls: [] },
  ]);
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await loop.run("Rename the Hello World program to PrintPrimes.swift.");
  const result = await loop.run("yes");

  assert.equal(result, "Removed HelloWorld.swift.");
  await assert.rejects(() => readFile(path.join(root, "HelloWorld.swift")));
  assert.equal(await readFile(path.join(root, "PrintPrimes.swift"), "utf8"), "print([2, 3, 5])\n");
  assert.ok(
    provider.messages[1].some(
      (message) =>
        message.role === "system" && message.content?.includes("brief reply such as 'yes'"),
    ),
  );
  assert.ok(
    provider.messages[1].some(
      (message) =>
        message.role === "assistant" && message.content?.includes("remove HelloWorld.swift"),
    ),
  );
  assert.ok(
    provider.messages[1].some((message) => message.role === "user" && message.content === "yes"),
  );
});
void test("tool loop reserves context for a full tool run after prior turns", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const toolResponse: AssistantResponse = {
    toolCalls: [{ id: "list", function: { name: "list_files", arguments: "{}" } }],
  };
  const provider = new MockProvider([
    ...Array.from({ length: 8 }, (_, index) => ({
      content: `Prior response ${index}.`,
      toolCalls: [],
    })),
    ...Array.from({ length: 12 }, () => toolResponse),
    { content: "Completed all tool calls.", toolCalls: [] },
  ]);
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));
  for (let index = 0; index < 8; index += 1) await loop.run(`Prior prompt ${index}.`);

  const result = await loop.run("Inspect the project.");

  assert.equal(result, "Completed all tool calls.");
});
void test("does not accept a provider completion rejected by tool-call limits", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const toolCalls = Array.from({ length: 13 }, (_, index) => ({
    id: `call-${index}`,
    function: { name: "list_files", arguments: "{}" },
  }));
  const provider = new MockProvider([{ toolCalls }]);
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await assert.rejects(
    () => loop.run("Inspect the project."),
    /exceeded the maximum number of tool calls/,
  );

  assert.equal(provider.acceptedCompletions, 0);
});
void test("supplies retrieved memory as untrusted data only for the initial tool round", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    { toolCalls: [{ id: "list", function: { name: "list_files", arguments: "{}" } }] },
    { content: "Completed.", toolCalls: [] },
  ]);
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    new LoopMemoryEvents(),
    { create: () => Promise.resolve(new ConstantEmbeddingModel()) },
    { install: () => Promise.resolve("/fake-model") },
  );
  await memory.initialize(() => Promise.resolve(true));
  await memory.recordAssistant("UNTRUSTED EPISODIC DATA");
  const loop = new AgentLoop(
    provider,
    await ToolExecutor.create(root, true),
    12,
    () => {},
    () => false,
    memory,
  );

  await loop.run("Inspect the project.");

  const initialMessages = provider.messages[0] ?? [];
  const retrievedIndex = initialMessages.findIndex(
    (message) => message.role === "user" && message.content?.includes("Retrieved episodic data"),
  );
  const promptIndex = initialMessages.findIndex(
    (message) => message.role === "user" && message.content === "Inspect the project.",
  );
  assert.ok(retrievedIndex > 0);
  assert.ok(promptIndex > retrievedIndex);
  assert.match(
    initialMessages[retrievedIndex - 1]?.content ?? "",
    /untrusted retrieved historical data/,
  );
  assert.equal(
    provider.messages[1]?.some((message) => message.content?.includes("Retrieved episodic data")),
    false,
  );
});

void test("retrieves prior failed tool outcomes and final decisions", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        {
          id: "missing-file",
          function: { name: "read_file", arguments: '{"path":"missing.md"}' },
        },
      ],
    },
    { content: "I decided the missing file should be created.", toolCalls: [] },
    { content: "I found the earlier outcome.", toolCalls: [] },
  ]);
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    new LoopMemoryEvents(),
    { create: () => Promise.resolve(new ConstantEmbeddingModel()) },
    { install: () => Promise.resolve("/fake-model") },
  );
  await memory.initialize(() => Promise.resolve(true));
  const loop = new AgentLoop(
    provider,
    await ToolExecutor.create(root, true),
    12,
    () => {},
    () => false,
    memory,
  );

  await loop.run("Read missing.md.");
  await loop.run("What happened, and what did you decide?");

  const retrieved = provider.messages[2]?.find((message) =>
    message.content?.includes("Retrieved episodic data"),
  )?.content;
  assert.match(retrieved ?? "", /Tool: read_file/);
  assert.match(retrieved ?? "", /"error":/);
  assert.match(retrieved ?? "", /I decided the missing file should be created/);
});

void test("blocks side-effecting tools until state_goal succeeds", async (context) => {
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
    {
      toolCalls: [
        stateGoalCall(),
        {
          id: "create-2",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
    { content: "Created HelloWorld.swift.", toolCalls: [] },
  ]);
  const events: AgentEvent[] = [];
  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Create HelloWorld.swift.");

  assert.equal(result, "Created HelloWorld.swift.");
  assert.equal(
    await readFile(path.join(root, "HelloWorld.swift"), "utf8"),
    'print("Hello, World!")\n',
  );
  const firstCreate = provider.messages[1]?.find(
    (message) => message.role === "tool" && message.tool_call_id === "create-1",
  );
  assert.match(firstCreate?.content ?? "", /state_goal is required/);
  assert.equal(
    events.some((event) => event.type === "goal_stated" && event.replaced === false),
    true,
  );
});

void test("applies state_goal before other tools in the same round", async (context) => {
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
        stateGoalCall(),
      ],
    },
    { content: "Created HelloWorld.swift.", toolCalls: [] },
  ]);

  await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "Create HelloWorld.swift.",
  );

  assert.equal(
    await readFile(path.join(root, "HelloWorld.swift"), "utf8"),
    'print("Hello, World!")\n',
  );
});

void test("freezes the goal after a successful file edit", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        stateGoalCall(),
        {
          id: "create-1",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
    {
      toolCalls: [stateGoalCall("goal-2", "Change the goal.", ["The goal changed."])],
    },
    { content: "The goal stayed frozen.", toolCalls: [] },
  ]);

  await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "Create HelloWorld.swift.",
  );

  const frozen = provider.messages
    .flat()
    .find((message) => message.role === "tool" && message.tool_call_id === "goal-2");
  assert.match(frozen?.content ?? "", /frozen after the first file edit/);
});

void test("does not freeze the goal after run_command", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        stateGoalCall(),
        { id: "cmd-1", function: { name: "run_command", arguments: '{"command":"npm test"}' } },
      ],
    },
    {
      toolCalls: [
        stateGoalCall("goal-2", "Create HelloWorld.swift after the command.", [
          "HelloWorld.swift exists.",
        ]),
      ],
    },
    { content: "Replaced the goal.", toolCalls: [] },
  ]);
  const events: AgentEvent[] = [];

  await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Run tests, then set a better goal.");

  assert.deepEqual(
    events.filter((event) => event.type === "goal_stated").map((event) => event.replaced),
    [false, true],
  );
});

void test("does not freeze the goal when a file edit is declined", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        stateGoalCall(),
        {
          id: "create-1",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
    {
      toolCalls: [stateGoalCall("goal-2", "Use a different file name.", ["Notes.md exists."])],
    },
    { content: "Replaced the goal after a declined edit.", toolCalls: [] },
  ]);
  const events: AgentEvent[] = [];

  await new AgentLoop(
    provider,
    await ToolExecutor.create(root, false, () => Promise.resolve(false)),
    12,
    (event) => events.push(event),
  ).run("Create HelloWorld.swift.");

  assert.deepEqual(
    events.filter((event) => event.type === "goal_stated").map((event) => event.replaced),
    [false, true],
  );
  await assert.rejects(() => readFile(path.join(root, "HelloWorld.swift")));
});

void test("requires a new goal on each submit", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        stateGoalCall(),
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
    {
      toolCalls: [
        {
          id: "create-2",
          function: {
            name: "create_file",
            arguments: '{"path":"Notes.md","content":"notes\\n"}',
          },
        },
      ],
    },
    { content: "The second submit needed a new goal.", toolCalls: [] },
  ]);
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await loop.run("Create HelloWorld.swift.");
  await loop.run("Create Notes.md.");

  const secondCreate = provider.messages
    .flat()
    .find((message) => message.role === "tool" && message.tool_call_id === "create-2");
  assert.match(secondCreate?.content ?? "", /state_goal is required/);
  await assert.rejects(() => readFile(path.join(root, "Notes.md")));
});

void test("rejects an invalid state_goal payload and leaves gated tools blocked", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([
    {
      toolCalls: [
        {
          id: "goal-bad",
          function: {
            name: "state_goal",
            arguments: '{"summary":"Create HelloWorld.swift.","completion_criteria":[]}',
          },
        },
        {
          id: "create-1",
          function: {
            name: "create_file",
            arguments: '{"path":"HelloWorld.swift","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      ],
    },
    { content: "No file was created.", toolCalls: [] },
  ]);

  await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "Create HelloWorld.swift.",
  );

  const goalResult = provider.messages[1]?.find(
    (message) => message.role === "tool" && message.tool_call_id === "goal-bad",
  );
  const createResult = provider.messages[1]?.find(
    (message) => message.role === "tool" && message.tool_call_id === "create-1",
  );
  assert.match(goalResult?.content ?? "", /completion_criteria must contain 1 to 8/);
  assert.match(createResult?.content ?? "", /state_goal is required/);
  await assert.rejects(() => readFile(path.join(root, "HelloWorld.swift")));
});

void test("omits secret-file tool content from later provider request previews", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "FOO=opaque-value\n");
  const events: AgentEvent[] = [];
  const provider = new MockProvider([
    {
      toolCalls: [{ id: "read-1", function: { name: "read_file", arguments: '{"path":".env"}' } }],
    },
    { content: "I cannot show that file.", toolCalls: [] },
  ]);

  await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Read the env file.");

  const secondRequest = events.filter((event) => event.type === "provider_request").at(1);
  assert.equal(secondRequest?.type, "provider_request");
  if (secondRequest?.type === "provider_request") {
    const toolPreview = secondRequest.messages.find((message) => message.role === "tool");
    assert.equal(toolPreview?.preview, "[omitted secret file]");
    assert.equal(
      secondRequest.messages.some((message) => message.preview.includes("opaque-value")),
      false,
    );
  }
});

function stateGoalCall(
  id = "goal-1",
  summary = "Create HelloWorld.swift.",
  completionCriteria: string[] = ["HelloWorld.swift exists."],
) {
  return {
    id,
    function: {
      name: "state_goal",
      arguments: JSON.stringify({ summary, completion_criteria: completionCriteria }),
    },
  };
}

class MockProvider implements ChatProvider {
  readonly messages: ChatMessage[][] = [];
  private index = 0;
  acceptedCompletions = 0;
  constructor(private readonly responses: AssistantResponse[]) {}
  complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    this.messages.push([...messages]);
    const response = this.responses[this.index++];
    if (!response) throw new Error("Mock provider exhausted.");
    return Promise.resolve(response);
  }

  acceptCompletion(): void {
    this.acceptedCompletions += 1;
  }
}

class ConstantEmbeddingModel implements EmbeddingModel {
  embed(): Promise<number[]> {
    return Promise.resolve([1, 0]);
  }
}

class LoopMemoryEvents implements MemoryEventSink {
  recorded(): void {}
  retrieved(): void {}
  cleared(): void {}
  failed(): void {}
}
