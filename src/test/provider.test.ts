import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../provider.js";
import type { ChatMessage, ToolDefinition } from "../types.js";

const environment = {
  CODESMITH_API_KEY: "test-key/secret=",
  CODESMITH_BASE_URL: "https://provider.example/v1/",
  CODESMITH_MODEL: "test-model",
};

test("omits empty tool calls and restores the tool-call type when replaying messages", async () => {
  let requestBody = "";
  const provider = new OpenAICompatibleProvider(environment, async (_input, init) => {
    requestBody = String(init?.body);
    return Response.json({ choices: [{ message: { content: "Done." } }] });
  });
  const messages: ChatMessage[] = [
    { role: "system", content: "System" },
    { role: "assistant", content: "No tool was needed.", tool_calls: [] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", function: { name: "list_files", arguments: "{}" } }],
    },
  ];

  await provider.complete(messages, [] as ToolDefinition[]);

  const payload = JSON.parse(requestBody) as { messages: ChatMessage[] };
  assert.equal("tool_calls" in payload.messages[1], false);
  assert.equal((payload.messages[2].tool_calls?.[0] as { type?: string }).type, "function");
});

test("includes a bounded redacted provider error detail for HTTP failures", async () => {
  const provider = new OpenAICompatibleProvider(environment, async () => new Response(
    JSON.stringify({ error: { message: "Invalid tool message for Bearer test-key/secret= and sk-abcdef/secret=" } }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  ));

  await assert.rejects(
    () => provider.complete([{ role: "user", content: "Hello" }], []),
    (error: unknown) => {
      assert.match(String(error), /HTTP status 400: Invalid tool message/);
      assert.doesNotMatch(String(error), /test-key|sk-abcdef|secret=/);
      return true;
    },
  );
});
