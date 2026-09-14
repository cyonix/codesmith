import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
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

export function createFileLogWriter(
  filePath: string,
  report: (message: string) => void = (message) => stderr.write(`${message}\n`),
  options: {
    ownedDirectory?: string;
    append?: (fd: number, data: string) => void;
  } = {},
): FileLogWriter {
  const directory = path.dirname(filePath);
  const ownedDirectory = options.ownedDirectory ?? defaultLogDirectory();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    secureOwnedDirectory(directory, ownedDirectory);
    const fd = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
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
    throw new CodeSmithError(
      "configuration",
      `Could not create the log file ${filePath}. ${errorMessage(error)}`,
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
