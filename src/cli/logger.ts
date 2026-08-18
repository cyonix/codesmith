import { stderr } from "node:process";
import { CodeSmithError } from "../shared/errors.js";

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
}

export function parseLogLevel(value: string): LogLevel {
  if (isLogLevel(value)) return value;
  throw new CodeSmithError("configuration", `log level must be one of ${logLevels.join(", ")}.`);
}

export function resolveLogLevel(
  flag: string | undefined,
  environmentLevel = process.env.CODESMITH_LOG_LEVEL,
): LogLevel {
  return parseLogLevel(flag ?? environmentLevel ?? "debug");
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = levelRank[options.level ?? "debug"];
  const write = options.write ?? ((line) => stderr.write(`${line}\n`));

  const log = (level: LogLevel, message: string): void => {
    if (levelRank[level] < minimum) return;
    for (const line of message.split("\n")) write(`${level} ${line}`);
  };

  return {
    debug: (message) => log("debug", message),
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message),
  };
}

function isLogLevel(value: string): value is LogLevel {
  return logLevels.some((level) => level === value);
}
