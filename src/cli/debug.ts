import type { AgentEvent } from "../agent/events.js";
import { previewSensitiveText } from "../shared/redaction.js";
import { isSensitiveToolPayload, omittedSecretPreview } from "../shared/secret-files.js";

export function formatDebugEvent(event: AgentEvent): string {
  switch (event.type) {
    case "status":
      return `[status] ${event.phase}`;
    case "assistant_text":
      return `[assistant_text] ${previewSensitiveText(event.text)}`;
    case "tool_proposed":
      return `[tool_proposed] ${toolLine(event.call.function.name, event.call.function.arguments)}`;
    case "tool_started":
      return `[tool_started] ${toolLine(event.call.function.name, event.call.function.arguments)}`;
    case "tool_finished":
      return `[tool_finished] ${toolLine(event.call.function.name, event.call.function.arguments, event.result)}`;
    case "approval_requested":
      return `[approval_requested] ${event.kind} ${previewSensitiveText(event.summary)}`;
    case "memory_recorded":
      return `[memory_recorded] ${event.kind} ${event.episodeId}`;
    case "memory_retrieved":
      return `[memory_retrieved] ${event.episodes.length}`;
    case "memory_cleared":
      return `[memory_cleared] ${event.count}`;
    case "memory_failed":
      return `[memory_failed] ${event.phase} ${previewSensitiveText(event.message)}`;
    case "error":
      return `[error] ${previewSensitiveText(event.message)}`;
    case "provider_request":
      return [
        `[provider_request] round=${event.round} messages=${event.messages.length} tools=${event.toolCount}`,
        ...event.messages.map(
          (message) => `[provider_request] [${message.role}] ${message.preview}`,
        ),
      ].join("\n");
  }
}

function toolLine(toolName: string, argumentsValue: string, result?: string): string {
  const name = previewSensitiveText(toolName);
  if (isSensitiveToolPayload(toolName, argumentsValue, result))
    return `${name} ${omittedSecretPreview}`;
  return `${name} ${previewSensitiveText(result ?? argumentsValue)}`;
}
