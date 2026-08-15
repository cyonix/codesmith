import { CodeSmithError } from "../shared/errors.js";
import type { AssistantResponse, ChatMessage, ToolDefinition } from "../shared/types.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { isRecord } from "./provider-parsing.js";
import type { Fetcher, ProviderConfiguration, ProviderImplementation } from "./provider-types.js";

export abstract class ProviderClient implements ProviderImplementation {
  protected readonly apiKey: string;
  protected readonly model: ModelCatalogEntry;

  constructor(configuration: ProviderConfiguration, protected readonly fetcher: Fetcher) {
    this.apiKey = configuration.apiKey;
    this.model = configuration.model;
  }

  abstract complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse>;

  protected async request(endpoint: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(endpoint, init);
    } catch {
      throw new CodeSmithError("provider", "The provider request could not be completed.");
    }
  }

  protected async checkedResponse(response: Response): Promise<unknown> {
    if (!response.ok) {
      throw new CodeSmithError(
        "provider",
        `The provider request failed with HTTP status ${response.status}: ${await providerError(response, this.apiKey)}`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new CodeSmithError("provider", "The provider returned an unreadable completion response.");
    }
  }
}

async function providerError(response: Response, apiKey: string): Promise<string> {
  const body = await boundedResponseText(response);

  try {
    const payload: unknown = JSON.parse(body);
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
      return safeErrorText(payload.error.message, apiKey);
    }
  } catch {
    // Fall through to a bounded plain-text diagnostic.
  }

  return safeErrorText(body, apiKey) || "No error detail was returned.";
}

async function boundedResponseText(response: Response): Promise<string> {
  const maximumBytes = 4_096;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const included = value.subarray(0, maximumBytes - bytesRead);
      chunks.push(included);
      bytesRead += included.length;
      if (included.length < value.length) break;
    }
  } finally {
    await reader.cancel();
  }

  const output = new Uint8Array(bytesRead);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(output);
}

function safeErrorText(value: string, apiKey: string): string {
  const escapedKey = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(new RegExp(escapedKey, "g"), "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'`,;:}\]]+/gi, "[REDACTED]")
    .replace(/\bsk-[^\s"'`,;:}\]]+/g, "[REDACTED]")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .slice(0, 1_000);
}
