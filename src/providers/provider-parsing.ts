import type { JsonValue } from "../shared/types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parsedObject(value: string): Record<string, JsonValue> {
  const parsed = parsedJson(value);
  return isRecord(parsed) ? parsed : {};
}

function parsedJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}
