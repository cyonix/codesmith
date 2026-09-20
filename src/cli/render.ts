import type { TaskContract } from "../agent/task-contract.js";

export function formatTaskContract(contract: TaskContract): string {
  return [
    `Task: ${contract.goal}`,
    "Completion criteria:",
    ...contract.completionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join("\n");
}
