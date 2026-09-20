import assert from "node:assert/strict";
import test from "node:test";
import type { TaskContract } from "../../src/core/agent-core.js";

void test("exports TaskContract through Agent Core", () => {
  const contract: TaskContract = {
    taskId: "task-123",
    goal: "Inspect the project.",
    completionCriteria: ["The result is reported."],
  };

  assert.equal(contract.goal, "Inspect the project.");
  assert.deepEqual(contract.completionCriteria, ["The result is reported."]);
});
