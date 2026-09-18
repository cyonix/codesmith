import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoop } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/events.js";
import {
  EpisodicMemory,
  configureSemanticMemory,
  type EmbeddingModel,
  type MemoryEventSink,
} from "../../src/agent/episodic-memory.js";
import { modelCatalog } from "../../src/providers/model-catalog.js";
import { ModelProvider } from "../../src/providers/provider.js";
import { ToolExecutor } from "../../src/workspace/tools.js";
import type {
  AssistantResponse,
  ChatMessage,
  ChatProvider,
  ToolDefinition,
} from "../../src/shared/types.js";

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
void test("requires and emits a bounded task contract before workspace work", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [{ toolCalls: [taskDeclarationCall()] }, { content: "Completed.", toolCalls: [] }],
    false,
  );

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Inspect the project.");

  assert.equal(result, "Completed.");
  assert.equal(provider.requestedTools[0]?.length, 1);
  assert.equal(provider.requestedTools[0]?.[0]?.function.name, "declare_task");
  assert.ok((provider.requestedTools[1]?.length ?? 0) > 1);
  const declaration = events.find((event) => event.type === "task_declared");
  assert.equal(declaration?.type, "task_declared");
  if (declaration?.type === "task_declared") {
    assert.equal(declaration.contract.goal, "Complete the requested test task.");
    assert.deepEqual(declaration.contract.completionCriteria, [
      "The requested result is returned.",
    ]);
    assert.match(declaration.contract.taskId, /^[0-9a-f-]{36}$/);
  }
});
void test("retries a missing task declaration with protocol-safe feedback", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    [
      { content: "I will inspect the project.", toolCalls: [] },
      { toolCalls: [taskDeclarationCall()] },
      { content: "Completed.", toolCalls: [] },
    ],
    false,
  );

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "Inspect the project.",
  );

  assert.equal(result, "Completed.");
  assert.ok(
    provider.messages[1]?.some(
      (message) =>
        message.role === "user" &&
        message.content?.includes("Task declaration is required before any answer"),
    ),
  );
  assert.equal(provider.acceptedCompletions, 3);
});
void test("counts declaration calls across retry attempts", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const firstAttemptCalls = Array.from({ length: 12 }, (_, index) => ({
    id: `invalid-task-${index}`,
    function: {
      name: "declare_task",
      arguments: "{}",
    },
  }));
  const provider = new MockProvider(
    [{ toolCalls: firstAttemptCalls }, { toolCalls: [taskDeclarationCall()] }],
    false,
  );
  const tools = await ToolExecutor.create(root, true);

  await assert.rejects(
    () => new AgentLoop(provider, tools).run("Inspect the project."),
    /exceeded the maximum number of tool calls during task declaration/,
  );
  assert.equal(provider.acceptedCompletions, 1);
});
void test("does not execute mixed declaration and workspace calls", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "read-1",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
          taskDeclarationCall(),
        ],
      },
      { content: "I could not declare the task.", toolCalls: [] },
    ],
    false,
  );

  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  );
  await assert.rejects(
    () => loop.run("Inspect the project."),
    /could not declare a valid task contract/,
  );
  assert.equal(
    events.some((event) => event.type === "tool_proposed"),
    false,
  );
  assert.ok(provider.messages[1]?.filter((message) => message.role === "tool").length === 2);
});
void test("rejects a later task declaration without workspace lifecycle events", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [
      { toolCalls: [taskDeclarationCall()] },
      { toolCalls: [taskDeclarationCall("second")] },
      { content: "Completed.", toolCalls: [] },
    ],
    false,
  );

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Inspect the project.");

  assert.equal(result, "Completed.");
  assert.equal(events.filter((event) => event.type === "task_declared").length, 1);
  assert.equal(
    events.some((event) => event.type === "tool_proposed"),
    false,
  );
  assert.ok(
    provider.messages[2]?.some(
      (message) =>
        message.role === "tool" && message.content?.includes("immutable for this submission"),
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
    provider.messages.some((messages) =>
      messages.some(
        (message) => message.role === "user" && message.content?.includes("standalone hello world"),
      ),
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
  const confirmationRequest = provider.messages.find((messages) =>
    messages.some((message) => message.role === "user" && message.content === "yes"),
  );
  assert.ok(confirmationRequest);
  assert.ok(
    confirmationRequest.some(
      (message) =>
        message.role === "system" && message.content?.includes("brief reply such as 'yes'"),
    ),
  );
  assert.ok(
    confirmationRequest.some(
      (message) =>
        message.role === "assistant" && message.content?.includes("remove HelloWorld.swift"),
    ),
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
  const provider = new MockProvider([{ toolCalls }], false);
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

  const initialMessages = provider.messages[1] ?? [];
  const retrievedIndex = initialMessages.findIndex(
    (message) => message.role === "user" && message.content?.includes("Retrieved episodic data"),
  );
  const promptIndex = initialMessages.findIndex(
    (message) => message.role === "user" && message.content === "Inspect the project.",
  );
  assert.ok(retrievedIndex > promptIndex);
  assert.match(
    initialMessages[retrievedIndex - 1]?.content ?? "",
    /untrusted retrieved historical data/,
  );
  assert.equal(
    provider.messages[2]?.some((message) => message.content?.includes("Retrieved episodic data")),
    false,
  );
});

void test("does not replay consumed Gemini tool results after history compaction", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const model = modelCatalog.find((entry) => entry.protocol === "gemini");
  assert.ok(model);
  const requestBodies: string[] = [];
  const provider = new ModelProvider({ model, apiKey: "test-key" }, (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a string request body.");
    requestBodies.push(init.body);
    switch (requestBodies.length) {
      case 1:
      case 4:
        return Promise.resolve(
          Response.json({
            id: `interaction-${requestBodies.length}`,
            steps: [
              {
                type: "function_call",
                id: `task-${requestBodies.length}`,
                name: "declare_task",
                arguments: {
                  goal: "Inspect the project.",
                  completionCriteria: ["The requested result is returned."],
                },
              },
            ],
          }),
        );
      case 2:
        return Promise.resolve(
          Response.json({
            id: "interaction-2",
            steps: [
              {
                type: "function_call",
                id: "list-1",
                name: "list_files",
                arguments: {},
              },
            ],
          }),
        );
      case 3:
        return Promise.resolve(
          Response.json({
            id: "interaction-3",
            steps: [{ type: "model_output", content: [{ type: "text", text: "First complete." }] }],
          }),
        );
      default:
        return Promise.resolve(
          Response.json({
            id: "interaction-5",
            steps: [
              { type: "model_output", content: [{ type: "text", text: "Second complete." }] },
            ],
          }),
        );
    }
  });
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  assert.equal(await loop.run("Inspect the project."), "First complete.");
  assert.equal(await loop.run("Inspect it again."), "Second complete.");

  const secondDeclarationPayload = JSON.parse(requestBodies[3] ?? "") as {
    previous_interaction_id: string;
    input: Array<{ type: string; content?: string; call_id?: string }>;
  };
  assert.equal(secondDeclarationPayload.previous_interaction_id, "interaction-3");
  assert.deepEqual(secondDeclarationPayload.input, [
    { type: "user_input", content: "Inspect it again." },
  ]);
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

  const retrieved = provider.messages[4]?.find((message) =>
    message.content?.includes("Retrieved episodic data"),
  )?.content;
  assert.match(retrieved ?? "", /Tool: read_file/);
  assert.match(retrieved ?? "", /"error":/);
  assert.match(retrieved ?? "", /I decided the missing file should be created/);
});

void test("emits redacted provider-request previews before each completion", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider([{ content: "Ready.", toolCalls: [] }]);

  await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Create HelloWorld.swift.");

  const request = events.find((event) => event.type === "provider_request" && event.toolCount > 1);
  assert.equal(request?.type, "provider_request");
  if (request?.type === "provider_request") {
    assert.equal(request.round, 0);
    assert.ok(request.toolCount >= 8);
    assert.ok(
      request.messages.some(
        (message) => message.role === "user" && message.preview.includes("HelloWorld.swift"),
      ),
    );
  }
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

  const secondRequest = events.filter((event) => event.type === "provider_request").at(-1);
  assert.equal(secondRequest?.type, "provider_request");
  if (secondRequest?.type === "provider_request") {
    const toolPreview = secondRequest.messages.find((message) => message.role === "tool")?.preview;
    assert.equal(toolPreview, "[omitted secret file]");
    assert.ok(
      secondRequest.messages.some(
        (message) => message.role === "user" && message.preview.includes("Read the env file."),
      ),
    );
    assert.equal(JSON.stringify(secondRequest.messages).includes("opaque-value"), false);
  }
});

