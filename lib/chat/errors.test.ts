/**
 * Unit tests for the chat's error presentation.
 * Run: npm run test:app
 *
 * The reason these exist: whether the UI offers a top-up link must depend on
 * the gateway's machine `code` and never on how an error sentence happened to
 * be worded. The encode/decode pair is what carries that code through the AI
 * SDK's error channel, which is a bare string, and a regression there is
 * invisible until someone hits a 402 in production.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeChatError,
  encodeChatError,
  parseGatewayErrorCode,
  presentChatError,
} from "./errors.ts";

describe("encodeChatError / decodeChatError", () => {
  it("round-trips a code and its message", () => {
    const wire = encodeChatError("insufficient_balance", "Balance too low.");
    assert.deepEqual(decodeChatError(wire), {
      code: "insufficient_balance",
      message: "Balance too low.",
    });
  });

  it("passes an unmarked message through untouched", () => {
    assert.deepEqual(decodeChatError("Network request failed"), {
      code: null,
      message: "Network request failed",
    });
  });

  it("handles nothing at all", () => {
    assert.deepEqual(decodeChatError(undefined), { code: null, message: "" });
    assert.deepEqual(decodeChatError(null), { code: null, message: "" });
  });

  it("does not treat a marker in the middle of a message as a code", () => {
    const raw = "upstream said «nx:insufficient_balance» somewhere";
    assert.deepEqual(decodeChatError(raw), { code: null, message: raw });
  });
});

describe("parseGatewayErrorCode", () => {
  it("reads the code out of the OpenAI envelope", () => {
    const body = JSON.stringify({
      error: { message: "no", type: "invalid_request_error", param: null, code: "model_not_found" },
    });
    assert.equal(parseGatewayErrorCode(body), "model_not_found");
  });

  it("returns null for a body that is not the envelope", () => {
    assert.equal(parseGatewayErrorCode("<html>502 Bad Gateway</html>"), null);
    assert.equal(parseGatewayErrorCode("null"), null);
    assert.equal(parseGatewayErrorCode(JSON.stringify({ error: "boom" })), null);
    assert.equal(parseGatewayErrorCode(JSON.stringify({ error: { code: 42 } })), null);
    assert.equal(parseGatewayErrorCode(JSON.stringify({ error: { code: "" } })), null);
  });
});

describe("presentChatError", () => {
  it("sends a 402 to the wallet, and does not blame the wallet mid-sentence", () => {
    const presented = presentChatError("insufficient_balance");
    assert.equal(presented.action?.href, "/console/wallet");
    assert.equal(presented.retryable, false);
    // The hold covers the whole turn up front, so "you ran out mid-reply" is
    // not what happened and the copy must not say it.
    assert.equal(/ran out|mid/i.test(presented.description), false);
  });

  it("marks the two timeouts retryable and everything else not", () => {
    assert.equal(presentChatError("cold_start_timeout").retryable, true);
    assert.equal(presentChatError("stream_timeout").retryable, true);
    assert.equal(presentChatError("model_unavailable").retryable, false);
    assert.equal(presentChatError("invalid_api_key").retryable, false);
  });

  it("never leaves the user without a sentence, whatever the code", () => {
    for (const code of [null, "", "something_new_from_the_gateway"]) {
      const presented = presentChatError(code);
      assert.ok(presented.title.length > 0);
      assert.ok(presented.description.length > 0);
    }
  });

  it("keeps the upstream message when it has nothing better to say", () => {
    const presented = presentChatError(null, "socket hang up");
    assert.match(presented.description, /socket hang up/);
  });

  it("does not echo an empty upstream message as the whole description", () => {
    const presented = presentChatError("totally_unknown", "   ");
    assert.match(presented.description, /gateway did not return a response/);
  });

  it("keeps the code it was handed, for the UI to branch on", () => {
    assert.equal(presentChatError("model_not_found").code, "model_not_found");
    assert.equal(presentChatError(null).code, "unknown");
  });
});
