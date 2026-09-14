import path from "node:path";

export const omittedSecretPreview = "[omitted secret file]";

export function isSensitiveToolPayload(
  toolName: string,
  argumentsValue: string,
  result?: string,
): boolean {
  if (touchesSecretFile(toolName, argumentsValue)) return true;
  if (result === undefined) return false;
  return resultReferencesSecretFile(result) || resultContainsSensitiveDiff(result);
}

export function touchesSecretFile(toolName: string, argumentsValue: string): boolean {
  try {
    const parsed: unknown = JSON.parse(argumentsValue);
    return !hasValidPathToolArguments(toolName, parsed) || isSecretToolPath(parsed);
  } catch {
    return true;
  }
}

export function resultReferencesSecretFile(result: string): boolean {
  try {
    return containsSecretPath(JSON.parse(result));
  } catch {
    return false;
  }
}

export function resultContainsSensitiveDiff(result: string): boolean {
  try {
    return containsSensitiveDiff(JSON.parse(result));
  } catch {
    return false;
  }
}

function containsSecretPath(value: unknown): boolean {
  if (typeof value === "string") return textReferencesSecretPath(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretPath(item));
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === "path" && typeof item === "string" && isSecretPath(item)) return true;
    if (containsSecretPath(item)) return true;
  }
  return false;
}

function textReferencesSecretPath(value: string): boolean {
  return value
    .split(/\s+/)
    .map((token) =>
      token.replace(/^(?:a|b)\//, "").replace(/^[^A-Za-z0-9._/-]+|[^A-Za-z0-9._/-]+$/g, ""),
    )
    .some((token) => isSecretPath(token));
}

function containsSensitiveDiff(value: unknown): boolean {
  if (typeof value === "string")
    return value.split("\n").some((line) => {
      if (!/^[+-](?![+-])/.test(line)) return false;
      return (
        /(?:api[_-]?key|private[_-]?key|token|secret|password|database[_-]?url)\s*[:=]/i.test(
          line,
        ) || /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i.test(line)
      );
    });
  if (Array.isArray(value)) return value.some((item) => containsSensitiveDiff(item));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => containsSensitiveDiff(item));
}

function isSecretToolPath(value: unknown): boolean {
  return hasStringPath(value) && isSecretPath(value.path);
}

function hasValidPathToolArguments(toolName: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (toolName) {
    case "list_files":
      return hasOptionalString(value, "path");
    case "search_files":
      return hasRequiredString(value, "query") && hasOptionalString(value, "path");
    case "read_file":
    case "delete_file":
      return hasRequiredString(value, "path");
    case "create_file":
      return hasRequiredString(value, "path") && hasRequiredString(value, "content");
    case "apply_patch":
      return (
        hasRequiredString(value, "path") &&
        hasRequiredString(value, "expected_content") &&
        hasRequiredString(value, "replacement")
      );
    default:
      return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringPath(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string";
}

function hasRequiredString(value: Record<string, unknown>, field: string): boolean {
  return typeof value[field] === "string" && value[field].length > 0;
}

function hasOptionalString(value: Record<string, unknown>, field: string): boolean {
  return value[field] === undefined || hasRequiredString(value, field);
}

function isSecretPath(value: string): boolean {
  const baseName = path.basename(value).toLowerCase();
  return (
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    baseName === ".git-credentials" ||
    baseName === ".netrc" ||
    baseName === ".npmrc" ||
    baseName === ".pypirc" ||
    baseName.startsWith("credentials") ||
    baseName.startsWith("service-account") ||
    baseName.startsWith("service_account") ||
    baseName.startsWith("id_") ||
    [".pem", ".key", ".p12", ".pfx"].some((extension) => baseName.endsWith(extension))
  );
}
