import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, resolveLogLevel } from "../../src/cli/logger.js";

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
