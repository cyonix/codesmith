import path from "node:path";

export const omittedSecretPreview = "[omitted secret file]";

export function isSensitiveToolPayload(argumentsValue: string, result?: string): boolean {
  if (touchesSecretFile(argumentsValue)) return true;
  if (result === undefined) return false;
  return resultReferencesSecretFile(result) || resultContainsSensitiveDiff(result);
}

export function touchesSecretFile(argumentsValue: string): boolean {
  try {
    const parsed: unknown = JSON.parse(argumentsValue);
    return hasStringPath(parsed) && isSecretPath(parsed.path);
  } catch {
    return false;
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

function hasStringPath(value: unknown): value is { path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "path" in value &&
    typeof value.path === "string"
  );
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
