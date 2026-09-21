import type { TaskContract } from "../agent/task-contract.js";
import { escapeTerminalText } from "../shared/terminal-text.js";

export function formatTaskContract(contract: TaskContract): string {
  const excludedRequests = contract.excludedRequests ?? [];
  const lines = [
    `Task: ${normalizeContractText(contract.goal)}`,
    "Completion criteria:",
    ...contract.completionCriteria.map(
      (criterion, index) => `${index + 1}. ${normalizeContractText(criterion)}`,
    ),
    "Plan:",
    ...formatPlanSteps(contract.plan),
  ];
  if (excludedRequests.length > 0) {
    lines.push(
      "Excluded unrelated requests:",
      ...excludedRequests.map(
        (request, index) => `${index + 1}. ${normalizeContractText(request)}`,
      ),
    );
  }
  return lines.join("\n");
}

export function formatPlanRevision(plan: readonly string[], reason: string): string {
  return [
    "Plan revised:",
    ...formatPlanSteps(plan),
    `Reason: ${normalizeContractText(reason)}`,
  ].join("\n");
}

function formatPlanSteps(plan: readonly string[]): string[] {
  return plan.map((step, index) => `${index + 1}. ${normalizeContractText(step)}`);
}

function normalizeContractText(value: string): string {
  return escapeTerminalText(value.replace(/\s+/g, " ").trim());
}
