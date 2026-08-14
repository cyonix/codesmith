import { CodeSmithError } from "./errors.js";
import type { AgentEvent } from "./agent-events.js";
import { ToolExecutor } from "./tools.js";
import type { ChatMessage, ChatProvider } from "./types.js";

export class AgentLoop {
  private static readonly maximumHistoryMessages = 32;
  private static readonly maximumToolCallsPerRun = 12;
  private readonly messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are CodeSmith, a local coding assistant. Work only through the supplied tools and stay focused on the selected project. Retain and use the conversation context. A brief reply such as 'yes', 'no', 'proceed', or 'do it' answers your immediately preceding unresolved question: act on that answer without asking the user to repeat context. When the user explicitly asks you to create, modify, rename, or remove code and the required details are available, call the appropriate tool immediately; do not ask for confirmation in your response because edits and commands have an approval gate in the tool. Never claim a file action succeeded unless its tool returned success. Inspect files before changing existing code. Never request, display, or infer environment secrets.",
    },
  ];

  constructor(
    private readonly provider: ChatProvider,
    private readonly tools: ToolExecutor,
    private readonly maximumToolRounds = 12,
    private readonly emit: (event: AgentEvent) => void = () => {},
    private readonly isClosed: () => boolean = () => false,
  ) {}

  async run(prompt: string): Promise<string> {
    this.trimHistory();
    this.messages.push({ role: "user", content: prompt });
    let toolCallsUsed = 0;
    let toolRounds = 0;
    while (true) {
      this.assertOpen();
      this.emit({ type: "status", phase: "thinking" });
      this.assertOpen();
      const response = await this.provider.complete(this.messages, this.tools.definitions);
      this.assertOpen();
      if (response.toolCalls.length > 0 && toolRounds >= this.maximumToolRounds) {
        throw new CodeSmithError("loop", "The agent exceeded the maximum number of tool-call rounds.");
      }
      toolCallsUsed += response.toolCalls.length;
      if (
        toolCallsUsed > AgentLoop.maximumToolCallsPerRun ||
        this.messages.length + 1 + response.toolCalls.length > AgentLoop.maximumHistoryMessages
      ) {
        throw new CodeSmithError("loop", "The agent exceeded the maximum number of tool calls for one request.");
      }
      this.messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });
      if (response.toolCalls.length === 0) {
        if (response.content) this.emit({ type: "assistant_text", text: response.content });
        this.emit({ type: "status", phase: "complete" });
        return response.content ?? "";
      }
      toolRounds += 1;
      for (const call of response.toolCalls) {
        this.assertOpen();
        this.emit({ type: "tool_proposed", call });
        this.assertOpen();
        this.emit({ type: "tool_started", call });
        this.assertOpen();
        const result = await this.tools.execute(call);
        this.messages.push({ role: "tool", content: result, tool_call_id: call.id });
        this.emit({ type: "tool_finished", call, result });
      }
    }
  }

  private trimHistory(): void {
    const maximumPriorMessages = AgentLoop.maximumHistoryMessages - (AgentLoop.maximumToolCallsPerRun * 2) - 2;
    while (this.messages.length > maximumPriorMessages) {
      const nextUser = this.messages.findIndex((message, index) => index > 1 && message.role === "user");
      if (nextUser < 0) this.messages.splice(1);
      else this.messages.splice(1, nextUser - 1);
    }
  }

  private assertOpen(): void {
    if (this.isClosed()) throw new CodeSmithError("loop", "This agent session is closed.");
  }
}
