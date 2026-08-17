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
      /("[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]*"\s*:\s*)"(?:(?:\\.)|[^"\\])*"/gim,
      '$1"[REDACTED]"',
    )
    .replace(
      /('[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]*'\s*:\s*)'(?:(?:\\.)|[^'\\])*'/gim,
      "$1'[REDACTED]'",
    )
    .replace(
      /(\\"[A-Za-z0-9_-]*?(?:api[_-]?key|private[_-]?key|token|secret|password)[A-Za-z0-9_-]*\\"\s*:\s*)\\"(?:(?:\\.)|[^"\\])*\\"/gim,
      '$1\\"[REDACTED]\\"',
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
