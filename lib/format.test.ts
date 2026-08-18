/**
 * Unit tests for micro-USD display formatting.
 * Run: npm run test:app
 *
 * The point of this file is to pin the ROUNDING DIRECTION. `formatMicroUsd`
 * rounds to nearest, which is right for a charge already incurred;
 * `formatBalanceMicroUsd` floors, which is the only safe direction for
 * spendable funds (CONTRACTS.md §Money). The two differ only on values that
 * are not already exact at the chosen precision, so a refactor of the
 * decimals/divisor ladder below could silently collapse them without any
 * type error. These assertions are what would catch that.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatBalanceMicroUsd, formatMicroUsd } from "./format.ts";

/**
 * Read a rendered figure back to integer micro-USD, using integer maths only.
 * Exists so the "never overstates" property below can be checked without
 * introducing float arithmetic even in a test.
 */
function parseToMicro(rendered: string): number {
  const body = rendered.replace("-", "").replace("$", "").replaceAll(",", "");
  const [whole, frac = ""] = body.split(".");
  return Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
}

test("the regression case: a balance one third of a cent short of $10", () => {
  // 9,999,328 micro-USD is $9.999328. Rounding to nearest at 2 decimals
  // reports money the holder does not have; the gateway would still refuse to
  // reserve against it, so the shortfall would surface only as a mid-request 402.
  assert.equal(formatMicroUsd(9_999_328), "$10.00");
  assert.equal(formatBalanceMicroUsd(9_999_328), "$9.99");
});

test("a balance figure never renders as more than the true amount", () => {
  const values = [
    0, 1, 999, 1_000, 1_050, 9_999, 10_000, 10_001, 9_999_328, 5_000_000, 1_234_567_890, 999_999,
  ];
  for (const micro of values) {
    const shown = parseToMicro(formatBalanceMicroUsd(micro));
    assert.ok(
      shown <= micro,
      `${micro} rendered as ${formatBalanceMicroUsd(micro)} (${shown}), which overstates it`,
    );
  }
});

test("the precision ladder: 6 decimals under a tenth of a cent, then 4, then 2", () => {
  // Chosen so a real charge never reads $0.00.
  assert.equal(formatMicroUsd(1), "$0.000001");
  assert.equal(formatMicroUsd(999), "$0.000999");
  assert.equal(formatMicroUsd(1_000), "$0.0010");
  assert.equal(formatMicroUsd(9_999), "$0.0100");
  assert.equal(formatMicroUsd(10_000), "$0.01");
});

test("the ladder boundaries floor rather than cross into the next unit", () => {
  // 9,999 is a tenth of a cent short of $0.01 and must not read as $0.01.
  assert.equal(formatBalanceMicroUsd(9_999), "$0.0099");
  assert.equal(formatBalanceMicroUsd(1_050), "$0.0010");
  assert.equal(formatMicroUsd(1_050), "$0.0011");
});

test("values already exact at their precision are identical either way", () => {
  for (const micro of [0, 1, 999, 1_000, 10_000, 5_000_000]) {
    assert.equal(formatBalanceMicroUsd(micro), formatMicroUsd(micro), String(micro));
  }
});

test("thousands are grouped", () => {
  assert.equal(formatMicroUsd(1_234_567_890), "$1,234.57");
  assert.equal(formatBalanceMicroUsd(1_234_567_890), "$1,234.56");
});

test("a null or undefined amount is an em dash, never $0", () => {
  assert.equal(formatMicroUsd(null), "—");
  assert.equal(formatMicroUsd(undefined), "—");
  assert.equal(formatBalanceMicroUsd(null), "—");
  assert.equal(formatBalanceMicroUsd(undefined), "—");
});

test("a zero balance renders at full precision, not as $0.00", () => {
  // Documents current behaviour: 0 falls in the <1,000 branch, so it takes 6
  // decimals like any other sub-tenth-of-a-cent amount.
  assert.equal(formatBalanceMicroUsd(0), "$0.000000");
});

test("a fractional input is truncated toward zero before any formatting", () => {
  // Nothing upstream should hand this function a non-integer, but the
  // Math.trunc is load-bearing if something does: it keeps the integer
  // invariant local instead of letting a float reach the division.
  assert.equal(formatMicroUsd(1_000.9), "$0.0010");
  assert.equal(formatBalanceMicroUsd(10_000.9), "$0.01");
});

test("the sign is carried separately, so magnitude is what gets floored", () => {
  // Balances cannot go negative — profiles.balance_micro_usd has
  // `check (balance_micro_usd >= 0)` and rpc_deduct_token_cost holds invariant
  // I1 — so this only pins the ledger/charge path's behaviour on negatives.
  // Note the floor applies to the MAGNITUDE, i.e. it truncates toward zero.
  assert.equal(formatMicroUsd(-9_999_328), "-$10.00");
  assert.equal(formatBalanceMicroUsd(-9_999_328), "-$9.99");
});
