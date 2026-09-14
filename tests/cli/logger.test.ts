import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

void test("escapes terminal controls in log lines", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });

  logger.debug("prompt\u001b[2J\u009b2J\u202eend");

  assert.deepEqual(lines, ["debug prompt\\u001b[2J\\u009b2J\\u202eend"]);
  assert.doesNotMatch(lines[0] ?? "", new RegExp(`[${String.fromCodePoint(0x1b, 0x9b, 0x202e)}]`));
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

void test("escapes a custom log path when a later write fails", () => {
  const reports: string[] = [];
  const filePath = "log\u001b[2J\n\u202efailure.log";
  try {
    const write = createFileLogWriter(
      filePath,
      (message) => {
        reports.push(message);
      },
      {
        append: () => {
          throw new Error("disk\u001b[2J\n\u202efull");
        },
      },
    );

    write("debug [status] thinking");

    assert.deepEqual(reports, [
      "codesmith: Could not write to the log file log\\u001b[2J\\u000a\\u202efailure.log. disk\\u001b[2J\\u000a\\u202efull",
    ]);
  } finally {
    rmSync(filePath, { force: true });
  }
});

void test("keeps writes bound to the secured log file after path replacement", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  const targetPath = path.join(directory, "target.log");
  writeFileSync(targetPath, "target contents\n");
  const write = createFileLogWriter(filePath);
  write("debug [status] thinking");
  rmSync(filePath);
  symlinkSync(targetPath, filePath);

  assert.doesNotThrow(() => write("debug [status] waiting"));
  assert.equal(readFileSync(targetPath, "utf8"), "target contents\n");
});

void test("tightens an existing log file and owned directory permissions", () => {
  const owned = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  chmodSync(owned, 0o755);
  const filePath = path.join(owned, "session.log");
  writeFileSync(filePath, "", { mode: 0o644 });
  chmodSync(filePath, 0o644);

  createFileLogWriter(filePath, () => {}, { ownedDirectory: owned });

  if (process.platform !== "win32") {
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(statSync(owned).mode & 0o777, 0o700);
  }
});

void test("does not chmod a custom parent directory", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "codesmith-custom-log-"));
  chmodSync(parent, 0o755);
  const filePath = path.join(parent, "custom.log");

  createFileLogWriter(filePath, () => {}, { ownedDirectory: path.join(parent, "not-owned") });

  if (process.platform !== "win32") {
    assert.equal(statSync(parent).mode & 0o777, 0o755);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  }
});
