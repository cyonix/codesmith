import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stderr } from "node:process";
import { CodeSmithError } from "../shared/errors.js";

export interface Logger {
  debug(message: string): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
}

export interface LogPathOptions {
  directory?: string;
  now?: Date;
  pid?: number;
}

export interface FileLogWriter {
  write: (line: string) => void;
  close: () => void;
}

export function assertFileLoggingSupported(platform = process.platform): void {
  if (platform !== "darwin") {
    throw new CodeSmithError("configuration", "File logs are supported on macOS only.");
  }
}

export function defaultLogDirectory(platform = process.platform, home = os.homedir()): string {
  assertFileLoggingSupported(platform);
  return path.join(home, "Library", "Logs", "codesmith");
}

export function assertLogFileOutsideProject(logFile: string, projectRoot: string): void {
  const resolvedLog = resolveExisting(logFile);
  const resolvedProject = resolveExisting(projectRoot);
  if (isInsideDirectory(resolvedProject, resolvedLog)) {
    throw new CodeSmithError(
      "configuration",
      `Could not create the log file ${escapeLogLine(logFile)}. The log path is inside --project.`,
    );
  }
}

export function logFileOpenFlags(
  fsConstants: {
    O_WRONLY: number;
    O_CREAT: number;
    O_APPEND: number;
    O_NOFOLLOW?: number;
  } = constants,
): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is not available.");
  }
  return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW;
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

export function createFileLogWriter(
  filePath: string,
  report: (message: string) => void = (message) => stderr.write(`${message}\n`),
  options: {
    ownedDirectory?: string;
    append?: (fd: number, data: string) => void;
  } = {},
): FileLogWriter {
  const directory = path.dirname(filePath);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (options.ownedDirectory !== undefined)
      secureOwnedDirectory(directory, options.ownedDirectory);
    const fd = openSync(filePath, logFileOpenFlags(), 0o600);
    try {
      secureLogFile(fd);
      let writable = true;
      let closed = false;
      return {
        write: (line: string): void => {
          if (!writable || closed) return;
          try {
            (options.append ?? appendFileSync)(fd, `${line}\n`);
          } catch (error) {
            writable = false;
            report(
              escapeLogLine(
                `codesmith: Could not write to the log file ${filePath}. ${errorMessage(error)}`,
              ),
            );
          }
        },
        close: (): void => {
          if (closed) return;
          closed = true;
          writable = false;
          try {
            closeSync(fd);
          } catch {
            // Shutdown continues if the descriptor is already closed.
          }
        },
      };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } catch (error) {
    if (error instanceof CodeSmithError) throw error;
    throw new CodeSmithError(
      "configuration",
      `Could not create the log file ${escapeLogLine(filePath)}. ${escapeLogLine(errorMessage(error))}`,
    );
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line) => stderr.write(`${line}\n`));

  return {
    debug(message) {
      for (const line of message.split("\n")) write(`debug ${escapeLogLine(line)}`);
    },
  };
}

function resolveExisting(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  while (true) {
    try {
      const canonical = realpathSync(current);
      if (current === resolved) return canonical;
      return path.join(canonical, path.relative(current, resolved));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      current = parent;
    }
  }
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function isOwnedLogDirectory(directory: string, ownedDirectory: string): boolean {
  return isInsideDirectory(ownedDirectory, directory);
}

function secureOwnedDirectory(directory: string, ownedDirectory: string): void {
  if (!isOwnedLogDirectory(directory, ownedDirectory)) return;
  chmodSync(directory, 0o700);
}

function secureLogFile(fd: number): void {
  fchmodSync(fd, 0o600);
}

function escapeLogLine(line: string): string {
  return [...line]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) return character;
      if (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      ) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      return character;
    })
    .join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected failure.";
}
