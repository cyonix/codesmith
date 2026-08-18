import type { AgentEvent } from "../agent/events.js";
import { redactSensitiveText } from "../shared/redaction.js";

const maximumPreviewCharacters = 200;

export function formatDebugEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "status":
      return `debug: ${event.phase}`;
    case "goal_stated":
      return `debug: goal ${preview(event.summary)} replaced=${event.replaced} tests=${event.completionCriteria.length}`;
    case "tool_started":
      return `debug: start ${event.call.function.name} ${preview(event.call.function.arguments)}`;
    case "tool_finished":
      return `debug: done ${event.call.function.name} ${preview(event.result)}`;
    case "memory_retrieved":
      return `debug: memory retrieved ${event.episodes.length}`;
    case "memory_failed":
      return `debug: memory failed ${event.phase} ${preview(event.message)}`;
    case "error":
      return `debug: error ${preview(event.message)}`;
    default:
      return undefined;
  }
}

function preview(text: string): string {
  const compact = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maximumPreviewCharacters) return compact;
  return `${compact.slice(0, maximumPreviewCharacters - 3)}...`;
}
