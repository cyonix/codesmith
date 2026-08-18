import type { AgentEvent } from "../agent/events.js";
import { previewSensitiveText } from "../shared/redaction.js";

export function formatDebugEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "status":
      return `debug: ${event.phase}`;
    case "goal_stated":
      return `debug: goal ${previewSensitiveText(event.summary)} replaced=${event.replaced} tests=${event.completionCriteria.length}`;
    case "tool_started":
      return `debug: start ${event.call.function.name} ${previewSensitiveText(event.call.function.arguments)}`;
    case "tool_finished":
      return `debug: done ${event.call.function.name} ${previewSensitiveText(event.result)}`;
    case "provider_request":
      return [
        `debug: llm round=${event.round} messages=${event.messages.length} tools=${event.toolCount}`,
        ...event.messages.map((message) => `debug: llm ${message.role} ${message.preview}`),
      ].join("\n");
    case "memory_retrieved":
      return `debug: memory retrieved ${event.episodes.length}`;
    case "memory_failed":
      return `debug: memory failed ${event.phase} ${previewSensitiveText(event.message)}`;
    case "error":
      return `debug: error ${previewSensitiveText(event.message)}`;
    default:
      return undefined;
  }
}