void test("matches reused tool call IDs to their preceding call when previewing results", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "Public file\n");
  await writeFile(path.join(root, ".env"), "FOO=opaque-value\n");
  const events: AgentEvent[] = [];
  const provider = new MockProvider([
    {
      toolCalls: [
        { id: "read-1", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
      ],
    },
    { content: "I read the public file.", toolCalls: [] },
    {
      toolCalls: [{ id: "read-1", function: { name: "read_file", arguments: '{"path":".env"}' } }],
    },
    { content: "I cannot show that file.", toolCalls: [] },
  ]);
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  );

  await loop.run("Read the README.");
  await loop.run("Read the env file.");

  const finalRequest = events.filter((event) => event.type === "provider_request").at(-1);
  assert.equal(finalRequest?.type, "provider_request");
  if (finalRequest?.type === "provider_request") {
    const toolPreviews = finalRequest.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.preview);
    assert.ok(toolPreviews.some((preview) => preview.includes("Public file")));
    assert.ok(toolPreviews.includes("[omitted secret file]"));
    assert.equal(JSON.stringify(finalRequest.messages).includes("opaque-value"), false);
  }
});

void test("omits results when an assistant response reuses a tool call ID", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "Public file\n");
  await writeFile(path.join(root, ".env"), "FOO=opaque-value\n");
  const events: AgentEvent[] = [];
  const provider = new MockProvider([
    {
      toolCalls: [
        { id: "read-1", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
        { id: "read-1", function: { name: "read_file", arguments: '{"path":".env"}' } },
      ],
    },
    { content: "I read the files.", toolCalls: [] },
  ]);

  await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Read the README and env files.");

  const secondRequest = events.filter((event) => event.type === "provider_request").at(-1);
  assert.equal(secondRequest?.type, "provider_request");
  if (secondRequest?.type === "provider_request") {
    const toolPreviews = secondRequest.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.preview);
    assert.deepEqual(toolPreviews.slice(-2), ["[omitted secret file]", "[omitted secret file]"]);
    assert.equal(JSON.stringify(secondRequest.messages).includes("opaque-value"), false);
  }
});

