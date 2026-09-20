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
