import { CodeSmithError } from "../shared/errors.js";
import type { AssistantResponse, ChatMessage, ToolCall, ToolDefinition } from "../shared/types.js";
import { endpointFor } from "./provider-endpoint.js";
import { isRecord, parsedObject } from "./provider-parsing.js";
import { ProviderClient } from "./provider-client.js";
import type { Fetcher, ProviderConfiguration } from "./provider-types.js";

export class AnthropicProvider extends ProviderClient {
  private readonly endpoint: URL;

  constructor(configuration: ProviderConfiguration, fetcher: Fetcher) {
    super(configuration, fetcher);
    this.endpoint = endpointFor("v1/messages", this.model.baseUrl);
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    const system = messages
      .filter((message) => message.role === "system" && message.content)
      .map((message) => message.content)
      .join("\n\n");

    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        model: this.model.model,
        max_tokens: 8192,
        ...(system ? { system } : {}),
        messages: anthropicMessages(messages),
        tools: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        })),
      }),
    });

    return anthropicResponse(await this.checkedResponse(response));
  }
}

function anthropicMessages(messages: ChatMessage[]): unknown[] {
  const formatted: unknown[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      formatted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: message.content ?? "",
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parsedObject(call.function.arguments),
        });
      }
      formatted.push({ role: "assistant", content });
      continue;
    }

    formatted.push({ role: "user", content: message.content ?? "" });
  }
  return formatted;
}

function anthropicResponse(payload: unknown): AssistantResponse {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new CodeSmithError("provider", "The provider returned no completion content.");
  }

  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of payload.content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }

    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      isRecord(block.input)
    ) {
      toolCalls.push({
        id: block.id,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }

  if (!text.length && !toolCalls.length) {
    throw new CodeSmithError("provider", "The provider returned no usable completion content.");
  }
  return { content: text.join("") || null, toolCalls };
}
