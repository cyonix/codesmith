import type { ApprovalKind } from "./tools.js";
import type { ToolCall } from "./types.js";

export type AgentEvent =
  | { type: "status"; phase: "thinking" | "waiting_for_approval" | "complete" }
  | { type: "assistant_text"; text: string }
  | { type: "tool_proposed"; call: ToolCall }
  | { type: "tool_started"; call: ToolCall }
  | { type: "tool_finished"; call: ToolCall; result: string }
  | { type: "approval_requested"; requestId: string; kind: ApprovalKind; summary: string }
  | { type: "error"; message: string };

export type AgentEventListener = (event: AgentEvent) => void;
