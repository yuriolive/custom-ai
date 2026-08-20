/**
 * Unit tests for auth error copy.
 * Run: npm run test:app
 *
 * These pin two properties that a wording change could silently break:
 *
 * 1. **No account-enumeration oracle.** "No such user" and "wrong password"
 *    must be byte-identical. A well-meaning edit that made one of them more
 *    helpful would turn the sign-in form into an email-existence check, and
 *    nothing else in the build would notice.
 * 2. **No copy names a provider it cannot know.** With GitHub *and* Hugging
 *    Face on the page, the start path knows which button was pressed and the
 *    callback path does not — GoTrue's error redirect carries `error` and
 *    `error_code` and nothing else. So callback copy must stay neutral, or half
 *    the users who cancel are told they cancelled the other one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AuthError } from "@supabase/supabase-js";

import {
  describeAuthError,
  describeOAuthCallbackError,
  messageForQueryCode,
  oauthUnavailableMessage,
} from "./auth-errors.ts";

/** A GoTrue error carries `code` and `status` alongside the message. */
function authError(code: string, status = 400, message = ""): AuthError {
  return Object.assign(new Error(message), { code, status }) as unknown as AuthError;
}

const PROVIDERS = ["GitHub", "Hugging Face"] as const;

test("invalid credentials and a missing user are indistinguishable", () => {
  const wrongPassword = describeAuthError(authError("invalid_credentials"), "sign-in");
  // Older GoTrue builds send no code at all; the status-400 fallback must land
  // on the same copy, or the two branches become distinguishable by version.
  const noCode = describeAuthError(authError("", 400), "sign-in");

  assert.equal(wrongPassword.message, noCode.message);
  assert.equal(wrongPassword.code, noCode.code);
  assert.equal(wrongPassword.field, noCode.field);
});

test("provider_disabled names the provider the caller started with", () => {
  for (const provider of PROVIDERS) {
    const failure = describeAuthError(authError("provider_disabled"), "oauth", provider);
    assert.equal(failure.code, "provider_disabled");
    assert.match(failure.message, new RegExp(provider));
  }
});

test("provider_disabled with no provider names none of them", () => {
  const failure = describeAuthError(authError("provider_disabled"), "oauth");
  assert.equal(failure.code, "provider_disabled");
  for (const provider of PROVIDERS) {
    assert.doesNotMatch(failure.message, new RegExp(provider));
  }
});

test("the 'no authorization URL' copy exists for both providers and differs", () => {
  const github = oauthUnavailableMessage("GitHub");
  const huggingFace = oauthUnavailableMessage("Hugging Face");
  assert.match(github, /GitHub/);
  assert.match(huggingFace, /Hugging Face/);
  assert.notEqual(github, huggingFace);
});

test("callback copy names no provider — the redirect does not say which one", () => {
  const cancelled = describeOAuthCallbackError("access_denied", null, null);
  const serverError = describeOAuthCallbackError("server_error", null, null);
  const vague = describeOAuthCallbackError(null, null, "something went sideways");

  assert.equal(cancelled.code, "oauth_denied");
  for (const failure of [cancelled, serverError, vague]) {
    for (const provider of PROVIDERS) {
      assert.doesNotMatch(failure.message, new RegExp(provider));
    }
  }
});

test("an expired email link is not reported as a cancelled OAuth sign-in", () => {
  // GoTrue sends error=access_denied&error_code=otp_expired for a re-used
  // confirmation link. Matching `access_denied` first told those users their
  // provider sign-in was cancelled; ordering is what prevents it.
  const failure = describeOAuthCallbackError("access_denied", "otp_expired", null);
  assert.equal(failure.code, "expired_link");
});

test("every ?authError= code resolves to copy that names no provider", () => {
  const codes = [
    "oauth_denied",
    "expired_link",
    "provider_disabled",
    "email_not_confirmed",
    "rate_limited",
    "user_banned",
    "unknown",
    // Not in the table: must still resolve, via the `unknown` fallback.
    "not_a_real_code",
  ];

  for (const code of codes) {
    const message = messageForQueryCode(code);
    assert.ok(message, `no copy for ${code}`);
    for (const provider of PROVIDERS) {
      assert.doesNotMatch(message, new RegExp(provider), code);
    }
  }
  assert.equal(messageForQueryCode(null), null);
});
