import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskContract,
  parsePlanRevision,
  parseScopeRedirect,
  parseTaskContract,
  planRevisionToolDefinition,
  scopeRedirectToolDefinition,
  taskContractToolDefinition,
} from "../../src/agent/task-contract.js";

const validPlan = ["Inspect the files.", "Run the tests."];

void test("parses and trims a bounded task contract", () => {
  const result = parseTaskContract(
    JSON.stringify({
      goal: "  Update the project  ",
      completionCriteria: ["  Tests pass.  ", "The output is documented."],
      plan: [" Inspect the files. ", " Run the tests. "],
      excludedRequests: [],
    }),
  );

  assert.deepEqual(result, {
    valid: true,
    input: {
      goal: "Update the project",
      completionCriteria: ["Tests pass.", "The output is documented."],
      plan: validPlan,
      excludedRequests: [],
    },
  });
  if (result.valid) {
    const contract = createTaskContract(result.input);
    assert.equal(contract.goal, "Update the project");
    assert.match(contract.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.completionCriteria), true);
    assert.equal(Object.isFrozen(contract.plan), true);
    assert.equal(Object.isFrozen(contract.excludedRequests), true);
    assert.ok(contract.excludedRequests);
    assert.equal(Reflect.set(contract, "goal", "Change the goal"), false);
    assert.equal(Reflect.set(contract.completionCriteria, 0, "Change the criteria"), false);
    assert.equal(Reflect.set(contract.plan, 0, "Change the plan"), false);
    assert.equal(Reflect.set(contract.excludedRequests, 0, "Change the exclusions"), false);
    assert.equal(contract.goal, "Update the project");
    assert.deepEqual(contract.completionCriteria, ["Tests pass.", "The output is documented."]);
    assert.deepEqual(contract.plan, validPlan);
    assert.deepEqual(contract.excludedRequests, []);
  }
});

void test("rejects unsupported and duplicate task contract fields", () => {
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["Tests pass."],
        unexpected: ["Run tests"],
        plan: validPlan,
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["Tests pass.", "Tests pass."],
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      '{"goal":"first","goal":"second","completionCriteria":["Tests pass."],"plan":["Run tests"],"excludedRequests":[]}',
    ).valid,
    false,
  );
});

void test("enforces task contract bounds", () => {
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "",
        completionCriteria: ["Tests pass."],
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: [],
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: Array.from({ length: 9 }, (_, index) => `Criterion ${index}`),
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "x".repeat(501),
        completionCriteria: ["Tests pass."],
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["x".repeat(301)],
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["Tests pass."],
        plan: Array.from({ length: 9 }, (_, index) => `Step ${index}`),
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "Update the project",
        completionCriteria: ["Tests pass."],
        plan: ["x".repeat(301)],
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "😀".repeat(500),
        completionCriteria: ["😀".repeat(300)],
        plan: ["😀".repeat(300)],
        excludedRequests: [],
      }),
    ).valid,
    true,
  );
  assert.equal(
    parseTaskContract(
      JSON.stringify({
        goal: "😀".repeat(501),
        completionCriteria: ["Tests pass."],
        plan: validPlan,
        excludedRequests: [],
      }),
    ).valid,
    false,
  );
});

void test("publishes strict planning tool schemas", () => {
  assert.equal(taskContractToolDefinition.function.name, "declare_task");
  assert.deepEqual(taskContractToolDefinition.function.parameters.required, [
    "goal",
    "completionCriteria",
    "plan",
    "excludedRequests",
  ]);
  assert.equal(taskContractToolDefinition.function.parameters.additionalProperties, false);
  assert.equal(planRevisionToolDefinition.function.name, "revise_plan");
  assert.deepEqual(planRevisionToolDefinition.function.parameters.required, ["plan", "reason"]);
  assert.equal(planRevisionToolDefinition.function.parameters.additionalProperties, false);
  assert.equal(scopeRedirectToolDefinition.function.name, "redirect_scope");
  assert.deepEqual(scopeRedirectToolDefinition.function.parameters.required, [
    "reason",
    "suggestedRequest",
  ]);
  assert.equal(scopeRedirectToolDefinition.function.parameters.additionalProperties, false);
});

void test("parses bounded plan revisions", () => {
  assert.deepEqual(
    parsePlanRevision(
      JSON.stringify({
        plan: [" Inspect the files. ", " Run the tests. "],
        reason: "The files show a smaller change than expected.",
      }),
    ),
    {
      valid: true,
      input: {
        plan: validPlan,
        reason: "The files show a smaller change than expected.",
      },
    },
  );
  assert.equal(
    parsePlanRevision('{"plan":["Run tests"],"plan":["Ship"],"reason":"Changed"}').valid,
    false,
  );
  assert.equal(parsePlanRevision(JSON.stringify({ plan: [], reason: "Changed" })).valid, false);
  assert.equal(
    parsePlanRevision(JSON.stringify({ plan: validPlan, reason: "x".repeat(301) })).valid,
    false,
  );
});

void test("parses bounded scope redirects", () => {
  assert.deepEqual(
    parseScopeRedirect(
      JSON.stringify({
        reason: "This is not software-engineering work.",
        suggestedRequest: "Ask how to test a TypeScript function.",
      }),
    ),
    {
      valid: true,
      input: {
        reason: "This is not software-engineering work.",
        suggestedRequest: "Ask how to test a TypeScript function.",
      },
    },
  );
  assert.equal(
    parseScopeRedirect('{"reason":"one","reason":"two","suggestedRequest":"Ask about testing"}')
      .valid,
    false,
  );
  assert.equal(
    parseScopeRedirect(JSON.stringify({ reason: "x".repeat(301), suggestedRequest: "Ask" })).valid,
    false,
  );
  assert.equal(parseScopeRedirect(JSON.stringify({ reason: "No suggestion" })).valid, false);
});
