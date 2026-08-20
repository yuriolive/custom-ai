/**
 * The publish gate's four cases, and the two ways an acknowledgement is not one.
 *
 * Every assertion here has a pgTAP counterpart in
 * supabase/tests/08_license_gate_test.sql: this module decides one step early so
 * a creator gets a sentence, and `custom_models_public_needs_license` decides
 * for real. If the two ever disagree the constraint wins and the deployment
 * fails with a constraint name in it, so they are pinned to each other by being
 * asserted on both sides.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { acknowledgementMayBeRequired, evaluateLicenseGate } from "./license.ts";

test("permissive weights publish", () => {
  const decision = evaluateLicenseGate({
    hosting: "allowed",
    termsVersion: "2.0",
    wantsPublic: true,
    acknowledgedVersion: null,
  });
  assert.equal(decision.publish, true);
  assert.equal(decision.hold, null);
  // Nothing is recorded as acknowledged, because nothing was asked.
  assert.equal(decision.ackVersion, null);
});

test("prohibited weights never publish, and are not an error", () => {
  const decision = evaluateLicenseGate({
    hosting: "prohibited",
    termsVersion: "cc-by-nc-4.0",
    wantsPublic: true,
    acknowledgedVersion: null,
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.hold, "hosting_prohibited");
  assert.match(decision.hint!, /private/);
});

test("an acknowledgement cannot buy a listing the licence forbids", () => {
  // The whole point of the enum having four states: `conditional` is the only
  // one an acknowledgement is relevant to.
  const decision = evaluateLicenseGate({
    hosting: "prohibited",
    termsVersion: "cc-by-nc-4.0",
    wantsPublic: true,
    acknowledgedVersion: "cc-by-nc-4.0",
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.hold, "hosting_prohibited");
});

test("unknown terms are neither published nor rejected", () => {
  const decision = evaluateLicenseGate({
    hosting: "unknown",
    termsVersion: null,
    wantsPublic: true,
    acknowledgedVersion: null,
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.hold, "terms_unknown");
  assert.match(decision.hint!, /review/);
});

test("conditional terms need an acknowledgement", () => {
  const decision = evaluateLicenseGate({
    hosting: "conditional",
    termsVersion: "llama3.1",
    wantsPublic: true,
    acknowledgedVersion: null,
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.hold, "acknowledgement_required");
  assert.match(decision.message!, /llama3\.1/);
});

test("conditional terms publish against an acknowledgement of the text in force", () => {
  const decision = evaluateLicenseGate({
    hosting: "conditional",
    termsVersion: "llama3.1",
    wantsPublic: true,
    acknowledgedVersion: "llama3.1",
  });
  assert.equal(decision.publish, true);
  assert.equal(decision.ackVersion, "llama3.1");
  assert.equal(decision.hold, null);
});

test("a STALE acknowledgement is not an acknowledgement", () => {
  // This is why `license_ack_version` is a version and not a boolean. The Llama
  // licence has been revised; accepting the old text is not accepting the new.
  const decision = evaluateLicenseGate({
    hosting: "conditional",
    termsVersion: "3.3",
    wantsPublic: true,
    acknowledgedVersion: "3.1",
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.hold, "acknowledgement_stale");
  assert.equal(decision.ackVersion, null);
  assert.match(decision.message!, /3\.1/);
  assert.match(decision.message!, /3\.3/);
});

test("conditional with no licence on record has nothing to acknowledge", () => {
  // A verdict with no premise. Fail closed rather than accept an acknowledgement
  // of a document nobody can name.
  const decision = evaluateLicenseGate({
    hosting: "conditional",
    termsVersion: null,
    wantsPublic: true,
    acknowledgedVersion: "whatever-the-client-sent",
  });
  assert.equal(decision.publish, false);
  assert.equal(decision.hold, "terms_unknown");
});

test("a creator who did not ask to publish is never held", () => {
  // §5.1: a private deploy of prohibited weights is the creator spending their
  // own money on their own compute. Reporting a licence problem to somebody who
  // never tried to publish is noise.
  for (const hosting of ["allowed", "conditional", "prohibited", "unknown"] as const) {
    const decision = evaluateLicenseGate({
      hosting,
      termsVersion: "anything",
      wantsPublic: false,
      acknowledgedVersion: null,
    });
    assert.equal(decision.publish, false, hosting);
    assert.equal(decision.hold, null, hosting);
    assert.equal(decision.message, null, hosting);
  }
});

test("the form asks for an acknowledgement only where one can matter", () => {
  assert.equal(acknowledgementMayBeRequired("conditional"), true);
  assert.equal(acknowledgementMayBeRequired("allowed"), false);
  assert.equal(acknowledgementMayBeRequired("prohibited"), false);
  assert.equal(acknowledgementMayBeRequired("unknown"), false);
  assert.equal(acknowledgementMayBeRequired(null), false);
  assert.equal(acknowledgementMayBeRequired(undefined), false);
});
