/** OpenAI error envelope -> Anthropic error envelope. */

import assert from "node:assert/strict";
import test from "node:test";

import { statusForAnthropicErrorType, toOpenAIError, translateError } from "../src/index.ts";
import type { AnthropicErrorType } from "../src/types.ts";

test("each Anthropic error type maps to its documented HTTP status", () => {
  const expected: [AnthropicErrorType, number][] = [
    ["invalid_request_error", 400],
    ["authentication_error", 401],
    ["billing_error", 402],
    ["permission_error", 403],
    ["not_found_error", 404],
    ["request_too_large", 413],
    ["rate_limit_error", 429],
    ["api_error", 500],
    ["timeout_error", 504],
    ["overloaded_error", 529],
  ];
  for (const [type, status] of expected) {
    assert.equal(statusForAnthropicErrorType(type), status, type);
  }
});

test("an explicit OpenAI error type wins", () => {
  const cases: [string, AnthropicErrorType][] = [
    ["invalid_request_error", "invalid_request_error"],
    ["authentication_error", "authentication_error"],
    ["permission_error", "permission_error"],
    ["not_found_error", "not_found_error"],
    ["rate_limit_error", "rate_limit_error"],
    ["server_error", "api_error"],
    ["overloaded_error", "overloaded_error"],
  ];
  for (const [openai, anthropic] of cases) {
    const { body } = translateError({ error: { message: "boom", type: openai } });
    assert.equal(body.type, "error");
    assert.equal(body.error.type, anthropic, openai);
    assert.equal(body.error.message, "boom");
  }
});

test("the gateway's own error codes map when type is generic", () => {
  const cases: [string, AnthropicErrorType, number][] = [
    ["invalid_model_format", "invalid_request_error", 400],
    ["invalid_api_key", "authentication_error", 401],
    ["revoked_api_key", "authentication_error", 401],
    ["insufficient_balance", "billing_error", 402],
    ["model_not_found", "not_found_error", 404],
    ["model_unavailable", "overloaded_error", 529],
    ["cold_start_timeout", "timeout_error", 504],
    ["stream_timeout", "timeout_error", 504],
  ];
  for (const [code, type, status] of cases) {
    const { body, status: got } = translateError({
      error: { message: "m", type: "unknown_thing", code },
    });
    assert.equal(body.error.type, type, code);
    assert.equal(got, status, code);
    // The code is preserved in the message; Anthropic has nowhere else to put it.
    assert.match(body.error.message, new RegExp(`code=${code}`));
  }
});

test("the HTTP status is the last resort", () => {
  for (const [status, type] of [
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [503, "overloaded_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
  ] as [number, AnthropicErrorType][]) {
    const { body } = translateError({ error: { message: "m" } }, status);
    assert.equal(body.error.type, type, String(status));
  }
});

test("param is preserved in the message rather than dropped", () => {
  const { body } = translateError({
    error: {
      message: "Invalid value",
      type: "invalid_request_error",
      param: "max_tokens",
      code: null,
    },
  });
  assert.equal(body.error.message, "Invalid value (param=max_tokens)");
});

test("garbage in produces a well-formed api_error, never a throw", () => {
  for (const input of [null, undefined, "oops", 42, {}, { error: null }, { error: "x" }]) {
    const { body, status } = translateError(input);
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "api_error");
    assert.equal(status, 500);
    assert.ok(body.error.message.length > 0);
  }
});

test("the reverse direction produces a valid OpenAI envelope", () => {
  assert.deepEqual(
    toOpenAIError({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
    {
      error: {
        message: "slow down",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_error",
      },
    },
  );
  assert.deepEqual(
    toOpenAIError({ type: "error", error: { type: "billing_error", message: "no funds" } }),
    {
      error: {
        message: "no funds",
        type: "insufficient_quota",
        param: null,
        code: "billing_error",
      },
    },
  );
});
