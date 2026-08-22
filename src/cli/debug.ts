import type { AgentEvent } from "../agent/events.js";
import { previewSensitiveText } from "../shared/redaction.js";
import { isSensitiveToolPayload, omittedSecretPreview } from "../shared/secret-files.js";

export function formatDebugEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "status":
      return `[status] ${event.phase}`;
    case "goal_stated":
      return `[goal] ${previewSensitiveText(event.summary)} replaced=${event.replaced} tests=${event.completionCriteria.length}`;
    case "tool_started":
      return `[tool] [start] ${event.call.function.name} ${toolPreview(event.call.function.arguments)}`;
    case "tool_finished":
      return `[tool] [done] ${event.call.function.name} ${toolPreview(event.call.function.arguments, event.result)}`;
    case "provider_request":
      return [
        `[llm] round=${event.round} messages=${event.messages.length} tools=${event.toolCount}`,
        ...event.messages.map((message) => `[llm] [${message.role}] ${message.preview}`),
      ].join("\n");
    case "memory_retrieved":
      return `[memory] retrieved ${event.episodes.length}`;
    case "memory_failed":
      return `[memory] failed ${event.phase} ${previewSensitiveText(event.message)}`;
    case "error":
      return `[error] ${previewSensitiveText(event.message)}`;
    default:
      return undefined;
  }
}

function toolPreview(argumentsValue: string, result?: string): string {
  if (isSensitiveToolPayload(argumentsValue, result)) return omittedSecretPreview;
  return previewSensitiveText(result ?? argumentsValue);
}
