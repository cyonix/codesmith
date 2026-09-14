import assert from "node:assert/strict";
import {
  chmodSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { CodeSmithError } from "../../src/shared/errors.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFileLogWriter,
  createLogger,
  defaultLogDirectory,
  defaultLogFilePath,
} from "../../src/cli/logger.js";

void test("writes debug lines and escapes terminal controls", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });

  logger.debug("prompt\u001b[2J\u009b2J\u202eend");
  logger.debug("first\nsecond");

  assert.deepEqual(lines, [
    "debug prompt\\u001b[2J\\u009b2J\\u202eend",
    "debug first",
    "debug second",
  ]);
  assert.doesNotMatch(lines[0] ?? "", new RegExp(`[${String.fromCodePoint(0x1b, 0x9b, 0x202e)}]`));
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
    defaultLogDirectory("linux", { XDG_STATE_HOME: "relative" }, "/home/dev"),
    path.join("/home/dev", ".local", "state", "codesmith"),
  );
  assert.equal(
    defaultLogDirectory("win32", { LOCALAPPDATA: "C:\\Data" }, "C:\\Users\\dev"),
    path.join("C:\\Data", "CodeSmith", "Logs"),
  );
});

void test("names a per-session log file with a timestamp and process id", () => {
  const directory = path.join("/tmp", "codesmith-logs");
  const now = new Date("2026-08-18T19:58:16.397Z");
  assert.equal(
    defaultLogFilePath({ directory, now, pid: 42 }),
    path.join(directory, "codesmith-2026-08-18T19-58-16Z-42.log"),
  );
});

void test("appends logger lines to a file and closes the descriptor", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  const fileLog = createFileLogWriter(filePath);
  const logger = createLogger({ write: fileLog.write });

  logger.debug("[status] thinking");
  logger.debug("[provider_request] [user] write some code");
  fileLog.close();
  fileLog.write("debug [status] ignored-after-close");

  assert.equal(
    readFileSync(filePath, "utf8"),
    "debug [status] thinking\ndebug [provider_request] [user] write some code\n",
  );
});

void test("escapes a log path when a later write fails and reports once", () => {
  const reports: string[] = [];
  const filePath = "log\u001b[2J\n\u202efailure.log";
  const fileLog = createFileLogWriter(
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
  try {
    fileLog.write("debug [status] thinking");
    fileLog.write("debug [status] again");

    assert.deepEqual(reports, [
      "codesmith: Could not write to the log file log\\u001b[2J\\u000a\\u202efailure.log. disk\\u001b[2J\\u000a\\u202efull",
    ]);
  } finally {
    fileLog.close();
    rmSync(filePath, { force: true });
  }
});

void test("keeps writes bound to the secured log file after path replacement", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  const targetPath = path.join(directory, "target.log");
  writeFileSync(targetPath, "target contents\n");
  const fileLog = createFileLogWriter(filePath);
  try {
    fileLog.write("debug [status] thinking");
    rmSync(filePath);
    symlinkSync(targetPath, filePath);

    assert.doesNotThrow(() => fileLog.write("debug [status] waiting"));
    assert.equal(readFileSync(targetPath, "utf8"), "target contents\n");
  } finally {
    fileLog.close();
  }
});

void test("tightens an existing log file and owned directory permissions", () => {
  const owned = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  chmodSync(owned, 0o755);
  const filePath = path.join(owned, "session.log");
  writeFileSync(filePath, "", { mode: 0o644 });
  chmodSync(filePath, 0o644);

  const fileLog = createFileLogWriter(filePath, () => {}, { ownedDirectory: owned });
  fileLog.close();

  if (process.platform !== "win32") {
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(statSync(owned).mode & 0o777, 0o700);
  }
});

void test("does not chmod a parent directory outside the owned log directory", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "codesmith-custom-log-"));
  chmodSync(parent, 0o755);
  const filePath = path.join(parent, "custom.log");

  const fileLog = createFileLogWriter(filePath, () => {}, {
    ownedDirectory: path.join(parent, "not-owned"),
  });
  fileLog.close();

  if (process.platform !== "win32") {
    assert.equal(statSync(parent).mode & 0o777, 0o755);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  }
});

void test("fails closed when the log file cannot be created", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const blocker = path.join(parent, "not-a-directory");
  writeFileSync(blocker, "file");
  const filePath = path.join(blocker, "session.log");

  assert.throws(
    () => createFileLogWriter(filePath),
    (error: unknown) => {
      assert.ok(error instanceof CodeSmithError);
      assert.equal(error.kind, "configuration");
      assert.match(error.message, /Could not create the log file/);
      return true;
    },
  );
});

void test(
  "rejects a log path that is a symlink",
  { skip: process.platform === "win32" || constants.O_NOFOLLOW === undefined },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
    const targetPath = path.join(directory, "target.log");
    const filePath = path.join(directory, "session.log");
    writeFileSync(targetPath, "target contents\n");
    symlinkSync(targetPath, filePath);

    assert.throws(
      () => createFileLogWriter(filePath),
      (error: unknown) => {
        assert.ok(error instanceof CodeSmithError);
        assert.equal(error.kind, "configuration");
        assert.match(error.message, /Could not create the log file/);
        return true;
      },
    );
    assert.equal(readFileSync(targetPath, "utf8"), "target contents\n");
  },
);
