import assert from "node:assert/strict";
import test from "node:test";
import { modelCatalog, type ModelCatalogEntry } from "../../src/providers/model-catalog.js";
import { ModelProvider } from "../../src/providers/provider.js";
import type { ChatMessage, ToolDefinition } from "../../src/shared/types.js";

const tools: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}];

function configuration(protocol: ModelCatalogEntry["protocol"]) {
  const model = modelCatalog.find((entry) => entry.protocol === protocol);
  assert.ok(model, `Missing ${protocol} catalog entry.`);
  return { model, apiKey: "test-key/secret=" };
}

test("sends OpenAI Chat Completions requests with normalized tool calls", async () => {
  let requestBody = "";
  const provider = new ModelProvider(configuration("openai"), async (_input, init) => {
    requestBody = String(init?.body);
    return Response.json({ choices: [{ message: { content: "Done." } }] });
  });
  const messages: ChatMessage[] = [
    { role: "system", content: "System" },
    { role: "assistant", content: "No tool was needed.", tool_calls: [] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }],
    },
  ];

  const result = await provider.complete(messages, tools);

  const payload = JSON.parse(requestBody) as { messages: ChatMessage[]; model: string };
  assert.equal(payload.model, configuration("openai").model.model);
  assert.equal("tool_calls" in payload.messages[1], false);
  assert.equal((payload.messages[2].tool_calls?.[0] as { type?: string }).type, "function");
  assert.deepEqual(result, { content: "Done.", toolCalls: [] });
});

test("normalizes Anthropic Messages tool calls and results", async () => {
  let requestBody = "";
  let headers: HeadersInit | undefined;
  const provider = new ModelProvider(configuration("anthropic"), async (_input, init) => {
    requestBody = String(init?.body);
    headers = init?.headers;
    return Response.json({
      content: [
        { type: "text", text: "I will inspect it. " },
        { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
      ],
    });
  });

  const result = await provider.complete([
    { role: "system", content: "System" },
    { role: "user", content: "Inspect the README." },
  ], tools);

  const payload = JSON.parse(requestBody) as {
    system: string;
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ input_schema: unknown }>;
  };
  assert.equal(payload.system, "System");
  assert.deepEqual(payload.messages, [{ role: "user", content: "Inspect the README." }]);
  assert.deepEqual(payload.tools[0].input_schema, tools[0].function.parameters);
  assert.deepEqual(headers, {
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    "x-api-key": "test-key/secret=",
  });
  assert.deepEqual(result, {
    content: "I will inspect it. ",
    toolCalls: [{ id: "tool-1", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
  });
});

test("uses Gemini Interactions for function calls and result continuation", async () => {
  const requestBodies: string[] = [];
  const endpoints: string[] = [];
  const provider = new ModelProvider(configuration("gemini"), async (input, init) => {
    endpoints.push(String(input));
    requestBodies.push(String(init?.body));
    if (requestBodies.length === 1) {
      return Response.json({
        id: "interaction-1",
        steps: [{ type: "function_call", id: "provider-call-1", name: "read_file", arguments: { path: "README.md" } }],
      });
    }
    return Response.json({
      id: "interaction-2",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Done." }] }],
    });
  });

  const first = await provider.complete([{ role: "user", content: "Inspect the README." }], tools);
  provider.acceptCompletion();
  await provider.complete([
    { role: "user", content: "Inspect the README." },
    { role: "assistant", content: first.content, tool_calls: first.toolCalls },
    { role: "tool", tool_call_id: first.toolCalls[0].id, content: "{\"content\":\"Readme\"}" },
  ], tools);

  const firstPayload = JSON.parse(requestBodies[0]) as {
    model: string;
    input: Array<{ type: string; content: string }>;
    tools: Array<{ type: string; parameters: unknown }>;
  };
  const secondPayload = JSON.parse(requestBodies[1]) as {
    previous_interaction_id: string;
    input: Array<{ type: string; name: string; call_id: string; result: Array<{ type: string; text: string }> }>;
  };
  assert.deepEqual(first.toolCalls, [{
    id: "provider-call-1",
    function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
  }]);
  assert.equal(firstPayload.model, configuration("gemini").model.model);
  assert.equal(endpoints[0], "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.deepEqual(firstPayload.input, [{ type: "user_input", content: "Inspect the README." }]);
  assert.equal(firstPayload.tools[0].type, "function");
  assert.deepEqual(firstPayload.tools[0].parameters, tools[0].function.parameters);
  assert.equal(secondPayload.previous_interaction_id, "interaction-1");
  assert.deepEqual(secondPayload.input, [{
    type: "function_result",
    name: "read_file",
    call_id: "provider-call-1",
    result: [{ type: "text", text: "{\"content\":\"Readme\"}" }],
  }]);
});

test("includes a bounded redacted provider error detail for HTTP failures", async () => {
  const provider = new ModelProvider(configuration("openai"), async () => new Response(
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
