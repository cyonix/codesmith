import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "../../src/shared/redaction.js";

void test("redacts credentials in conventional environment-variable identifiers", () => {
  const redacted = redactSensitiveText(
    "DB_PASSWORD=hunter2 AWS_SECRET_ACCESS_KEY=abcd MY_API_TOKEN: abc.def-123",
  );

  assert.doesNotMatch(
    redacted,
    /hunter2|abcd|abc\.def-123|PASSWORD=|SECRET_ACCESS_KEY=|API_TOKEN:/,
  );
  assert.match(redacted, /\[REDACTED\]/);
});

void test("redacts JSON credential fields without removing surrounding syntax", () => {
  assert.equal(
    redactSensitiveText('{"api_key":"private-value","name":"safe"}'),
    '{"api_key":"[REDACTED]","name":"safe"}',
  );
});

void test("redacts common bare provider token formats", () => {
  const redacted = redactSensitiveText(
    "hf_abcdefghijklmnop xoxb-1234567890-abcdefghijkl AIza123456789012345678901234567890123",
  );

  assert.doesNotMatch(redacted, /hf_|xoxb-|AIza/);
});

void test("redacts structured private-key fields", () => {
  assert.equal(
    redactSensitiveText(
      '{"private_key":"-----BEGIN PRIVATE KEY-----private-----END PRIVATE KEY-----"}',
    ),
    '{"private_key":"[REDACTED]"}',
  );
});
