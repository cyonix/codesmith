import type { TaskContract } from "../agent/task-contract.js";
import { escapeTerminalText } from "../shared/terminal-text.js";

export function formatTaskContract(contract: TaskContract): string {
  return [
    `Task: ${normalizeContractText(contract.goal)}`,
    "Completion criteria:",
    ...contract.completionCriteria.map(
      (criterion, index) => `${index + 1}. ${normalizeContractText(criterion)}`,
    ),
  ].join("\n");
}

function normalizeContractText(value: string): string {
  return escapeTerminalText(value.replace(/\s+/g, " ").trim());
}
