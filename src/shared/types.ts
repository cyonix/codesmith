export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, JsonValue> };
}

export interface AssistantResponse { content?: string | null; toolCalls: ToolCall[]; }

export interface ChatProvider {
  complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse>;
  acceptCompletion?(): void;
}
