import assert from "node:assert/strict";
import test from "node:test";
import { formatPlanRevision, formatTaskContract } from "../../src/cli/render.js";

void test("renders task contracts without task IDs or approval prompts", () => {
  assert.equal(
    formatTaskContract({
      taskId: "task-hidden",
      goal: "Inspect the project.",
      completionCriteria: ["The files are reviewed.", "The result is reported."],
      plan: ["Review the files.", "Report the result."],
      excludedRequests: [],
    }),
    [
      "Task: Inspect the project.",
      "Completion criteria:",
      "1. The files are reviewed.",
      "2. The result is reported.",
      "Plan:",
      "1. Review the files.",
      "2. Report the result.",
    ].join("\n"),
  );
});

void test("keeps multiline contract fields on one rendered line", () => {
  assert.equal(
    formatTaskContract({
      taskId: "task-hidden",
      goal: "Inspect\n the project.",
      completionCriteria: ["The files\tare reviewed.", "The result\nis reported."],
      plan: ["Review\n the files.", "Report\t the result."],
      excludedRequests: [],
    }),
    [
      "Task: Inspect the project.",
      "Completion criteria:",
      "1. The files are reviewed.",
      "2. The result is reported.",
      "Plan:",
      "1. Review the files.",
      "2. Report the result.",
    ].join("\n"),
  );
});

void test("escapes terminal controls in contract fields", () => {
  const taskLine = formatTaskContract({
    taskId: "task-hidden",
    goal: "Inspect \u001b[2J\u202e\u061c\u200e\u200fproject.",
    completionCriteria: ["The \u009b2J files are reviewed."],
    plan: ["Review \u001b[2J the files."],
    excludedRequests: [],
  });

  assert.match(taskLine, /Task: Inspect \\u001b\[2J\\u202e\\u061c\\u200e\\u200fproject\./);
  assert.match(taskLine, /1\. The \\u009b2J files are reviewed\./);
  assert.match(taskLine, /Plan:\n1\. Review \\u001b\[2J the files\./);
  assert.equal(taskLine.includes(String.fromCodePoint(0x1b)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x9b)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x202e)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x061c)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x200e)), false);
  assert.equal(taskLine.includes(String.fromCodePoint(0x200f)), false);
});

void test("renders plan revisions with an escaped reason", () => {
  assert.equal(
    formatPlanRevision(["Read the files.", "Run the tests."], "The scope changed.\u001b[2J"),
    [
      "Plan revised:",
      "1. Read the files.",
      "2. Run the tests.",
      "Reason: The scope changed.\\u001b[2J",
    ].join("\n"),
  );
});

void test("renders excluded unrelated requests without an approval prompt", () => {
  assert.equal(
    formatTaskContract({
      taskId: "task-mixed",
      goal: "Explain TypeScript testing.",
      completionCriteria: ["The testing approach is explained."],
      plan: ["Describe a focused test structure."],
      excludedRequests: ["Plan a vacation."],
    }),
    [
      "Task: Explain TypeScript testing.",
      "Completion criteria:",
      "1. The testing approach is explained.",
      "Plan:",
      "1. Describe a focused test structure.",
      "Excluded unrelated requests:",
      "1. Plan a vacation.",
    ].join("\n"),
  );
});
