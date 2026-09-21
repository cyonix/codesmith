import { randomUUID } from "node:crypto";
import type { JsonValue, ToolDefinition } from "../shared/types.js";

export const taskContractToolName = "declare_task";
export const planRevisionToolName = "revise_plan";
export const scopeRedirectToolName = "redirect_scope";

const maximumPlanSteps = 8;
const maximumPlanStepLength = 300;
const maximumPlanRevisionReasonLength = 300;
const maximumExcludedRequests = 8;
const maximumExcludedRequestLength = 300;
const maximumScopeRedirectFieldLength = 300;

export interface TaskContract {
  readonly taskId: string;
  readonly goal: string;
  readonly completionCriteria: readonly string[];
  readonly plan: readonly string[];
  readonly excludedRequests?: readonly string[];
}

export interface TaskContractInput {
  goal: string;
  completionCriteria: string[];
  plan: string[];
  excludedRequests?: string[];
}

export type TaskContractParseResult =
  { valid: true; input: TaskContractInput } | { valid: false; message: string };

export interface PlanRevisionInput {
  plan: string[];
  reason: string;
}

export type PlanRevisionParseResult =
  { valid: true; input: PlanRevisionInput } | { valid: false; message: string };

export interface ScopeRedirectInput {
  reason: string;
  suggestedRequest: string;
}

export type ScopeRedirectParseResult =
  { valid: true; input: ScopeRedirectInput } | { valid: false; message: string };

export const taskContractToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: taskContractToolName,
    description:
      "Declare the goal, observable completion criteria, and ordered execution plan for this submission before using any workspace tool.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The user's goal, preserved in meaning and limited to 500 characters.",
          minLength: 1,
          maxLength: 500,
        },
        completionCriteria: {
          type: "array",
          description: "One to eight observable ways to tell that the goal is complete.",
          items: { type: "string", minLength: 1, maxLength: 300 },
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
        },
        plan: {
          type: "array",
          description: "One to eight concise, ordered steps for completing the goal.",
          items: { type: "string", minLength: 1, maxLength: maximumPlanStepLength },
          minItems: 1,
          maxItems: maximumPlanSteps,
          uniqueItems: true,
        },
        excludedRequests: {
          type: "array",
          description: "Unrelated parts excluded from a mixed request, or an empty array.",
          items: { type: "string", minLength: 1, maxLength: maximumExcludedRequestLength },
          minItems: 0,
          maxItems: maximumExcludedRequests,
          uniqueItems: true,
        },
      },
      required: ["goal", "completionCriteria", "plan", "excludedRequests"],
      additionalProperties: false,
    },
  },
};

export const planRevisionToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: planRevisionToolName,
    description:
      "Replace the complete ordered plan when new evidence changes the approach. Include a concise reason. Do not use this call with workspace tools.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description: "The complete replacement plan, with one to eight ordered steps.",
          items: { type: "string", minLength: 1, maxLength: maximumPlanStepLength },
          minItems: 1,
          maxItems: maximumPlanSteps,
          uniqueItems: true,
        },
        reason: {
          type: "string",
          description: "A concise explanation of why the plan changed.",
          minLength: 1,
          maxLength: maximumPlanRevisionReasonLength,
        },
      },
      required: ["plan", "reason"],
      additionalProperties: false,
    },
  },
};

export const scopeRedirectToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: scopeRedirectToolName,
    description:
      "Politely redirect a request that is not software-engineering work. Do not use this for general software-engineering questions or mixed requests.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "A concise reason the request is outside the supported scope.",
          minLength: 1,
          maxLength: maximumScopeRedirectFieldLength,
        },
        suggestedRequest: {
          type: "string",
          description: "A concise example of a software-engineering request the user can ask.",
          minLength: 1,
          maxLength: maximumScopeRedirectFieldLength,
        },
      },
      required: ["reason", "suggestedRequest"],
      additionalProperties: false,
    },
  },
};

