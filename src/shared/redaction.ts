export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+[^\s"'`,;:}\]]+/gi, "[REDACTED]")
    .replace(/\b(?:sk[-_]|gh[pousr]_+|github_pat_|hf_|xox[baprs]-)[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(
      /("[A-Za-z0-9_ -]*?(?:api[\s_-]?key|private[\s_-]?key|token|secret|password)[A-Za-z0-9_ -]*"\s*:\s*)"(?:(?:\\.)|[^"\\])*"/gim,
      '$1"[REDACTED]"',
    )
    .replace(
      /('[A-Za-z0-9_ -]*?(?:api[\s_-]?key|private[\s_-]?key|token|secret|password)[A-Za-z0-9_ -]*'\s*:\s*)'(?:(?:\\.)|[^'\\])*'/gim,
      "$1'[REDACTED]'",
    )
    .replace(
      /(\\"[A-Za-z0-9_ -]*?(?:api[\s_-]?key|private[\s_-]?key|token|secret|password)[A-Za-z0-9_ -]*\\"\s*:\s*)\\"(?:(?:\\.)|[^"\\])*\\"/gim,
      '$1\\"[REDACTED]\\"',
    )
    .replace(
      /\b(api\s+key)\s*[:=]\s*(?:"(?:(?:\\.)|[^"\\])*"|'(?:(?:\\.)|[^'\\])*'|[^\s,;]+)/gim,
      "$1 [REDACTED]",
    )
    .replace(
      /\b((?:(?:private|secret)(?:\s+access)?|access)\s+key)(?:\s*[:=]\s*|\s+(?:(?:value\s+)?(?:(?:is|was|equals|equal to)(?:\s*[:=]\s*|\s+))?))(?:"(?:(?:\\.)|[^"\\])*"|'(?:(?:\\.)|[^'\\])*'|[^,;\r\n]+)/gim,
      "$1 [REDACTED]",
    )
    .replace(
      /\b((?:[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|password)[A-Za-z0-9_-]*|secret(?!\s+(?:access\s+)?key\b)[A-Za-z0-9_-]*|api\s+key))\s+(?:(?:value\s+)?(?:(?:is|was|equals|equal to)(?:\s*[:=]\s*|\s+))?)?(?:"(?:(?:\\.)|[^"\\])*"|'(?:(?:\\.)|[^'\\])*'|[^,;\r\n]+)/gim,
      "$1 [REDACTED]",
    )
    .replace(
      /(^|[^A-Za-z0-9])(?:[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]*)\s*[:=]\s*"(?:(?:\\.)|[^"\\])*"/gim,
      "$1[REDACTED]",
    )
    .replace(
      /(^|[^A-Za-z0-9])(?:[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]*)\s*[:=]\s*'(?:(?:\\.)|[^'\\])*'/gim,
      "$1[REDACTED]",
    )
    .replace(
      /(^|[^A-Za-z0-9])(?:[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]*)\s*[:=]\s*[^\r\n]*/gim,
      "$1[REDACTED]",
    );
}

export const previewMaximumBytes = 4096;

export function previewSensitiveText(value: string): string {
  return truncateUtf8(redactSensitiveText(value).replace(/\s+/g, " ").trim(), previewMaximumBytes);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}
