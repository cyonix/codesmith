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
void test("does not return an assistant completion twice", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const duplicated =
    "I inspected main.js and started the change.\n\nI inspected main.js and started the change.";
  const provider = new MockProvider([{ content: duplicated, toolCalls: [] }]);
  const events: AgentEvent[] = [];
  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Inspect main.js.");

  assert.equal(result, "I inspected main.js and started the change.");
  assert.deepEqual(
    events.filter((event) => event.type === "assistant_text"),
    [{ type: "assistant_text", text: "I inspected main.js and started the change." }],
  );
});
void test("preserves intentional repeated words in an assistant completion", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([{ content: "no no", toolCalls: [] }]);

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "Repeat the word.",
  );

  assert.equal(result, "no no");
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
  assert.equal(provider.requestedTools[0]?.length, 2);
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
void test("narrows mixed requests before workspace execution", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "task-mixed",
            function: {
              name: "declare_task",
              arguments: JSON.stringify({
                goal: "Explain how to test a TypeScript function.",
                completionCriteria: [
                  'The testing approach is explained without Plan "a"\\b\nvacation.',
                ],
                plan: ['Describe a focused test structure without Plan "a"\\b\nvacation.'],
                excludedRequests: ["Plan", 'Plan "a"\\b\nvacation.'],
              }),
            },
          },
        ],
      },
      { content: "Use a focused unit test.", toolCalls: [] },
    ],
    false,
  );

  assert.equal(
    await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
      events.push(event),
    ).run("Explain TypeScript testing and plan a vacation."),
    "Use a focused unit test.",
  );
  const declaration = events.find((event) => event.type === "task_declared");
  assert.equal(declaration?.type, "task_declared");
  if (declaration?.type === "task_declared")
    assert.deepEqual(declaration.contract.excludedRequests, ["Plan", 'Plan "a"\\b\nvacation.']);
  assert.equal(
    events.some((event) => event.type === "scope_redirected"),
    false,
  );
  assert.equal(
    provider.messages[1]?.some(
      (message) => message.role === "user" && message.content === "Plan a vacation.",
    ),
    false,
  );
  assert.ok(
    provider.messages[1]?.some(
      (message) =>
        message.role === "user" && message.content === "Explain how to test a TypeScript function.",
    ),
  );
  assert.equal(
    provider.messages[1]?.some((message) => {
      const serialized = JSON.stringify(message);
      return (
        serialized.includes('Plan "a"\\b\nvacation.') ||
        serialized.includes(JSON.stringify('Plan "a"\\b\nvacation.')) ||
        serialized.includes("vacation.")
      );
    }),
    false,
  );
});
void test("sanitizes case and Unicode variants of excluded requests", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "task-normalized",
            function: {
              name: "declare_task",
              arguments: JSON.stringify({
                goal: "Explain tests and plan  a cafe\u0301. Also explain ΟΣ and STRASSE.",
                completionCriteria: ["The explanation is complete."],
                plan: ["Explain the test structure."],
                excludedRequests: ["PLAN A CAFÉ.", "ος", "straße"],
              }),
            },
          },
        ],
      },
      { content: "The software-engineering portion is complete.", toolCalls: [] },
    ],
    false,
  );

  assert.equal(
    await new AgentLoop(provider, await ToolExecutor.create(root, true)).run("Explain tests."),
    "The software-engineering portion is complete.",
  );
  assert.equal(
    provider.messages[1]?.find((message) => message.role === "user")?.content,
    "Explain tests and [excluded request omitted] Also explain [excluded request omitted] and [excluded request omitted].",
  );
});
void test("sanitizes bounded large contracts with all exclusions", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const excludedRequests = [
    "unrelated request alpha",
    "unrelated request beta",
    "unrelated request gamma",
    "unrelated request delta",
    "unrelated request epsilon",
    "unrelated request zeta",
    "unrelated request eta",
    "unrelated request theta",
  ];
  const repeatedContext = "engineering context ".repeat(12);
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "task-large",
            function: {
              name: "declare_task",
              arguments: JSON.stringify({
                goal: `${repeatedContext} ${excludedRequests.join(" and ")} ${repeatedContext}`.slice(
                  0,
                  500,
                ),
                completionCriteria: Array.from(
                  { length: 8 },
                  (_, index) =>
                    `${repeatedContext}criterion ${index} ${excludedRequests[index] ?? ""}`,
                ),
                plan: Array.from(
                  { length: 8 },
                  (_, index) => `${repeatedContext}step ${index} ${excludedRequests[index] ?? ""}`,
                ),
                excludedRequests,
              }),
            },
          },
        ],
      },
      { content: "The bounded contract was sanitized.", toolCalls: [] },
    ],
    false,
  );

  await new AgentLoop(provider, await ToolExecutor.create(root, true)).run("Complete the task.");

  const executionMessages = provider.messages[1] ?? [];
  const serializedExecutionMessages = JSON.stringify(executionMessages);
  for (const excludedRequest of excludedRequests)
    assert.equal(serializedExecutionMessages.includes(excludedRequest), false);
  assert.ok(serializedExecutionMessages.includes("[excluded request omitted]"));
});
void test("redirects fully unrelated requests before memory or workspace access", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider([{ toolCalls: [scopeRedirectCall()] }], false);

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("What is the weather?");

  assert.equal(
    result,
    "I can help with software-engineering work, but not with this request. This is not software-engineering work. You can ask instead: Ask how to test a TypeScript function.",
  );
  assert.deepEqual(
    events.filter((event) => event.type === "scope_redirected"),
    [
      {
        type: "scope_redirected",
        reason: "This is not software-engineering work.",
        suggestedRequest: "Ask how to test a TypeScript function.",
      },
    ],
  );
  assert.equal(
    events.some((event) => event.type === "task_declared"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "tool_proposed"),
    false,
  );
  assert.equal(provider.messages.length, 1);
});
void test("compacts consecutive redirects while preserving the latest redirect context", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    Array.from({ length: 12 }, () => ({ toolCalls: [scopeRedirectCall()] })),
    false,
  );
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  for (let index = 0; index < 12; index += 1) {
    assert.match(await loop.run(`Unrelated request ${index}`), /not software-engineering work/);
  }

  assert.ok(provider.messages.every((messages) => messages.length <= 32));
});
void test("reserves history for a routing retry after repeated redirects", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    [
      ...Array.from({ length: 5 }, () => ({ toolCalls: [scopeRedirectCall()] })),
      {
        toolCalls: Array.from({ length: 11 }, (_, index) => ({
          id: `invalid-route-${index}`,
          function: { name: "declare_task", arguments: '{"goal":"Explain tests."}' },
        })),
      },
      { toolCalls: [taskDeclarationCall()] },
      { content: "The retry succeeded.", toolCalls: [] },
    ],
    false,
  );
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  for (let index = 0; index < 5; index += 1) {
    await loop.run(`Unrelated request ${index}`);
  }

  assert.equal(await loop.run("Explain tests."), "The retry succeeded.");
});
void test("preserves Gemini redirect context for a follow-up submission", async (context) => {
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
        return Promise.resolve(
          Response.json({
            id: "redirect-interaction",
            steps: [
              {
                type: "function_call",
                id: "redirect-1",
                name: "redirect_scope",
                arguments: {
                  reason: "This is not software-engineering work.",
                  suggestedRequest: "Ask how to test a TypeScript function.",
                },
              },
            ],
          }),
        );
      case 2:
        return Promise.resolve(
          Response.json({
            id: "invalid-task-interaction",
            steps: [
              {
                type: "function_call",
                id: "invalid-task-1",
                name: "declare_task",
                arguments: {
                  goal: "Explain TypeScript testing.",
                },
              },
            ],
          }),
        );
      case 3:
        return Promise.resolve(
          Response.json({
            id: "task-interaction",
            steps: [
              {
                type: "function_call",
                id: "task-1",
                name: "declare_task",
                arguments: {
                  goal: "Explain TypeScript testing.",
                  completionCriteria: ["The testing approach is explained."],
                  plan: ["Describe a focused test structure."],
                  excludedRequests: [],
                },
              },
            ],
          }),
        );
      default:
        return Promise.resolve(
          Response.json({
            id: "execution-interaction",
            steps: [{ type: "model_output", content: [{ type: "text", text: "Done." }] }],
          }),
        );
    }
  });
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  assert.match(await loop.run("What is the weather?"), /not software-engineering work/);
  assert.equal(await loop.run("Why?"), "Done.");

  const followUpPayload = JSON.parse(requestBodies[1] ?? "") as {
    previous_interaction_id?: string;
    input: Array<{ type: string; content?: string }>;
  };
  assert.equal(followUpPayload.previous_interaction_id, "redirect-interaction");
  assert.deepEqual(followUpPayload.input, [
    {
      type: "function_result",
      name: "redirect_scope",
      call_id: "redirect-1",
      result: [
        {
          type: "text",
          text: '{"status":"redirected","reason":"This is not software-engineering work.","suggestedRequest":"Ask how to test a TypeScript function."}',
        },
      ],
    },
    { type: "user_input", content: "Why?" },
  ]);
  const retryPayload = JSON.parse(requestBodies[2] ?? "") as {
    input: Array<{ type: string; name?: string; call_id?: string }>;
  };
  assert.equal(
    retryPayload.input.some(
      (item) => item.type === "function_result" && item.name === "redirect_scope",
    ),
    false,
  );
  const retryFunctionResult = retryPayload.input.find((item) => item.type === "function_result");
  assert.ok(retryFunctionResult);
  assert.equal(retryFunctionResult.name, "declare_task");
  assert.equal(retryFunctionResult.call_id, "invalid-task-1");
});
void test("revises the plan with evidence before the next workspace action", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "revision-1",
            function: {
              name: "revise_plan",
              arguments: JSON.stringify({
                plan: ["Read the existing file.", "Apply the focused change."],
                reason: "The initial discovery found an existing implementation.",
              }),
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "read-1",
            function: { name: "list_files", arguments: "{}" },
          },
        ],
      },
      { content: "Completed.", toolCalls: [] },
    ],
    true,
  );

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Inspect the project.");

  assert.equal(result, "Completed.");
  assert.deepEqual(
    events.filter((event) => event.type === "plan_revised"),
    [
      {
        type: "plan_revised",
        taskId: events.find((event) => event.type === "task_declared")?.contract.taskId,
        plan: ["Read the existing file.", "Apply the focused change."],
        reason: "The initial discovery found an existing implementation.",
      },
    ],
  );
});
void test("keeps invalid plan revisions paired with their tool results", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "invalid-revision",
            function: {
              name: "revise_plan",
              arguments: JSON.stringify({ plan: [], reason: "The plan changed." }),
            },
          },
        ],
      },
      { toolCalls: [{ id: "list-1", function: { name: "list_files", arguments: "{}" } }] },
      { content: "Completed.", toolCalls: [] },
    ],
    true,
  );

  assert.equal(
    await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
      "Inspect the project.",
    ),
    "Completed.",
  );
  const retryRequest = provider.messages[2];
  assert.ok(retryRequest);
  assert.ok(
    retryRequest.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "invalid-revision" &&
        message.content?.includes("plan must contain"),
    ),
  );
});
void test("allows batched reads but rejects multiple side-effecting calls", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    [
      {
        toolCalls: [
          {
            id: "create-1",
            function: { name: "create_file", arguments: '{"path":"one.txt","content":"1"}' },
          },
          {
            id: "create-2",
            function: { name: "create_file", arguments: '{"path":"two.txt","content":"2"}' },
          },
        ],
      },
      {
        toolCalls: [
          { id: "list-1", function: { name: "list_files", arguments: "{}" } },
          { id: "list-2", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      { content: "Completed.", toolCalls: [] },
    ],
    true,
  );

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true)).run(
    "Create both files.",
  );

  assert.equal(result, "Completed.");
  await assert.rejects(() => readFile(path.join(root, "one.txt")));
  await assert.rejects(() => readFile(path.join(root, "two.txt")));
  assert.ok(
    provider.messages.some((messages) =>
      messages.some(
        (message) =>
          message.role === "tool" &&
          message.content?.includes("more than one side-effecting workspace call"),
      ),
    ),
  );
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
        message.content?.includes("Scope routing is required before any answer"),
    ),
  );
  assert.equal(provider.acceptedCompletions, 3);
});
void test("does not retain retry feedback as the prior user prompt", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider(
    [
      { content: "I will inspect the project.", toolCalls: [] },
      { toolCalls: [taskDeclarationCall()] },
      { content: "First complete.", toolCalls: [] },
      { toolCalls: [taskDeclarationCall("second")] },
      { content: "Second complete.", toolCalls: [] },
    ],
    false,
  );
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  assert.equal(await loop.run("Inspect the project."), "First complete.");
  assert.equal(await loop.run("Inspect it again."), "Second complete.");

  const secondDeclarationRequest = provider.messages.find((messages) =>
    messages.some((message) => message.role === "user" && message.content === "Inspect it again."),
  );
  assert.ok(secondDeclarationRequest);
  assert.ok(
    secondDeclarationRequest?.some(
      (message) => message.role === "user" && message.content === "Inspect the project.",
    ),
  );
  assert.equal(
    secondDeclarationRequest?.some((message) =>
      message.content?.includes("Scope routing is required"),
    ),
    false,
  );
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
    /exceeded the maximum number of tool calls during scope routing/,
  );
  assert.equal(provider.acceptedCompletions, 1);
});
void test("abandons failed declaration state before the next submission", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new FailedDeclarationProvider();
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await assert.rejects(() => loop.run("Old task."), /could not route the request/);
  assert.equal(await loop.run("New task."), "Completed.");

  const nextDeclarationRequest = provider.messages[2];
  assert.ok(nextDeclarationRequest);
  assert.ok(
    nextDeclarationRequest?.some(
      (message) => message.role === "user" && message.content === "New task.",
    ),
  );
  assert.equal(
    nextDeclarationRequest?.some(
      (message) => message.role === "user" && message.content === "Old task.",
    ),
    false,
  );
  assert.equal(
    nextDeclarationRequest?.some((message) => message.role === "tool"),
    false,
  );
  assert.equal(provider.rollbackCount, 1);
});
void test("abandons declaration state when memory retrieval fails", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const provider = new MockProvider([{ content: "Recovered.", toolCalls: [] }], true);
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    new LoopMemoryEvents(),
    { create: () => Promise.resolve(new FlakyEmbeddingModel()) },
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

  await assert.rejects(() => loop.run("Old task."), /episodic-memory subsystem failed/);
  memory.clear();
  assert.equal(await loop.run("New task."), "Recovered.");

  const nextDeclarationRequest = provider.messages[1];
  assert.ok(nextDeclarationRequest);
  assert.ok(
    nextDeclarationRequest?.some(
      (message) => message.role === "user" && message.content === "New task.",
    ),
  );
  assert.equal(
    nextDeclarationRequest?.some(
      (message) => message.role === "user" && message.content === "Old task.",
    ),
    false,
  );
  assert.equal(
    nextDeclarationRequest?.some((message) => message.role === "tool"),
    false,
  );
  assert.equal(provider.rollbackCount, 1);
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
  await assert.rejects(() => loop.run("Inspect the project."), /could not route the request/);
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
void test("rejects a later scope redirect without workspace lifecycle events", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [
      { toolCalls: [taskDeclarationCall()] },
      { toolCalls: [scopeRedirectCall()] },
      { content: "Completed.", toolCalls: [] },
    ],
    false,
  );

  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Inspect the project.");

  assert.equal(result, "Completed.");
  assert.equal(events.filter((event) => event.type === "scope_redirected").length, 0);
  assert.equal(
    events.some((event) => event.type === "tool_proposed"),
    false,
  );
  assert.ok(
    provider.messages[2]?.some(
      (message) =>
        message.role === "tool" &&
        message.content?.includes("scope decision is immutable for this submission"),
    ),
  );
});
void test("rejects mixed post-declaration calls without executing workspace tools", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const provider = new MockProvider(
    [
      { toolCalls: [taskDeclarationCall()] },
      {
        toolCalls: [
          taskDeclarationCall("second"),
          { id: "list-1", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      { content: "Completed.", toolCalls: [] },
    ],
    false,
  );
  const result = await new AgentLoop(provider, await ToolExecutor.create(root, true), 12, (event) =>
    events.push(event),
  ).run("Inspect the project.");

  assert.equal(result, "Completed.");
  assert.equal(
    events.some((event) => event.type === "tool_proposed"),
    false,
  );
  const mixedCallErrors = provider.messages[2]
    ?.filter((message) => message.role === "tool")
    .slice(-2);
  assert.equal(mixedCallErrors?.length, 2);
  assert.ok(
    mixedCallErrors?.every(
      (message) =>
        message.role !== "tool" ||
        message.content?.includes("cannot mix declare_task with workspace tools"),
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
  const continuationRequest = provider.messages.find((messages) =>
    messages.some(
      (message) =>
        message.role === "user" &&
        message.content?.includes("Name it HelloWorld.swift and proceed."),
    ),
  );
  assert.ok(
    continuationRequest?.some(
      (message) => message.role === "user" && message.content?.includes("standalone hello world"),
    ),
  );
});
void test("declaration context retains the session-start prompt after history compaction", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const initialPrompt = "write me some surprise code in go";
  const finalPrompt = "What programming language did I ask for first?";
  const provider = new MockProvider(
    Array.from({ length: 10 }, (_, index) => ({
      content: `Completed turn ${index}.`,
      toolCalls: [],
    })),
    true,
    false,
  );
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await loop.run(initialPrompt);
  for (let index = 0; index < 8; index += 1) await loop.run(`Follow-up turn ${index}.`);
  await loop.run(finalPrompt);

  const matchingRequests = provider.messages.filter((messages) =>
    messages.some((message) => message.role === "user" && message.content === finalPrompt),
  );
  const finalDeclarationRequest = matchingRequests.find((messages) =>
    messages.some(
      (message) =>
        message.role === "user" && message.content === `Session-start request:\n${initialPrompt}`,
    ),
  );
  const finalExecutionRequest = matchingRequests.find(
    (messages) => messages !== finalDeclarationRequest,
  );
  assert.ok(finalDeclarationRequest);
  assert.ok(finalExecutionRequest);
  assert.ok(
    finalDeclarationRequest.some(
      (message) =>
        message.role === "user" && message.content === `Session-start request:\n${initialPrompt}`,
    ),
  );
  assert.equal(
    finalExecutionRequest.some(
      (message) =>
        message.role === "user" && message.content === `Session-start request:\n${initialPrompt}`,
    ),
    false,
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
                  plan: ["Inspect the project.", "Report the result."],
                  excludedRequests: [],
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
    { type: "user_input", content: "Session-start request:\nInspect the project." },
    { type: "user_input", content: "Inspect it again." },
  ]);
});
void test("preserves session-start context in Gemini declaration input after compaction", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const model = modelCatalog.find((entry) => entry.protocol === "gemini");
  assert.ok(model);
  const initialPrompt = "write me some surprise code in go";
  const finalPrompt = "What programming language did I ask for first?";
  const requestBodies: string[] = [];
  const provider = new ModelProvider({ model, apiKey: "test-key" }, (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a string request body.");
    requestBodies.push(init.body);
    const requestNumber = requestBodies.length;
    const steps =
      requestNumber % 2 === 1
        ? [
            {
              type: "function_call",
              id: `task-${requestNumber}`,
              name: "declare_task",
              arguments: {
                goal: "Answer the request.",
                completionCriteria: ["The requested result is returned."],
                plan: ["Inspect the project.", "Report the result."],
                excludedRequests: [],
              },
            },
          ]
        : [{ type: "model_output", content: [{ type: "text", text: "Completed." }] }];
    return Promise.resolve(Response.json({ id: `interaction-${requestNumber}`, steps }));
  });
  const loop = new AgentLoop(provider, await ToolExecutor.create(root, true));

  await loop.run(initialPrompt);
  for (let index = 0; index < 3; index += 1) await loop.run(`Follow-up turn ${index}.`);
  await loop.run(finalPrompt);
  await loop.run("What should I do next?");

  const declarationPayloads = requestBodies
    .filter((_body, index) => index % 2 === 0)
    .map((body) => JSON.parse(body) as { input: Array<{ type: string; content?: string }> });
  const recoveredContextPayloads = declarationPayloads.filter((payload) =>
    payload.input.some((input) => input.content === `Session-start request:\n${initialPrompt}`),
  );
  assert.equal(recoveredContextPayloads.length, declarationPayloads.length - 1);
  assert.deepEqual(declarationPayloads.at(-1)?.input, [
    { type: "user_input", content: `Session-start request:\n${initialPrompt}` },
    { type: "user_input", content: "What should I do next?" },
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

  const request = events.find((event) => event.type === "provider_request" && event.toolCount > 2);
  assert.equal(request?.type, "provider_request");
  if (request?.type === "provider_request") {
    assert.equal(request.round, 0);
    assert.ok(request.toolCount >= 8);
    assert.ok(
      request.messages.some(
        (message) => message.role === "user" && message.preview.includes("HelloWorld.swift"),
      ),
    );
    assert.ok(
      request.messages.some(
        (message) =>
          message.role === "system" &&
          message.preview.includes("current user request and fresh tool results"),
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

void test("does not retain prior tool results after a completed turn", async (context) => {
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
    assert.ok(toolPreviews.includes("[omitted secret file]"));
    assert.equal(
      toolPreviews.some((preview) => preview.includes("Public file")),
      false,
    );
    assert.equal(
      finalRequest.messages.some(
        (message) =>
          message.role === "assistant" && message.preview.includes("I read the public file."),
      ),
      false,
    );
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
  readonly continuationTransaction: ChatProvider["continuationTransaction"];
  private index = 0;
  acceptedCompletions = 0;
  rollbackCount = 0;
  constructor(
    private readonly responses: AssistantResponse[],
    private readonly autoDeclare = true,
    stateful = true,
  ) {
    this.continuationTransaction = stateful
      ? {
          begin: () => {},
          commit: () => {},
          rollback: () => {
            this.rollbackCount += 1;
          },
        }
      : undefined;
  }
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.messages.push([...messages]);
    this.requestedTools.push(tools);
    if (
      this.autoDeclare &&
      tools.some((tool) => tool.function.name === "declare_task") &&
      tools.some((tool) => tool.function.name === "redirect_scope")
    ) {
      return Promise.resolve({
        toolCalls: [
          {
            id: "task-1",
            function: {
              name: "declare_task",
              arguments: JSON.stringify({
                goal: "Complete the requested test task.",
                completionCriteria: ["The requested result is returned."],
                plan: ["Inspect the project.", "Report the result."],
                excludedRequests: [],
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

class FailedDeclarationProvider implements ChatProvider {
  readonly messages: ChatMessage[][] = [];
  readonly continuationTransaction = {
    begin: () => {},
    commit: () => {},
    rollback: () => {
      this.rollbackCount += 1;
    },
  };
  rollbackCount = 0;
  private declarationAttempts = 0;

  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.messages.push([...messages]);
    if (
      tools.some((tool) => tool.function.name === "declare_task") &&
      tools.some((tool) => tool.function.name === "redirect_scope")
    ) {
      this.declarationAttempts += 1;
      if (this.declarationAttempts <= 2) {
        return Promise.resolve({
          toolCalls: [
            {
              id: `invalid-task-${this.declarationAttempts}`,
              function: {
                name: "declare_task",
                arguments: '{"goal":"Old task.","completionCriteria":[]}',
              },
            },
          ],
        });
      }
      return Promise.resolve({ toolCalls: [taskDeclarationCall("new")] });
    }
    return Promise.resolve({ content: "Completed.", toolCalls: [] });
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
        plan: ["Inspect the project.", "Report the result."],
        excludedRequests: [],
      }),
    },
  };
}

function scopeRedirectCall(): {
  id: string;
  function: { name: string; arguments: string };
} {
  return {
    id: "redirect-1",
    function: {
      name: "redirect_scope",
      arguments: JSON.stringify({
        reason: "This is not software-engineering work.",
        suggestedRequest: "Ask how to test a TypeScript function.",
      }),
    },
  };
}

class ConstantEmbeddingModel implements EmbeddingModel {
  embed(): Promise<number[]> {
    return Promise.resolve([1, 0]);
  }
}

class FlakyEmbeddingModel implements EmbeddingModel {
  private failed = false;

  embed(): Promise<number[]> {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error("embedding failed"));
    }
    return Promise.resolve([1, 0]);
  }
}

class LoopMemoryEvents implements MemoryEventSink {
  recorded(): void {}
  retrieved(): void {}
  cleared(): void {}
  failed(): void {}
}
