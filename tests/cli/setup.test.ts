import assert from "node:assert/strict";
import test from "node:test";
import { modelCatalog } from "../../src/providers/model-catalog.js";
import { selectModel } from "../../src/cli/setup.js";

test("renders grouped models and retries invalid numeric selections", async () => {
  const prompts: string[] = [];
  let responses = ["not a number", "999", "2"];
  let output = "";

  const selection = await selectModel(
    async (prompt) => {
      prompts.push(prompt);
      const response = responses.shift();
      assert.ok(response !== undefined);
      return response;
    },
    (value) => { output += value; },
  );

  assert.equal(selection, modelCatalog[1]);
  assert.equal(prompts.length, 3);
  assert.match(output, /OpenAI/);
  assert.match(output, /Anthropic/);
  assert.match(output, /Google Gemini/);
  assert.match(output, /Enter a valid model number\./);
});
