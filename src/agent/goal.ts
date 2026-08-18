import type { ToolDefinition } from "../shared/types.js";

export const maximumGoalSummaryCharacters = 200;
export const maximumGoalCriterionCharacters = 200;
export const maximumGoalCriteria = 8;

const gatedToolNames = new Set(["create_file", "delete_file", "apply_patch", "run_command"]);
const fileMutationToolNames = new Set(["create_file", "delete_file", "apply_patch"]);

export interface AgentGoal {
  readonly summary: string;
  readonly completionCriteria: readonly string[];
}

export const stateGoalDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "state_goal",
    description:
      "State the goal and observable completion tests for this submission. Required before create_file, delete_file, apply_patch, or run_command. You may replace the goal until the first successful file edit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "completion_criteria"],
      properties: {
        summary: {
          type: "string",
          description: "One-sentence goal. Maximum 200 characters.",
        },
        completion_criteria: {
          type: "array",
          minItems: 1,
          maxItems: maximumGoalCriteria,
          items: {
            type: "string",
            description: "An observable completion test. Maximum 200 characters.",
          },
        },
      },
    },
  },
};

export class GoalState {
  private goal: AgentGoal | undefined;
  private frozen = false;

  reset(): void {
    this.goal = undefined;
    this.frozen = false;
  }

  get hasGoal(): boolean {
    return this.goal !== undefined;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  set(goal: AgentGoal): { replaced: boolean } | undefined {
    if (this.frozen) return undefined;
    const replaced = this.goal !== undefined;
    this.goal = goal;
    return { replaced };
  }

  freeze(): void {
    this.frozen = true;
  }
}

export function parseStateGoalArguments(raw: string): { goal: AgentGoal } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Invalid arguments for state_goal." };
  }
  if (!isJsonObject(parsed)) return { error: "Arguments for state_goal must be an object." };

  const summary = parseBoundedText(
    parsed.summary,
    "summary must be a non-empty string.",
    `summary must be at most ${maximumGoalSummaryCharacters} characters.`,
    maximumGoalSummaryCharacters,
  );
  if (typeof summary !== "string") return summary;

  if (!Array.isArray(parsed.completion_criteria)) {
    return { error: "completion_criteria must contain 1 to 8 non-empty strings." };
  }
  if (
    parsed.completion_criteria.length < 1 ||
    parsed.completion_criteria.length > maximumGoalCriteria
  ) {
    return { error: "completion_criteria must contain 1 to 8 non-empty strings." };
  }

  const completionCriteria: string[] = [];
  for (const item of parsed.completion_criteria) {
    const criterion = parseBoundedText(
      item,
      "completion_criteria must contain 1 to 8 non-empty strings.",
      `Each completion criterion must be at most ${maximumGoalCriterionCharacters} characters.`,
      maximumGoalCriterionCharacters,
    );
    if (typeof criterion !== "string") return criterion;
    completionCriteria.push(criterion);
  }

  return { goal: { summary, completionCriteria } };
}

export function requiresStatedGoal(toolName: string): boolean {
  return gatedToolNames.has(toolName);
}

export function fileMutationSucceeded(toolName: string, result: string): boolean {
  if (!fileMutationToolNames.has(toolName)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return false;
  }
  if (!isJsonObject(parsed)) return false;
  return parsed.status === "created" || parsed.status === "deleted" || parsed.status === "applied";
}

function parseBoundedText(
  value: unknown,
  emptyError: string,
  longError: string,
  maximum: number,
): string | { error: string } {
  if (typeof value !== "string") return { error: emptyError };
  const text = value.trim();
  if (text.length === 0) return { error: emptyError };
  if (text.length > maximum) return { error: longError };
  return text;
}

function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
