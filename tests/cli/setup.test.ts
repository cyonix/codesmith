import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../../src/cli/main.js";
import { modelCatalog } from "../../src/providers/model-catalog.js";
import { selectModel } from "../../src/cli/setup.js";

void test("renders grouped models and retries invalid numeric selections", async () => {
  const prompts: string[] = [];
  const responses = ["not a number", "999", "2"];
  let output = "";

  const selection = await selectModel(
    (prompt) => {
      prompts.push(prompt);
      const response = responses.shift();
      assert.ok(response !== undefined);
      return Promise.resolve(response);
    },
    (value) => {
      output += value;
    },
  );

  assert.equal(selection, modelCatalog[1]);
  assert.equal(prompts.length, 3);
  assert.match(output, /OpenAI/);
  assert.match(output, /Anthropic/);
  assert.match(output, /Google Gemini/);
  assert.match(output, /Enter a valid model number\./);
});

void test("parses semantic-memory opt-in separately from auto-approval", () => {
  assert.deepEqual(
    parseOptions(["--project", "/workspace", "--yes", "--semantic-memory"], undefined, undefined),
    {
      project: "/workspace",
      yes: true,
      semanticMemory: true,
      help: false,
      logLevel: "debug",
      logFile: undefined,
    },
  );
  assert.deepEqual(
    parseOptions(["--project", "/workspace", "--log-level", "warn"], "error", undefined),
    {
      project: "/workspace",
      yes: false,
      semanticMemory: false,
      help: false,
      logLevel: "warn",
      logFile: undefined,
    },
  );
  assert.deepEqual(parseOptions(["--project", "/workspace"], "info", undefined), {
    project: "/workspace",
    yes: false,
    semanticMemory: false,
    help: false,
    logLevel: "info",
    logFile: undefined,
  });
  assert.deepEqual(
    parseOptions(
      ["--project", "/workspace", "--log-file", "/tmp/codesmith.log"],
      undefined,
      "/tmp/env.log",
    ),
    {
      project: "/workspace",
      yes: false,
      semanticMemory: false,
      help: false,
      logLevel: "debug",
      logFile: "/tmp/codesmith.log",
    },
  );
  assert.deepEqual(parseOptions(["--project", "/workspace"], undefined, "/tmp/env.log"), {
    project: "/workspace",
    yes: false,
    semanticMemory: false,
    help: false,
    logLevel: "debug",
    logFile: "/tmp/env.log",
  });
  assert.throws(
    () => parseOptions(["--project", "/workspace", "--log-level", "verbose"], undefined, undefined),
    /log level/,
  );
  assert.throws(
    () => parseOptions(["--project", "/workspace", "--log-file"], undefined, undefined),
    /--log-file requires a file path/,
  );
  assert.throws(
    () => parseOptions(["--project", "/workspace", "--semantic-memory-threshold", "0.4"]),
    /Unknown option/,
  );
});
