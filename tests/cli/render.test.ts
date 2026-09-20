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
