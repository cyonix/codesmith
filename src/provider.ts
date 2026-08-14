import { CodeSmithError } from "./errors.js";
import type { AssistantResponse, ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "./types.js";

type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export class OpenAICompatibleProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly endpoint: URL;
  private readonly model: string;

  constructor(environment: NodeJS.ProcessEnv = process.env, private readonly fetcher: Fetcher = fetch) {
    const { CODESMITH_API_KEY: apiKey, CODESMITH_BASE_URL: baseURL, CODESMITH_MODEL: model } = environment;
    if (!apiKey) throw new CodeSmithError("configuration", "Set CODESMITH_API_KEY before starting codesmith.");
    if (!baseURL || !model) throw new CodeSmithError("configuration", "Set CODESMITH_BASE_URL and CODESMITH_MODEL before starting codesmith.");
    let endpoint: URL;
    try { endpoint = new URL("chat/completions", baseURL.endsWith("/") ? baseURL : `${baseURL}/`); } catch {
      throw new CodeSmithError("configuration", "Set CODESMITH_BASE_URL to an absolute HTTP(S) URL.");
    }
    if (!["https:", "http:"].includes(endpoint.protocol)) throw new CodeSmithError("configuration", "Set CODESMITH_BASE_URL to an absolute HTTP(S) URL.");
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.model = model;
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    let response: Response;
    try {
      let body = JSON.stringify({ model: this.model, messages: normalizedMessages(messages), tools });

      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: body,
      });

    } catch { throw new CodeSmithError("provider", "The provider request could not be completed."); }
    if (!response.ok) {
      throw new CodeSmithError("provider", `The provider request failed with HTTP status ${response.status}: ${await providerError(response, this.apiKey)}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CodeSmithError("provider", "The provider returned an unreadable completion response.");
    }
    const message = getMessage(payload);
    if (!message) throw new CodeSmithError("provider", "The provider returned no completion choices.");
    return { content: message.content, toolCalls: message.tool_calls ?? [] };
  }
}

function normalizedMessages(messages: ChatMessage[]): ChatMessage[] {
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
    .replace(/\bBearer\s+[^\s"'`,;:}\]]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[^\s"'`,;:}\]]+/g, "[REDACTED]")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .slice(0, 1_000);
}

function getMessage(payload: unknown): { content?: string | null; tool_calls?: ToolCall[] } | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || !isRecord(payload.choices[0].message)) return undefined;
  const message = payload.choices[0].message;
  if ((message.content !== undefined && message.content !== null && typeof message.content !== "string") || (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))) return undefined;
  return message as { content?: string | null; tool_calls?: ToolCall[] };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
