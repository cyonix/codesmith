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

void test("redacts complete quoted credential values with punctuation and escapes", () => {
  const redacted = redactSensitiveText(
    '{"password":"abc,def","token":"escaped \\"value\\", still secret"} password="correct horse"',
  );

  assert.equal(redacted, '{"password":"[REDACTED]","token":"[REDACTED]"} [REDACTED]');
});

void test("redacts complete unquoted credential values with commas", () => {
  const redacted = redactSensitiveText("PASSWORD=abc,def");

  assert.equal(redacted, "[REDACTED]");
});

void test("redacts credential fields nested in JSON tool results", () => {
  const redacted = redactSensitiveText(JSON.stringify({ content: '{"api_key":"private-value"}' }));

  assert.doesNotMatch(redacted, /private-value/);
  assert.deepEqual(JSON.parse(redacted), { content: '{"api_key":"[REDACTED]"}' });
});

void test("redacts raw PEM private-key blocks", () => {
  const redacted = redactSensitiveText(
    "-----BEGIN RSA PRIVATE KEY-----\nprivate key material\n-----END RSA PRIVATE KEY-----",
  );

  assert.equal(redacted, "[REDACTED PRIVATE KEY]");
});
