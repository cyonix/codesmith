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
    if (jsonHasDuplicateKeys(argumentsValue)) return true;
    const parsed: unknown = JSON.parse(argumentsValue);
    return !hasValidPathToolArguments(toolName, parsed) || isSecretToolPath(parsed);
  } catch {
    return true;
  }
}

export function argumentsReferenceSecretPath(argumentsValue: string): boolean {
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
        /(?:api[\s_-]?key|private[\s_-]?key|token|secret|password|database[\s_-]?url)\s*[:=]/i.test(
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
  if (toolName === "run_command") return false;

  switch (toolName) {
    case "list_files":
      return hasExactStringFields(value, [], ["path"]);
    case "search_files":
      return hasExactStringFields(value, ["query"], ["path"]);
    case "read_file":
    case "delete_file":
      return hasExactStringFields(value, ["path"]);
    case "create_file":
      return hasExactStringFields(value, ["path", "content"]);
    case "apply_patch":
      return hasExactStringFields(value, ["path", "expected_content", "replacement"]);
    case "git_status":
    case "git_diff":
      return hasExactStringFields(value, []);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringPath(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string";
}

function hasExactStringFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  if (!Object.keys(value).every((field) => allowed.has(field))) return false;
  if (!required.every((field) => isNonEmptyString(value[field]))) return false;
  return optional.every((field) => value[field] === undefined || isNonEmptyString(value[field]));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function jsonHasDuplicateKeys(text: string): boolean {
  try {
    return scanJsonForDuplicateKeys(text);
  } catch {
    return true;
  }
}

function scanJsonForDuplicateKeys(text: string): boolean {
  let index = 0;

  const peek = (): string | undefined => text[index];

  const skipWhitespace = (): void => {
    while (index < text.length) {
      const character = text[index];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r")
        break;
      index += 1;
    }
  };

  const parseString = (): string => {
    index += 1;
    let result = "";
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return result;
      }
      if (character !== "\\") {
        result += character;
        index += 1;
        continue;
      }
      const escaped = text[index + 1];
      if (escaped === undefined) throw new SyntaxError("Unterminated string.");
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("Invalid unicode escape.");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      result += unescapeJsonCharacter(escaped);
      index += 2;
    }
    throw new SyntaxError("Unterminated string.");
  };

  const parseObject = (): boolean => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (peek() === "}") {
      index += 1;
      return false;
    }
    while (index < text.length) {
      skipWhitespace();
      if (peek() !== '"') throw new SyntaxError("Expected property name.");
      const key = parseString();
      if (keys.has(key)) return true;
      keys.add(key);
      skipWhitespace();
      if (peek() !== ":") throw new SyntaxError("Expected colon.");
      index += 1;
      if (parseValue()) return true;
      skipWhitespace();
      if (peek() === ",") {
        index += 1;
        continue;
      }
      if (peek() === "}") {
        index += 1;
        return false;
      }
      throw new SyntaxError("Expected comma or closing brace.");
    }
    throw new SyntaxError("Unterminated object.");
  };

  const parseArray = (): boolean => {
    index += 1;
    skipWhitespace();
    if (peek() === "]") {
      index += 1;
      return false;
    }
    while (index < text.length) {
      if (parseValue()) return true;
      skipWhitespace();
      if (peek() === ",") {
        index += 1;
        continue;
      }
      if (peek() === "]") {
        index += 1;
        return false;
      }
      throw new SyntaxError("Expected comma or closing bracket.");
    }
    throw new SyntaxError("Unterminated array.");
  };

  const parseLiteralOrNumber = (): void => {
    if (text.startsWith("true", index)) {
      index += 4;
      return;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return;
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (match === null) throw new SyntaxError("Invalid value.");
    index += match[0].length;
  };

  const parseValue = (): boolean => {
    skipWhitespace();
    const character = peek();
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') {
      parseString();
      return false;
    }
    parseLiteralOrNumber();
    return false;
  };

  const duplicate = parseValue();
  skipWhitespace();
  if (index !== text.length) throw new SyntaxError("Unexpected trailing data.");
  return duplicate;
}

function unescapeJsonCharacter(escaped: string): string {
  switch (escaped) {
    case '"':
    case "\\":
    case "/":
      return escaped;
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      throw new SyntaxError("Invalid escape.");
  }
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
