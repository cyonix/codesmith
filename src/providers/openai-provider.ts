import { CodeSmithError } from "../shared/errors.js";
import type { AssistantResponse, ChatMessage, ToolCall, ToolDefinition } from "../shared/types.js";
import { endpointFor } from "./provider-endpoint.js";
import { isRecord } from "./provider-parsing.js";
import { ProviderClient } from "./provider-client.js";
import type { Fetcher, ProviderConfiguration } from "./provider-types.js";

export class OpenAIProvider extends ProviderClient {
  private readonly endpoint: URL;

  constructor(configuration: ProviderConfiguration, fetcher: Fetcher) {
    super(configuration, fetcher);
    this.endpoint = endpointFor("chat/completions", this.model.baseUrl);
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model.model,
        messages: normalizedOpenAIMessages(messages),
        tools,
      }),
    });

    return openAIResponse(await this.checkedResponse(response));
  }
}

function normalizedOpenAIMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      const { tool_calls: _toolCalls, ...withoutToolCalls } = message;
      return withoutToolCalls;
    }

    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({ ...call, type: "function" })),
    };
  });
}

function openAIResponse(payload: unknown): AssistantResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || !isRecord(payload.choices[0].message)) {
    throw new CodeSmithError("provider", "The provider returned no completion choices.");
  }
  const message = payload.choices[0].message;
  if (
    (message.content !== undefined && message.content !== null && typeof message.content !== "string")
    || (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))
  ) {
    throw new CodeSmithError("provider", "The provider returned an invalid completion response.");
  }

  const response = {
    content: message.content as string | null | undefined,
    toolCalls: (message.tool_calls ?? []) as ToolCall[],
  };
  if (!response.content && !response.toolCalls.length) {
    throw new CodeSmithError("provider", "The provider returned no usable completion content.");
  }

  return response;
}
