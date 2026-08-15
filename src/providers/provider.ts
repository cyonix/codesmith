import { CodeSmithError } from "../shared/errors.js";
import type {
  AssistantResponse,
  ChatMessage,
  ChatProvider,
  ToolDefinition,
} from "../shared/types.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import type { Fetcher, ProviderImplementation } from "./provider-types.js";

export type { ProviderConfiguration } from "./provider-types.js";
import type { ProviderConfiguration } from "./provider-types.js";

export class ModelProvider implements ChatProvider {
  private readonly implementation: ProviderImplementation;

  constructor(configuration: ProviderConfiguration, fetcher: Fetcher = fetch) {
    if (!configuration.apiKey.trim()) {
      throw new CodeSmithError("configuration", "An API key is required to start codesmith.");
    }

    switch (configuration.model.protocol) {
      case "openai":
        this.implementation = new OpenAIProvider(configuration, fetcher);
        break;
      case "anthropic":
        this.implementation = new AnthropicProvider(configuration, fetcher);
        break;
      case "gemini":
        this.implementation = new GeminiProvider(configuration, fetcher);
        break;
      default:
        throw new CodeSmithError(
          "configuration",
          "The selected provider protocol is not supported.",
        );
    }
  }

  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    return this.implementation.complete(messages, tools);
  }

  acceptCompletion(): void {
    this.implementation.acceptCompletion?.();
  }
}
