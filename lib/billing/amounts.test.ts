import assert from "node:assert/strict";
import { test } from "node:test";

import {
  centsToMicroUsd,
  exceedsMaxBalance,
  formatUsdFromMicro,
  MAX_TOPUP_MICRO_USD,
  MICRO_PER_USD,
  MIN_TOPUP_MICRO_USD,
  microUsdToCents,
  parseUsdToCents,
  TOPUP_PRESETS_MICRO_USD,
  validateTopupAmount,
} from "./amounts.ts";

test("parseUsdToCents accepts the shapes a human types", () => {
  assert.equal(parseUsdToCents("20"), 2000);
  assert.equal(parseUsdToCents("20.5"), 2050);
  assert.equal(parseUsdToCents("20.50"), 2050);
  assert.equal(parseUsdToCents("$20.50"), 2050);
  assert.equal(parseUsdToCents(" 1,000 "), 100_000);
  assert.equal(parseUsdToCents("5.07"), 507);
});

test("parseUsdToCents rejects rather than rounds a third decimal", () => {
  // Rounding here would charge $20.00 for a typed 19.999 without saying so.
  assert.equal(parseUsdToCents("19.999"), null);
  assert.equal(parseUsdToCents(""), null);
  assert.equal(parseUsdToCents("abc"), null);
  assert.equal(parseUsdToCents("-20"), null);
  assert.equal(parseUsdToCents("2e3"), null);
  assert.equal(parseUsdToCents("20."), null);
});

test("cents ↔ micro-USD round-trips exactly for every cent in range", () => {
  for (let cents = 500; cents <= 50_000; cents += 1) {
    assert.equal(microUsdToCents(centsToMicroUsd(cents)), cents);
  }
});

test("the classic float bug does not reach the ledger", () => {
  // 19.99 * 100 === 1998.9999999999998 in IEEE-754.
  assert.equal(parseUsdToCents("19.99"), 1999);
  assert.equal(centsToMicroUsd(1999), 19_990_000);
});

test("validateTopupAmount enforces the FR-BIL-036 window", () => {
  const low = validateTopupAmount("4.99");
  assert.equal(low.ok, false);
  assert.equal(low.ok === false && low.error, "below_minimum");

  const high = validateTopupAmount("500.01");
  assert.equal(high.ok, false);
  assert.equal(high.ok === false && high.error, "above_maximum");

  const min = validateTopupAmount("5");
  assert.equal(min.ok, true);
  assert.equal(min.ok === true && min.microUsd, MIN_TOPUP_MICRO_USD);

  const max = validateTopupAmount("500");
  assert.equal(max.ok, true);
  assert.equal(max.ok === true && max.microUsd, MAX_TOPUP_MICRO_USD);
});

test("validateTopupAmount returns both units for a valid amount", () => {
  const result = validateTopupAmount("20.50");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.centsUsd, 2050);
  assert.equal(result.microUsd, 20_500_000);
});

test("every preset is itself a valid amount", () => {
  for (const preset of TOPUP_PRESETS_MICRO_USD) {
    const result = validateTopupAmount(String(preset / MICRO_PER_USD));
    assert.equal(result.ok, true, `preset ${preset} must validate`);
    assert.equal(result.ok === true && result.microUsd, preset);
  }
});

test("formatUsdFromMicro pads cents and keeps the sign", () => {
  assert.equal(formatUsdFromMicro(5 * MICRO_PER_USD), "$5.00");
  assert.equal(formatUsdFromMicro(20_500_000), "$20.50");
  assert.equal(formatUsdFromMicro(2_000_000_000), "$2000.00");
  assert.equal(formatUsdFromMicro(50_000), "$0.05");
  assert.equal(formatUsdFromMicro(-1_500_000), "-$1.50");
});

test("exceedsMaxBalance is inclusive of the cap, not of one micro-USD past it", () => {
  const cap = 2_000 * MICRO_PER_USD;
  assert.equal(exceedsMaxBalance(cap - 5 * MICRO_PER_USD, 5 * MICRO_PER_USD, cap), false);
  assert.equal(exceedsMaxBalance(cap - 5 * MICRO_PER_USD + 1, 5 * MICRO_PER_USD, cap), true);
});
