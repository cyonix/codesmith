import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFileLogWriter,
  createLogger,
  defaultLogDirectory,
  defaultLogFilePath,
  resolveLogFilePath,
  resolveLogLevel,
} from "../../src/cli/logger.js";

void test("writes leveled lines and hides messages below the configured level", () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "warn",
    write: (line) => lines.push(line),
  });

  logger.debug("hidden debug");
  logger.info("hidden info");
  logger.warn("visible warn");
  logger.error("visible error\nsecond line");

  assert.deepEqual(lines, ["warn visible warn", "error visible error", "error second line"]);
});

void test("resolves the flag before the environment level", () => {
  assert.equal(resolveLogLevel("info", "debug"), "info");
  assert.equal(resolveLogLevel(undefined, "error"), "error");
  assert.equal(resolveLogLevel(undefined, undefined), "debug");
});

void test("selects a platform log directory outside the project", () => {
  assert.equal(
    defaultLogDirectory("darwin", {}, "/Users/dev"),
    path.join("/Users/dev", "Library", "Logs", "codesmith"),
  );
  assert.equal(
    defaultLogDirectory("linux", { XDG_STATE_HOME: "/var/state" }, "/home/dev"),
    path.join("/var/state", "codesmith"),
  );
  assert.equal(
    defaultLogDirectory("win32", { LOCALAPPDATA: "C:\\Data" }, "C:\\Users\\dev"),
    path.join("C:\\Data", "CodeSmith", "Logs"),
  );
});

void test("resolves a session log file and keeps '-' on stderr", () => {
  const directory = path.join("/tmp", "codesmith-logs");
  const now = new Date("2026-08-18T19:58:16.397Z");
  assert.equal(
    resolveLogFilePath(undefined, undefined, { directory, now, pid: 42 }),
    path.join(directory, "codesmith-2026-08-18T19-58-16Z-42.log"),
  );
  assert.equal(resolveLogFilePath("/tmp/custom.log", undefined), path.resolve("/tmp/custom.log"));
  assert.equal(resolveLogFilePath(undefined, "/tmp/env.log"), path.resolve("/tmp/env.log"));
  assert.equal(resolveLogFilePath("session.log", undefined), path.resolve("session.log"));
  assert.equal(resolveLogFilePath("-", "/tmp/env.log"), undefined);
  assert.equal(defaultLogFilePath({ directory, now, pid: 42 }).endsWith(".log"), true);
});

void test("appends logger lines to a file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  const logger = createLogger({
    level: "debug",
    write: createFileLogWriter(filePath),
  });

  logger.debug("[status] thinking");
  logger.debug("[llm] [user] write some code");

  assert.equal(
    readFileSync(filePath, "utf8"),
    "debug [status] thinking\ndebug [llm] [user] write some code\n",
  );
});

void test("keeps later log writes from throwing after a file write fails", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  const reports: string[] = [];
  const write = createFileLogWriter(filePath, (message) => reports.push(message));
  rmSync(filePath);
  mkdirSync(filePath);

  assert.doesNotThrow(() => write("debug [status] thinking"));
  assert.doesNotThrow(() => write("debug [status] waiting"));
  assert.equal(reports.length, 1);
  assert.match(reports[0] ?? "", /Could not write to the log file/);
});
