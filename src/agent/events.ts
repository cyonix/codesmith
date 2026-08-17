import type { ApprovalKind } from "../workspace/tools.js";
import type { ToolCall } from "../shared/types.js";

export type AgentEvent =
  | { type: "status"; phase: "thinking" | "waiting_for_approval" | "complete" }
  | { type: "assistant_text"; text: string }
  | { type: "tool_proposed"; call: ToolCall }
  | { type: "tool_started"; call: ToolCall }
  | { type: "tool_finished"; call: ToolCall; result: string }
  | { type: "approval_requested"; requestId: string; kind: ApprovalKind; summary: string }
  | { type: "memory_recorded"; episodeId: string; kind: "tool" | "assistant" }
  | {
      type: "memory_retrieved";
      episodes: ReadonlyArray<{ id: string; kind: "tool" | "assistant"; score: number }>;
    }
  | { type: "memory_cleared"; count: number }
  | {
      type: "memory_failed";
      phase: "initialization" | "retrieval" | "recording";
      message: string;
      blocksFutureSubmissions: boolean;
    }
  | { type: "error"; message: string };

export type AgentEventListener = (event: AgentEvent) => void;
