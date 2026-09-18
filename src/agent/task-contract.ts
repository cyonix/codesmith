import { randomUUID } from "node:crypto";
import type { JsonValue, ToolDefinition } from "../shared/types.js";

export const taskContractToolName = "declare_task";

export interface TaskContract {
  taskId: string;
  goal: string;
  completionCriteria: string[];
}

export interface TaskContractInput {
  goal: string;
  completionCriteria: string[];
}

export type TaskContractParseResult =
  { valid: true; input: TaskContractInput } | { valid: false; message: string };

export const taskContractToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: taskContractToolName,
    description:
      "Declare the goal and observable completion criteria for this submission before using any workspace tool.",
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
      },
      required: ["goal", "completionCriteria"],
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
  if (keys.length !== 2 || keys[0] !== "completionCriteria" || keys[1] !== "goal") {
    return {
      valid: false,
      message: 'Task declaration accepts only "goal" and "completionCriteria".',
    };
  }

  if (typeof parsed.goal !== "string") {
    return { valid: false, message: "Task declaration goal must be a string." };
  }

  const goal = parsed.goal.trim();
  if (!goal) return { valid: false, message: "Task declaration goal must not be empty." };
  if (goal.length > 500) {
    return { valid: false, message: "Task declaration goal must be at most 500 characters." };
  }

  if (!Array.isArray(parsed.completionCriteria)) {
    return { valid: false, message: "Task declaration criteria must be an array." };
  }
  if (parsed.completionCriteria.length < 1 || parsed.completionCriteria.length > 8) {
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
    if (trimmed.length > 300) {
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

  return { valid: true, input: { goal, completionCriteria } };
}

export function createTaskContract(input: TaskContractInput): TaskContract {
  return { taskId: randomUUID(), ...input };
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
