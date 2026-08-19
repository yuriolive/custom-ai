/**
 * Unit tests for the catalog card's value footer.
 * Run: npm run test:app
 *
 * The point of this file is to pin the ROUNDING DIRECTION and the ZERO-PRICE
 * BRANCH of `tokensForCredit`.
 *
 * "$5.00 buys ~3.5M input tokens" is a claim about how far someone's money
 * goes, so it has to be an AT MOST. Rounding to nearest — the reflex, and what
 * `formatMicroUsd` correctly does for a charge already incurred — would promise
 * tokens a $5 balance cannot pay for. Nothing about the types distinguishes
 * `Math.floor` from `Math.round` here, so a refactor could flip it in silence
 * and the only visible symptom would be a catalog that overstates value by a
 * fraction of a percent. These assertions are what would catch that.
 *
 * The zero branch matters for the same reason in the other direction: a
 * division by zero renders `Infinity`, and a card reading "buys ~Infinity
 * tokens" is worse than one reading nothing at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatCreditValue, tokensForCredit, VALUE_FOOTER_CREDIT_MICRO } from "./format.ts";

test("the reference credit is $5, expressed in micro-USD", () => {
  // If this constant moves, every string below moves with it. Pinned so the
  // change is a deliberate edit rather than a surprise in the snapshots.
  assert.equal(VALUE_FOOTER_CREDIT_MICRO, 5_000_000);
});

test("tokens bought is credit x 1e6 / price-per-Mtoken", () => {
  // $0.50/M prompt price = 500_000 micro-USD per 1M tokens.
  // $5 = 5_000_000 micro. 5_000_000 * 1e6 / 500_000 = 10_000_000 tokens.
  assert.equal(tokensForCredit(500_000), 10_000_000);

  // $1.50/M => 5_000_000 * 1e6 / 1_500_000 = 3_333_333.33… -> floored.
  assert.equal(tokensForCredit(1_500_000), 3_333_333);
});

test("a fractional result FLOORS — the footer is an at-most claim", () => {
  // Chosen so round() and floor() disagree: the exact quotient is x.9,
  // which rounds UP to the next whole token. A card must never promise it.
  const price = 900_001;
  const exact = (VALUE_FOOTER_CREDIT_MICRO * 1_000_000) / price;

  assert.ok(!Number.isInteger(exact), "test is only meaningful on a fractional quotient");
  assert.equal(tokensForCredit(price), Math.floor(exact));
  assert.ok(
    tokensForCredit(price)! * price <= VALUE_FOOTER_CREDIT_MICRO * 1_000_000,
    "the quoted tokens must be payable by the quoted credit",
  );
});

test("the quoted tokens are always payable, across the whole price ladder", () => {
  // The property the footer actually asserts, checked with integer maths only.
  for (const price of [1, 999, 100_000, 500_000, 1_500_000, 12_345_678, 1_000_000_000]) {
    const tokens = tokensForCredit(price);
    assert.ok(tokens !== null, `price ${price} should quote a figure`);
    assert.ok(
      tokens * price <= VALUE_FOOTER_CREDIT_MICRO * 1_000_000,
      `${tokens} tokens at ${price}/M overstates what $5 buys`,
    );
  }
});

test("a zero or negative price yields null, never Infinity", () => {
  assert.equal(tokensForCredit(0), null);
  assert.equal(tokensForCredit(-1), null);
  assert.equal(tokensForCredit(Number.NaN), null);
  assert.equal(tokensForCredit(Number.POSITIVE_INFINITY), null);
});

test("a zero or negative credit yields null", () => {
  assert.equal(tokensForCredit(500_000, 0), null);
  assert.equal(tokensForCredit(500_000, -5_000_000), null);
});

test("both prices zero reads as free, not as a number", () => {
  const rendered = formatCreditValue(0, 0);
  assert.ok(rendered.startsWith("Free"), rendered);
  assert.ok(!rendered.includes("Infinity"), rendered);
  assert.ok(!rendered.includes("NaN"), rendered);
});

test("one price zero renders that side as unmetered, not as a number", () => {
  const rendered = formatCreditValue(500_000, 0);
  assert.ok(rendered.includes("unmetered"), rendered);
  assert.ok(!rendered.includes("Infinity"), rendered);
});

test("the ordinary case names the credit and both sides", () => {
  const rendered = formatCreditValue(500_000, 1_500_000);
  // The amount must be IN the sentence. A bare "buys ~10M input tokens" is
  // meaningless without saying what was spent to buy them.
  assert.ok(rendered.includes("$5.00"), rendered);
  assert.ok(rendered.includes("input"), rendered);
  assert.ok(rendered.includes("output"), rendered);
});

test("no rendering path emits Infinity or NaN", () => {
  const nasty = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1, 1_000_000_000];
  for (const prompt of nasty) {
    for (const completion of nasty) {
      const rendered = formatCreditValue(prompt, completion);
      assert.ok(!rendered.includes("Infinity"), `${prompt}/${completion} -> ${rendered}`);
      assert.ok(!rendered.includes("NaN"), `${prompt}/${completion} -> ${rendered}`);
    }
  }
});
