import assert from "node:assert/strict";
import test from "node:test";
import { escapeTerminalTextPreservingNewlines } from "../../src/shared/terminal-text.js";

void test("escapes terminal controls without changing newline separators", () => {
  assert.equal(
    escapeTerminalTextPreservingNewlines("first\u001b[2J\nsecond\u0007\nthird"),
    "first\\u001b[2J\nsecond\\u0007\nthird",
  );
});

void test("normalizes CRLF separators while escaping bare carriage returns", () => {
  assert.equal(
    escapeTerminalTextPreservingNewlines("first\r\nsecond\rthird"),
    "first\nsecond\\u000dthird",
  );
});