export function parseTaskContract(argumentsValue: string): TaskContractParseResult {
  if (hasDuplicateObjectKeys(argumentsValue)) {
    return { valid: false, message: "Task declaration arguments must not contain duplicate keys." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsValue) as unknown;
  } catch {
    return { valid: false, message: "Task declaration arguments must be valid JSON." };
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return { valid: false, message: "Task declaration arguments must be a JSON object." };
  }

  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "completionCriteria" ||
    keys[1] !== "excludedRequests" ||
    keys[2] !== "goal" ||
    keys[3] !== "plan"
  ) {
    return {
      valid: false,
      message:
        'Task declaration accepts only "goal", "completionCriteria", "plan", and "excludedRequests".',
    };
  }

  if (typeof parsed.goal !== "string") {
    return { valid: false, message: "Task declaration goal must be a string." };
  }

  const goal = parsed.goal.trim();
  if (!goal) return { valid: false, message: "Task declaration goal must not be empty." };
  if ([...goal].length > 500) {
    return { valid: false, message: "Task declaration goal must be at most 500 characters." };
  }

  if (!Array.isArray(parsed.completionCriteria)) {
    return { valid: false, message: "Task declaration criteria must be an array." };
  }
  if (parsed.completionCriteria.length < 1 || parsed.completionCriteria.length > maximumPlanSteps) {
    return { valid: false, message: "Task declaration must contain 1 to 8 criteria." };
  }

  const completionCriteria: string[] = [];
  const seen = new Set<string>();
  for (const criterion of parsed.completionCriteria) {
    if (typeof criterion !== "string") {
      return { valid: false, message: "Each task completion criterion must be a string." };
    }
    const trimmed = criterion.trim();
    if (!trimmed) {
      return { valid: false, message: "Task completion criteria must not be empty." };
    }
    if ([...trimmed].length > 300) {
      return {
        valid: false,
        message: "Each task completion criterion must be at most 300 characters.",
      };
    }
    if (seen.has(trimmed)) {
      return { valid: false, message: "Task completion criteria must be unique." };
    }
    seen.add(trimmed);
    completionCriteria.push(trimmed);
  }

  const plan = parsePlanSteps(parsed.plan, "Task declaration");
  if (!plan.valid) return plan;

  const excludedRequests = parseExcludedRequests(parsed.excludedRequests);
  if (!excludedRequests.valid) return excludedRequests;

  return {
    valid: true,
    input: { goal, completionCriteria, plan: plan.steps, excludedRequests: excludedRequests.items },
  };
}

export function parseScopeRedirect(argumentsValue: string): ScopeRedirectParseResult {
  if (hasDuplicateObjectKeys(argumentsValue)) {
    return { valid: false, message: "Scope redirect arguments must not contain duplicate keys." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsValue) as unknown;
  } catch {
    return { valid: false, message: "Scope redirect arguments must be valid JSON." };
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return { valid: false, message: "Scope redirect arguments must be a JSON object." };
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "suggestedRequest") {
    return {
      valid: false,
      message: 'Scope redirect accepts only "reason" and "suggestedRequest".',
    };
  }

  const reason = parseBoundedText(
    parsed.reason,
    maximumScopeRedirectFieldLength,
    "Scope redirect reason",
  );
  if (!reason.valid) return reason;
  const suggestedRequest = parseBoundedText(
    parsed.suggestedRequest,
    maximumScopeRedirectFieldLength,
    "Scope redirect suggestion",
  );
  if (!suggestedRequest.valid) return suggestedRequest;

  return { valid: true, input: { reason: reason.value, suggestedRequest: suggestedRequest.value } };
}

export function parsePlanRevision(argumentsValue: string): PlanRevisionParseResult {
  if (hasDuplicateObjectKeys(argumentsValue)) {
    return { valid: false, message: "Plan revision arguments must not contain duplicate keys." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsValue) as unknown;
  } catch {
    return { valid: false, message: "Plan revision arguments must be valid JSON." };
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return { valid: false, message: "Plan revision arguments must be a JSON object." };
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "plan" || keys[1] !== "reason") {
    return { valid: false, message: 'Plan revision accepts only "plan" and "reason".' };
  }

  if (typeof parsed.reason !== "string") {
    return { valid: false, message: "Plan revision reason must be a string." };
  }
  const reason = parsed.reason.trim();
  if (!reason) return { valid: false, message: "Plan revision reason must not be empty." };
  if ([...reason].length > maximumPlanRevisionReasonLength) {
    return {
      valid: false,
      message: `Plan revision reason must be at most ${maximumPlanRevisionReasonLength} characters.`,
    };
  }

  const plan = parsePlanSteps(parsed.plan, "Plan revision");
  if (!plan.valid) return plan;

  return { valid: true, input: { plan: plan.steps, reason } };
}

export function createTaskContract(input: TaskContractInput): TaskContract {
  return Object.freeze({
    taskId: randomUUID(),
    goal: input.goal,
    completionCriteria: Object.freeze([...input.completionCriteria]),
    plan: Object.freeze([...input.plan]),
    excludedRequests: Object.freeze([...(input.excludedRequests ?? [])]),
  });
}

