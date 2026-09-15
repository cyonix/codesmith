import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
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

export const sessionLogMaximumBytes = 16 * 1024 * 1024;

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
    O_EXCL: number;
    O_NOFOLLOW?: number;
  } = constants,
): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("O_NOFOLLOW is not available.");
  }
  return (
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_APPEND |
    fsConstants.O_NOFOLLOW
  );
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
    projectRoot?: string;
    maximumBytes?: number;
    append?: (fd: number, data: string) => void;
  } = {},
): FileLogWriter {
  const directory = path.dirname(filePath);
  const maximumBytes = options.maximumBytes ?? sessionLogMaximumBytes;
  try {
    assertNoSymlinkPathComponents(filePath, options.projectRoot);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlinkPathComponents(filePath, options.projectRoot);
    if (options.ownedDirectory !== undefined)
      secureOwnedDirectory(directory, options.ownedDirectory);
    const { fd, path: logTargetPath } = openExclusiveLogFile(filePath);
    try {
      secureLogFile(fd);
      if (options.projectRoot !== undefined)
        assertOpenedLogOutsideProject(fd, logTargetPath, options.projectRoot);
      let writable = true;
      let closed = false;
      let writtenBytes = 0;
      return {
        write: (line: string): void => {
          if (!writable || closed) return;
          const payload = `${line}\n`;
          const size = Buffer.byteLength(payload, "utf8");
          if (writtenBytes + size > maximumBytes) {
            writable = false;
            report(
              escapeLogLine(
                `codesmith: Could not write to the log file ${logTargetPath}. The log file reached the maximum size.`,
              ),
            );
            return;
          }
          try {
            (options.append ?? appendFileSync)(fd, payload);
            writtenBytes += size;
          } catch (error) {
            writable = false;
            report(
              escapeLogLine(
                `codesmith: Could not write to the log file ${logTargetPath}. ${errorMessage(error)}`,
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
      try {
        closeSync(fd);
      } catch {
        // The containment check may already have closed this descriptor.
      }
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

function openExclusiveLogFile(filePath: string): { fd: number; path: string } {
  let candidate = filePath;
  let suffix = 0;

  while (true) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        throw new CodeSmithError(
          "configuration",
          `Could not create the log file ${escapeLogLine(candidate)}. The log path includes a symlink.`,
        );
      }
    } catch (error) {
      if (error instanceof CodeSmithError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }

    try {
      return { fd: openSync(candidate, logFileOpenFlags(), 0o600), path: candidate };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      suffix += 1;
      const extension = path.extname(candidate);
      const stem = candidate.slice(0, candidate.length - extension.length);
      candidate = `${stem}-${suffix}${extension}`;
    }
  }
}

function assertNoSymlinkPathComponents(target: string, projectRoot?: string): void {
  const resolved = path.resolve(target);
  const logDirectory = path.dirname(path.resolve(target));
  const components: string[] = [];
  let current = resolved;
  while (true) {
    components.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const component of components.reverse()) {
    try {
      if (!lstatSync(component).isSymbolicLink()) continue;
      const isLogLeaf = component === resolved || component === logDirectory;
      if (isLogLeaf) {
        throw new CodeSmithError(
          "configuration",
          `Could not create the log file ${escapeLogLine(target)}. The log path includes a symlink.`,
        );
      }
      if (
        projectRoot !== undefined &&
        isInsideDirectory(resolveExisting(projectRoot), realpathSync(component))
      ) {
        throw new CodeSmithError(
          "configuration",
          `Could not create the log file ${escapeLogLine(target)}. The log path is inside --project.`,
        );
      }
    } catch (error) {
      if (error instanceof CodeSmithError) throw error;
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

function assertOpenedLogOutsideProject(
  fd: number,
  logTargetPath: string,
  projectRoot: string,
): void {
  const resolved = realpathSync(logTargetPath);
  const fileStat = fstatSync(fd);
  const pathStat = statSync(resolved);
  if (fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
    throw new CodeSmithError(
      "configuration",
      `Could not create the log file ${escapeLogLine(logTargetPath)}. The opened log file does not match its path.`,
    );
  }
  if (!isInsideDirectory(resolveExisting(projectRoot), resolved)) return;

  try {
    closeSync(fd);
  } catch {
    // Unlink still proceeds from the inode snapshot.
  }
  try {
    const current = statSync(resolved);
    if (current.dev === fileStat.dev && current.ino === fileStat.ino) unlinkSync(resolved);
  } catch {
    // Startup still fails closed if cleanup cannot remove the file.
  }
  throw new CodeSmithError(
    "configuration",
    `Could not create the log file ${escapeLogLine(logTargetPath)}. The log path is inside --project.`,
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
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
