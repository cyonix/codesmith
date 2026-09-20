import assert from "node:assert/strict";
import {
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  assertFileLoggingSupported,
  assertLogFileOutsideProject,
  createFileLogWriter,
  createLogger,
  defaultLogDirectory,
  defaultLogFilePath,
  formatLogTimestamp,
  logFileOpenFlags,
} from "../../src/cli/logger.js";

class FixedLocalDate extends Date {
  override getFullYear(): number {
    return 2026;
  }

  override getMonth(): number {
    return 8;
  }

  override getDate(): number {
    return 20;
  }

  override getHours(): number {
    return 17;
  }

  override getMinutes(): number {
    return 43;
  }

  override getSeconds(): number {
    return 21;
  }

  override getMilliseconds(): number {
    return 624;
  }

  override getTimezoneOffset(): number {
    return 300;
  }
}

void test("writes debug lines and escapes terminal controls", () => {
  const lines: string[] = [];
  const timestamp = new Date("2026-09-20T22:43:21.624Z");
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => timestamp,
  });

  logger.debug("prompt\u001b[2J\u009b2J\u2028\u2029\u202eend");
  logger.debug("first\nsecond");

  assert.deepEqual(lines, [
    `${formatLogTimestamp(timestamp)} debug prompt\\u001b[2J\\u009b2J\\u2028\\u2029\\u202eend`,
    `${formatLogTimestamp(timestamp)} debug first`,
    `${formatLogTimestamp(timestamp)} debug second`,
  ]);
  assert.doesNotMatch(
    lines[0] ?? "",
    new RegExp(`[${String.fromCodePoint(0x1b, 0x9b, 0x2028, 0x2029, 0x202e)}]`),
  );
});

void test("timestamps each physical line independently", () => {
  const lines: string[] = [];
  const timestamps = [new Date("2026-09-20T22:43:21.624Z"), new Date("2026-09-20T22:43:21.625Z")];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => timestamps.shift() ?? new Date("2026-09-20T22:43:21.625Z"),
  });

  logger.debug("first\nsecond");

  assert.deepEqual(lines, [
    `${formatLogTimestamp(new Date("2026-09-20T22:43:21.624Z"))} debug first`,
    `${formatLogTimestamp(new Date("2026-09-20T22:43:21.625Z"))} debug second`,
  ]);
});

void test("formats local timestamps with milliseconds and an offset", () => {
  assert.equal(formatLogTimestamp(new FixedLocalDate()), "2026-09-20 17:43:21.624 -0500");
});

void test("selects the macOS log directory outside the project", () => {
  assert.equal(
    defaultLogDirectory("darwin", "/Users/dev"),
    path.join("/Users/dev", "Library", "Logs", "codesmith"),
  );
});

