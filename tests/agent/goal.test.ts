import assert from "node:assert/strict";
import test from "node:test";
import {
  fileMutationSucceeded,
  GoalState,
  maximumGoalCriteria,
  maximumGoalCriterionCharacters,
  maximumGoalSummaryCharacters,
  parseStateGoalArguments,
  requiresStatedGoal,
} from "../../src/agent/goal.js";

void test("parses a valid state_goal payload and trims fields", () => {
  const parsed = parseStateGoalArguments(
    JSON.stringify({
      summary: "  Create the file.  ",
      completion_criteria: ["  The file exists.  "],
    }),
  );

  assert.deepEqual(parsed, {
    goal: { summary: "Create the file.", completionCriteria: ["The file exists."] },
  });
});

void test("rejects invalid state_goal payloads", () => {
  assert.deepEqual(parseStateGoalArguments("not-json"), {
    error: "Invalid arguments for state_goal.",
  });
  assert.deepEqual(parseStateGoalArguments("[]"), {
    error: "Arguments for state_goal must be an object.",
  });
  assert.deepEqual(parseStateGoalArguments(JSON.stringify({ completion_criteria: ["done"] })), {
    error: "summary must be a non-empty string.",
  });
  assert.deepEqual(
    parseStateGoalArguments(
      JSON.stringify({
        summary: "x".repeat(maximumGoalSummaryCharacters + 1),
        completion_criteria: ["done"],
      }),
    ),
    { error: `summary must be at most ${maximumGoalSummaryCharacters} characters.` },
  );
  assert.deepEqual(
    parseStateGoalArguments(JSON.stringify({ summary: "Create it.", completion_criteria: [] })),
    {
      error: "completion_criteria must contain 1 to 8 non-empty strings.",
    },
  );
  assert.deepEqual(
    parseStateGoalArguments(
      JSON.stringify({
        summary: "Create it.",
        completion_criteria: Array.from(
          { length: maximumGoalCriteria + 1 },
          (_, index) => `Item ${index}.`,
        ),
      }),
    ),
    { error: "completion_criteria must contain 1 to 8 non-empty strings." },
  );
  assert.deepEqual(
    parseStateGoalArguments(
      JSON.stringify({
        summary: "Create it.",
        completion_criteria: ["x".repeat(maximumGoalCriterionCharacters + 1)],
      }),
    ),
    {
      error: `Each completion criterion must be at most ${maximumGoalCriterionCharacters} characters.`,
    },
  );
});

void test("goal state replaces until frozen", () => {
  const goals = new GoalState();
  assert.equal(goals.hasGoal, false);
  assert.deepEqual(goals.set({ summary: "First.", completionCriteria: ["One."] }), {
    replaced: false,
  });
  assert.deepEqual(goals.set({ summary: "Second.", completionCriteria: ["Two."] }), {
    replaced: true,
  });
  goals.freeze();
  assert.equal(goals.isFrozen, true);
  assert.equal(goals.set({ summary: "Third.", completionCriteria: ["Three."] }), undefined);
  goals.reset();
  assert.equal(goals.hasGoal, false);
  assert.equal(goals.isFrozen, false);
});

void test("classifies gated tools and successful file mutations", () => {
  assert.equal(requiresStatedGoal("create_file"), true);
  assert.equal(requiresStatedGoal("run_command"), true);
  assert.equal(requiresStatedGoal("read_file"), false);
  assert.equal(fileMutationSucceeded("create_file", JSON.stringify({ status: "created" })), true);
  assert.equal(fileMutationSucceeded("delete_file", JSON.stringify({ status: "deleted" })), true);
  assert.equal(fileMutationSucceeded("create_file", JSON.stringify({ status: "declined" })), false);
  assert.equal(fileMutationSucceeded("create_file", JSON.stringify({ error: "failed" })), false);
  assert.equal(fileMutationSucceeded("run_command", JSON.stringify({ status: "created" })), false);
  assert.equal(fileMutationSucceeded("apply_patch", JSON.stringify({ status: "applied" })), true);
});
