import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../src/agent/loop.js";
import { ToolExecutor } from "../../src/workspace/tools.js";
import type {
  AssistantResponse,
  ChatMessage,
  ChatProvider,
  ToolDefinition,
} from "../../src/shared/types.js";

void test("declaration context keeps follow-ups grounded without replaying old execution turns", async () => {
  const provider = new CompactionProvider([
    { toolCalls: [{ id: "list-1", function: { name: "list_files", arguments: "{}" } }] },
    { content: "Would you like me to continue?", toolCalls: [] },
    { content: "Continued.", toolCalls: [] },
  ]);
  const loop = new AgentLoop(provider, await ToolExecutor.create(process.cwd(), true));

  assert.equal(await loop.run("Inspect the project."), "Would you like me to continue?");
  assert.equal(await loop.run("yes"), "Continued.");

  const followUpDeclaration = provider.messages.find((messages) =>
    messages.some((message) => message.role === "user" && message.content === "yes"),
  );
  assert.ok(followUpDeclaration);
  assert.ok(
    followUpDeclaration.some(
      (message) =>
        message.role === "assistant" &&
        message.content === "Would you like me to continue?" &&
        !message.tool_calls?.length,
    ),
  );

  const followUpRequest = provider.messages.at(-1);
  assert.ok(followUpRequest);
  assert.equal(
    followUpRequest.some(
      (message) =>
        message.role === "assistant" && message.content === "Would you like me to continue?",
    ),
    false,
  );
  assert.ok(
    followUpRequest.some((message) => message.role === "user" && message.content === "yes"),
  );
});

class CompactionProvider implements ChatProvider {
  readonly messages: ChatMessage[][] = [];
  private responseIndex = 0;

  constructor(private readonly responses: AssistantResponse[]) {}

  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.messages.push([...messages]);
    if (tools.length === 1) {
      return Promise.resolve({
        toolCalls: [
          {
            id: `task-${this.messages.length}`,
            function: {
              name: "declare_task",
              arguments: JSON.stringify({
                goal: "Inspect the project.",
                completionCriteria: ["The requested result is returned."],
                plan: ["Inspect the project.", "Report the result."],
              }),
            },
          },
        ],
      });
    }
    const response = this.responses[this.responseIndex++];
    if (!response) throw new Error("Mock provider exhausted.");
    return Promise.resolve(response);
  }
}
