import type { AssistantResponse, ChatMessage, ToolDefinition } from "../shared/types.js";
import type { ModelCatalogEntry } from "./model-catalog.js";

export type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface ProviderConfiguration {
  readonly model: ModelCatalogEntry;
  readonly apiKey: string;
}

export interface ProviderImplementation {
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse>;
  acceptCompletion?(): void;
}
