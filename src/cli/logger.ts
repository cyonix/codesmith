import { appendFileSync, chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

export interface LogPathOptions {
  directory?: string;
  now?: Date;
  pid?: number;
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

export function defaultLogDirectory(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Logs", "codesmith");
  if (platform === "win32")
    return path.join(
      environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "CodeSmith",
      "Logs",
    );
  const xdgStateHome = environment.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome && path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(home, ".local", "state");
  return path.join(stateHome, "codesmith");
}

export function defaultLogFilePath(options: LogPathOptions = {}): string {
  const directory = options.directory ?? defaultLogDirectory();
  const now = options.now ?? new Date();
  const pid = options.pid ?? process.pid;
  const stamp = now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(directory, `codesmith-${stamp}-${pid}.log`);
}

export function resolveLogFilePath(
  flag: string | undefined,
  environmentFile = process.env.CODESMITH_LOG_FILE,
  options: LogPathOptions = {},
): string | undefined {
  const selected = flag ?? environmentFile;
  if (selected === "-") return undefined;
  if (selected) return path.resolve(selected);
  return defaultLogFilePath(options);
}

export function createFileLogWriter(
  filePath: string,
  report: (message: string) => void = (message) => stderr.write(`${message}\n`),
  options: { ownedDirectory?: string } = {},
): (line: string) => void {
  const directory = path.dirname(filePath);
  const ownedDirectory = options.ownedDirectory ?? defaultLogDirectory();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    secureOwnedDirectory(directory, ownedDirectory);
    const fd = openSync(filePath, "a", 0o600);
    try {
      secureLogFile(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new CodeSmithError(
      "configuration",
      `Could not create the log file ${filePath}. ${errorMessage(error)}`,
    );
  }

  let writable = true;
  return (line: string) => {
    if (!writable) return;
    try {
      appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      writable = false;
      report(`codesmith: Could not write to the log file ${filePath}. ${errorMessage(error)}`);
    }
  };
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

function isOwnedLogDirectory(directory: string, ownedDirectory: string): boolean {
  const resolved = path.resolve(directory);
  const owned = path.resolve(ownedDirectory);
  return resolved === owned || resolved.startsWith(`${owned}${path.sep}`);
}

function secureOwnedDirectory(directory: string, ownedDirectory: string): void {
  if (!isOwnedLogDirectory(directory, ownedDirectory)) return;
  try {
    chmodSync(directory, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function secureLogFile(fd: number): void {
  try {
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function isLogLevel(value: string): value is LogLevel {
  return logLevels.some((level) => level === value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected failure.";
}