void test("refuses file logging on platforms other than macOS", () => {
  for (const platform of ["linux", "win32"] as const) {
    assert.throws(
      () => assertFileLoggingSupported(platform),
      (error: unknown) => {
        assert.ok(error instanceof CodeSmithError);
        assert.equal(error.kind, "configuration");
        assert.match(error.message, /macOS only/);
        return true;
      },
    );
    assert.throws(
      () => defaultLogDirectory(platform, "/home/dev"),
      (error: unknown) => {
        assert.ok(error instanceof CodeSmithError);
        assert.equal(error.kind, "configuration");
        assert.match(error.message, /macOS only/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => assertFileLoggingSupported("darwin"));
});

void test("refuses a log path inside the selected project", () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "codesmith-project-"));
  const inside = path.join(project, "Library", "Logs", "codesmith", "session.log");
  const outside = path.join(os.tmpdir(), "codesmith-outside-logs", "session.log");

  assert.throws(
    () => assertLogFileOutsideProject(inside, project),
    (error: unknown) => {
      assert.ok(error instanceof CodeSmithError);
      assert.equal(error.kind, "configuration");
      assert.match(error.message, /inside --project/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertLogFileOutsideProject(outside, project));
  assert.throws(
    () =>
      assertLogFileOutsideProject(
        path.join("/Users/dev", "Library", "Logs", "codesmith", "session.log"),
        "/",
      ),
    (error: unknown) => {
      assert.ok(error instanceof CodeSmithError);
      assert.equal(error.kind, "configuration");
      assert.match(error.message, /inside --project/);
      return true;
    },
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
  const timestamp = new Date("2026-09-20T22:43:21.624Z");
  const logger = createLogger({ write: fileLog.write, now: () => timestamp });

  logger.debug("[status] thinking");
  logger.debug("[provider_request] [user] write some code");
  fileLog.close();
  fileLog.write("debug [status] ignored-after-close");

  assert.equal(
    readFileSync(filePath, "utf8"),
    `${formatLogTimestamp(timestamp)} debug [status] thinking\n${formatLogTimestamp(timestamp)} debug [provider_request] [user] write some code\n`,
  );
});

void test("creates a fresh log file when the default name already exists", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  writeFileSync(filePath, "existing\n");

  const fileLog = createFileLogWriter(filePath);
  try {
    fileLog.write("debug [status] fresh");
    const names = readdirSync(directory).sort();
    const created = names.filter((name) => name.endsWith(".log") && name !== "session.log");

    assert.equal(created.length, 1);
    assert.equal(readFileSync(filePath, "utf8"), "existing\n");
    assert.equal(
      readFileSync(path.join(directory, created[0] ?? ""), "utf8"),
      "debug [status] fresh\n",
    );
  } finally {
    fileLog.close();
  }
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
    const names = readdirSync(owned).sort();
    const created = names.filter((name) => name.endsWith(".log") && name !== "session.log");

    assert.equal(created.length, 1);
    assert.equal(statSync(filePath).mode & 0o777, 0o644);
    assert.equal(statSync(path.join(owned, created[0] ?? "")).mode & 0o777, 0o600);
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
  const filePath = path.join(blocker, "session\u001b[2J.log");

  assert.throws(
    () => createFileLogWriter(filePath),
    (error: unknown) => {
      assert.ok(error instanceof CodeSmithError);
      assert.equal(error.kind, "configuration");
      assert.match(error.message, /Could not create the log file/);
      assert.match(error.message, /session\\u001b\[2J\.log/);
      assert.doesNotMatch(error.message, new RegExp(String.fromCodePoint(0x1b)));
      return true;
    },
  );
});

void test("fails closed when O_NOFOLLOW is not available", () => {
  assert.throws(
    () =>
      logFileOpenFlags({
        O_WRONLY: constants.O_WRONLY,
        O_CREAT: constants.O_CREAT,
        O_APPEND: constants.O_APPEND,
        O_EXCL: constants.O_EXCL,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /O_NOFOLLOW is not available/);
      return true;
    },
  );
});

void test("stops writing when the session log reaches the maximum size", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-"));
  const filePath = path.join(directory, "session.log");
  const reports: string[] = [];
  const fileLog = createFileLogWriter(filePath, (message) => reports.push(message), {
    maximumBytes: 10,
  });
  try {
    fileLog.write("123456789");
    fileLog.write("123456789");

    assert.equal(readFileSync(filePath, "utf8"), "123456789\n");
    assert.deepEqual(reports, [
      `codesmith: Could not write to the log file ${filePath}. The log file reached the maximum size.`,
    ]);
  } finally {
    fileLog.close();
  }
});

void test("rejects a log path that is a symlink", { skip: process.platform === "win32" }, () => {
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
});

void test(
  "rejects a log directory that is a symlink",
  { skip: process.platform === "win32" },
  () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "codesmith-project-"));
    const parent = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-parent-"));
    const logDirectory = path.join(parent, "codesmith");
    symlinkSync(project, logDirectory);
    const filePath = path.join(logDirectory, "session.log");

    assert.throws(
      () => createFileLogWriter(filePath, () => {}, { projectRoot: project }),
      (error: unknown) => {
        assert.ok(error instanceof CodeSmithError);
        assert.equal(error.kind, "configuration");
        assert.match(error.message, /symlink/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(project, "session.log")), false);
  },
);

void test(
  "rejects a parent symlink that resolves inside the project",
  { skip: process.platform === "win32" },
  () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "codesmith-project-"));
    const outer = mkdtempSync(path.join(os.tmpdir(), "codesmith-log-outer-"));
    const logsLink = path.join(outer, "Logs");
    symlinkSync(project, logsLink);
    const filePath = path.join(logsLink, "codesmith", "session.log");

    assert.throws(
      () => createFileLogWriter(filePath, () => {}, { projectRoot: project }),
      (error: unknown) => {
        assert.ok(error instanceof CodeSmithError);
        assert.equal(error.kind, "configuration");
        assert.match(error.message, /inside --project/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(project, "codesmith", "session.log")), false);
  },
);

void test("removes an opened log file that resolves inside the project", () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "codesmith-project-"));
  const filePath = path.join(project, "session.log");

  assert.throws(
    () => createFileLogWriter(filePath, () => {}, { projectRoot: project }),
    (error: unknown) => {
      assert.ok(error instanceof CodeSmithError);
      assert.equal(error.kind, "configuration");
      assert.match(error.message, /inside --project/);
      return true;
    },
  );
  assert.equal(existsSync(filePath), false);
});
