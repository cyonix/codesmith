import type { AgentEvent } from "../agent/events.js";
import { previewSensitiveText, redactSensitiveText, truncatePreview } from "../shared/redaction.js";
import { isSensitiveToolPayload, omittedSecretPreview } from "../shared/secret-files.js";

export function formatDebugEvent(event: AgentEvent): string {
  switch (event.type) {
    case "status":
      return `[status] ${event.phase}`;
    case "task_declared": {
      const redactedGoal = redactSensitiveText(event.contract.goal);
      const redactedCriteria = event.contract.completionCriteria.map(
        (criterion, index) => `${index + 1}. ${redactSensitiveText(criterion)}`,
      );
      const redactedPlan = event.contract.plan.map(
        (step, index) => `${index + 1}. ${redactSensitiveText(step)}`,
      );
      const excludedRequests = event.contract.excludedRequests ?? [];
      const redactedExclusions =
        excludedRequests.length > 0
          ? ` exclusions=${excludedRequests
              .map((request, index) => `${index + 1}. ${redactSensitiveText(request)}`)
              .join(" | ")}`
          : "";
      const contractPreview = truncatePreview(
        `goal=${redactedGoal} criteria=${redactedCriteria.join(" | ")} plan=${redactedPlan.join(" | ")}${redactedExclusions}`,
      );
      return `[task_declared] ${event.contract.taskId} ${contractPreview}`;
    }
    case "plan_revised": {
      const plan = event.plan.map((step, index) => `${index + 1}. ${redactSensitiveText(step)}`);
      const revisionPreview = truncatePreview(
        `reason=${redactSensitiveText(event.reason)} plan=${plan.join(" | ")}`,
      );
      return `[plan_revised] ${event.taskId} ${revisionPreview}`;
    }
    case "scope_redirected":
      return `[scope_redirected] reason=${truncatePreview(
        redactSensitiveText(event.reason),
      )} suggested=${truncatePreview(redactSensitiveText(event.suggestedRequest))}`;
    case "assistant_text":
      return `[assistant_text] ${previewSensitiveText(event.text)}`;
    case "tool_proposed":
      return `[tool_proposed] ${toolLine(event.call.function.name, event.call.function.arguments)}`;
    case "tool_started":
      return `[tool_started] ${toolLine(event.call.function.name, event.call.function.arguments)}`;
    case "tool_finished":
      return `[tool_finished] ${toolLine(event.call.function.name, event.call.function.arguments, event.result)}`;
    case "approval_requested":
      return `[approval_requested] ${event.kind}`;
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
