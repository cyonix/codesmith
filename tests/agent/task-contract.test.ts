import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskContract,
  parseTaskContract,
  taskContractToolDefinition,
} from "../../src/agent/task-contract.js";

void test("parses and trims a bounded task contract", () => {
  const result = parseTaskContract(
    JSON.stringify({
      goal: "  Update the project  ",
      completionCriteria: ["  Tests pass.  ", "The output is documented."],
    }),
  );

  assert.deepEqual(result, {
    valid: true,
    input: {
      goal: "Update the project",
      completionCriteria: ["Tests pass.", "The output is documented."],
    },
  });
  if (result.valid) {
    const contract = createTaskContract(result.input);
    assert.equal(contract.goal, "Update the project");
    assert.match(contract.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.completionCriteria), true);
    assert.equal(Reflect.set(contract, "goal", "Change the goal"), false);
    assert.equal(Reflect.set(contract.completionCriteria, 0, "Change the criteria"), false);
    assert.equal(contract.goal, "Update the project");
    assert.deepEqual(contract.completionCriteria, ["Tests pass.", "The output is documented."]);
  }
});

void test("rejects unsupported and duplicate task contract fields", () => {
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["Tests pass."],
        plan: ["Run tests"],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["Tests pass.", "Tests pass."],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract('{"goal":"first","goal":"second","completionCriteria":["Tests pass."]}')
      .valid,
    false,
  );
});

void test("enforces task contract bounds", () => {
  assert.equal(
    parseTaskContract(JSON.stringify({ goal: "", completionCriteria: ["Tests pass."] })).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: Array.from({ length: 9 }, (_, index) => `Criterion ${index}`),
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "x".repeat(501),
        completionCriteria: ["Tests pass."],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["x".repeat(301)],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "😀".repeat(500),
        completionCriteria: ["😀".repeat(300)],
      }),
    ).valid,
    true,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "😀".repeat(501),
        completionCriteria: ["Tests pass."],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["😀".repeat(301)],
      }),
    ).valid,
    false,
  );
});

void test("publishes a strict declaration tool schema", () => {
  assert.equal(taskContractToolDefinition.function.name, "declare_task");
  assert.deepEqual(taskContractToolDefinition.function.parameters.required, [
    "goal",
    "completionCriteria",
  ]);
  assert.equal(taskContractToolDefinition.function.parameters.additionalProperties, false);
});