class MockProvider implements ChatProvider {
  readonly messages: ChatMessage[][] = [];
  readonly requestedTools: ToolDefinition[][] = [];
  private index = 0;
  acceptedCompletions = 0;
  constructor(
    private readonly responses: AssistantResponse[],
    private readonly autoDeclare = true,
  ) {}
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.messages.push([...messages]);
    this.requestedTools.push(tools);
    if (this.autoDeclare && tools.length === 1 && tools[0]?.function.name === "declare_task") {
      return Promise.resolve({
        toolCalls: [
          {
            id: "task-1",
            function: {
              name: "declare_task",
              arguments: JSON.stringify({
                goal: "Complete the requested test task.",
                completionCriteria: ["The requested result is returned."],
              }),
            },
          },
        ],
      });
    }
    const response = this.responses[this.index++];
    if (!response) throw new Error("Mock provider exhausted.");
    return Promise.resolve(response);
  }

  acceptCompletion(): void {
    this.acceptedCompletions += 1;
  }
}

function taskDeclarationCall(suffix = ""): {
  id: string;
  function: { name: string; arguments: string };
} {
  return {
    id: `task-${suffix || "1"}`,
    function: {
      name: "declare_task",
      arguments: JSON.stringify({
        goal: suffix ? `Complete the ${suffix} test task.` : "Complete the requested test task.",
        completionCriteria: ["The requested result is returned."],
      }),
    },
  };
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
