import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskContract } from "../../src/cli/render.js";

void test("renders task contracts without task IDs or approval prompts", () => {
  assert.equal(
    formatTaskContract({
      taskId: "task-hidden",
      goal: "Inspect the project.",
      completionCriteria: ["The files are reviewed.", "The result is reported."],
    }),
    [
      "Task: Inspect the project.",
      "Completion criteria:",
      "1. The files are reviewed.",
      "2. The result is reported.",
    ].join("\n"),
  );
});

void test("keeps multiline contract fields on one rendered line", () => {
  assert.equal(
    formatTaskContract({
      taskId: "task-hidden",
      goal: "Inspect\n the project.",
      completionCriteria: ["The files\tare reviewed.", "The result\nis reported."],
    }),
    [
      "Task: Inspect the project.",
      "Completion criteria:",
      "1. The files are reviewed.",
      "2. The result is reported.",
    ].join("\n"),
  );
});

void test("escapes terminal controls in contract fields", () => {
  const taskLine = formatTaskContract({
    taskId: "task-hidden",
    goal: "Inspect \u001b[2J\u202e\u061c\u200e\u200fproject.",
    completionCriteria: ["The \u009b2J files are reviewed."],
  });

  assert.match(taskLine, /Task: Inspect \\u001b\[2J\\u202e\\u061c\\u200e\\u200fproject\./);
  assert.match(taskLine, /1\. The \\u009b2J files are reviewed\./);
  assert.equal(taskLine.includes(String.fromCodePoint(0x1b)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x9b)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x202e)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x061c)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x200e)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x200f)), false);
});