function parseExcludedRequests(
  value: JsonValue | undefined,
): { valid: true; items: string[] } | { valid: false; message: string } {
  if (!Array.isArray(value))
    return { valid: false, message: "Task declaration excludedRequests must be an array." };
  if (value.length > maximumExcludedRequests) {
    return {
      valid: false,
      message: `Task declaration excludedRequests must contain 0 to ${maximumExcludedRequests} items.`,
    };
  }

  const items: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return { valid: false, message: "Each excluded request must be a string." };
    }
    const trimmed = item.trim();
    if (!trimmed) return { valid: false, message: "Excluded requests must not be empty." };
    if ([...trimmed].length > maximumExcludedRequestLength) {
      return {
        valid: false,
        message: `Each excluded request must be at most ${maximumExcludedRequestLength} characters.`,
      };
    }
    if (seen.has(trimmed)) {
      return { valid: false, message: "Excluded requests must be unique." };
    }
    seen.add(trimmed);
    items.push(trimmed);
  }

  return { valid: true, items };
}

function parseBoundedText(
  value: JsonValue | undefined,
  maximumLength: number,
  label: string,
): { valid: true; value: string } | { valid: false; message: string } {
  if (typeof value !== "string") return { valid: false, message: `${label} must be a string.` };
  const trimmed = value.trim();
  if (!trimmed) return { valid: false, message: `${label} must not be empty.` };
  if ([...trimmed].length > maximumLength) {
    return { valid: false, message: `${label} must be at most ${maximumLength} characters.` };
  }
  return { valid: true, value: trimmed };
}

function parsePlanSteps(
  value: JsonValue | undefined,
  label: "Task declaration" | "Plan revision",
): { valid: true; steps: string[] } | { valid: false; message: string } {
  if (!Array.isArray(value)) return { valid: false, message: `${label} plan must be an array.` };
  if (value.length < 1 || value.length > maximumPlanSteps) {
    return {
      valid: false,
      message: `${label} plan must contain 1 to ${maximumPlanSteps} steps.`,
    };
  }

  const steps: string[] = [];
  const seen = new Set<string>();
  for (const step of value) {
    if (typeof step !== "string") {
      return { valid: false, message: `Each ${label.toLowerCase()} plan step must be a string.` };
    }
    const trimmed = step.trim();
    if (!trimmed) return { valid: false, message: `${label} plan steps must not be empty.` };
    if ([...trimmed].length > maximumPlanStepLength) {
      return {
        valid: false,
        message: `Each ${label.toLowerCase()} plan step must be at most ${maximumPlanStepLength} characters.`,
      };
    }
    if (seen.has(trimmed)) {
      return { valid: false, message: `${label} plan steps must be unique.` };
    }
    seen.add(trimmed);
    steps.push(trimmed);
  }

  return { valid: true, steps };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDuplicateObjectKeys(text: string): boolean {
  let index = 0;
  const keys = new Set<string>();

  const skipWhitespace = (): void => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };

  const parseString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return text.slice(start, index);
      }
      index += 1;
    }
    throw new SyntaxError("Unterminated string.");
  };

  const skipValue = (): void => {
    skipWhitespace();
    if (text[index] === '"') {
      parseString();
      return;
    }
    if (text[index] !== "{" && text[index] !== "[") {
      while (index < text.length && text[index] !== "," && text[index] !== "}") index += 1;
      return;
    }

    const stack = [text[index] === "{" ? "}" : "]"];
    index += 1;
    while (stack.length > 0 && index < text.length) {
      if (text[index] === '"') {
        parseString();
        continue;
      }
      if (text[index] === "{" || text[index] === "[") {
        stack.push(text[index] === "{" ? "}" : "]");
      } else if (text[index] === "}" || text[index] === "]") {
        if (stack.at(-1) !== text[index]) throw new SyntaxError("Mismatched JSON brackets.");
        stack.pop();
      }
      index += 1;
    }
    if (stack.length > 0) throw new SyntaxError("Unterminated JSON value.");
  };

  try {
    skipWhitespace();
    if (text[index] !== "{") return false;
    index += 1;
    skipWhitespace();
    if (text[index] === "}") return false;

    while (index < text.length) {
      skipWhitespace();
      if (text[index] !== '"') throw new SyntaxError("Expected JSON object key.");
      const key = JSON.parse(parseString()) as unknown;
      if (typeof key !== "string") throw new SyntaxError("Invalid JSON object key.");
      if (keys.has(key)) return true;
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") throw new SyntaxError("Expected JSON colon.");
      index += 1;
      skipValue();
      skipWhitespace();
      if (text[index] === "}") return false;
      if (text[index] !== ",") throw new SyntaxError("Expected JSON comma.");
      index += 1;
    }
  } catch {
    return false;
  }
  return false;
}
