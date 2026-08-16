import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
