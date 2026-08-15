import { CodeSmithError } from "../shared/errors.js";
import type { AssistantResponse, ChatMessage, ToolCall, ToolDefinition } from "../shared/types.js";
import { endpointFor } from "./provider-endpoint.js";
import { isRecord } from "./provider-parsing.js";
import { ProviderClient } from "./provider-client.js";
import type { Fetcher, ProviderConfiguration } from "./provider-types.js";

export class GeminiProvider extends ProviderClient {
  private readonly endpoint: URL;
  private previousInteractionId: string | undefined;
  private pendingInteractionId: string | undefined;

  constructor(configuration: ProviderConfiguration, fetcher: Fetcher) {
    super(configuration, fetcher);
    this.endpoint = endpointFor("interactions", this.model.baseUrl);
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.pendingInteractionId = undefined;

    const systemInstruction = messages
      .filter((message) => message.role === "system" && message.content)
      .map((message) => message.content)
      .join("\n\n");

    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        model: this.model.model,
        ...(this.previousInteractionId ? { previous_interaction_id: this.previousInteractionId } : {}),
        ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
        input: geminiInteractionInput(messages),
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      }),
    });

    const interaction = geminiInteractionResponse(await this.checkedResponse(response));
    this.pendingInteractionId = interaction.id;
    return interaction.response;
  }

  acceptCompletion(): void {
    this.previousInteractionId = this.pendingInteractionId;
    this.pendingInteractionId = undefined;
  }
}

function geminiInteractionInput(messages: ChatMessage[]): unknown[] {
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
  }
  const lastAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
  const pendingMessages = messages.slice(lastAssistant + 1).filter((message) => message.role !== "system");

  if (!pendingMessages.length) {
    throw new CodeSmithError("provider", "A Gemini interaction requires new user input or function results.");
  }

  const input: unknown[] = [];

  for (const message of pendingMessages) {
    if (message.role === "user") {
      input.push({ type: "user_input", content: message.content ?? "" });
      continue;
    }

    if (message.role !== "tool") continue;

    const name = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
    if (!name || !message.tool_call_id) {
      throw new CodeSmithError("provider", "A Gemini tool result did not match a preceding function call.");
    }

    input.push({
      type: "function_result",
      name,
      call_id: message.tool_call_id,
      result: [{ type: "text", text: message.content ?? "" }],
    });
  }
  return input;
}

function geminiInteractionResponse(payload: unknown): { id: string; response: AssistantResponse } {
  if (!isRecord(payload) || typeof payload.id !== "string" || !Array.isArray(payload.steps)) {
    throw new CodeSmithError("provider", "The provider returned an invalid interaction response.");
  }

  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const step of payload.steps) {
    if (!isRecord(step) || typeof step.type !== "string") continue;
    if (step.type === "model_output" && Array.isArray(step.content)) {
      for (const content of step.content) {
        if (isRecord(content) && content.type === "text" && typeof content.text === "string") text.push(content.text);
      }
      continue;
    }

    if (
      step.type === "function_call"
      && typeof step.id === "string"
      && typeof step.name === "string"
    ) {
      toolCalls.push({
        id: step.id,
        function: {
          name: step.name,
          arguments: JSON.stringify(isRecord(step.arguments) ? step.arguments : {}),
        },
      });
    }
  }

  if (!text.length && !toolCalls.length) {
    throw new CodeSmithError("provider", "The provider returned no usable interaction content.");
  }
  return { id: payload.id, response: { content: text.join("") || null, toolCalls } };
}
