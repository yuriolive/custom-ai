/**
 * Top-up amount arithmetic and limits (FR-BIL-036, FR-CON-006).
 *
 * Pure, dependency-free, and imported by BOTH the browser modal and the route
 * handler that talks to Stripe. That is the point: the modal's validation and
 * the server's validation cannot drift apart, because there is one function.
 * The server still re-validates — the client copy is a courtesy, never a gate.
 *
 * MONEY IS INTEGERS EVERYWHERE. The ledger is micro-USD (1e-6 USD) and Stripe
 * wants cents. Dollars appear only as a display string and as the raw text a
 * human typed. No float ever holds a balance: `19.99 * 100` is 1998.9999… in
 * IEEE-754, and that is precisely the class of bug this module exists to make
 * unrepresentable.
 */

/** 1 USD in micro-USD. The ledger's unit (PRD §5.6). */
export const MICRO_PER_USD = 1_000_000;
/** 1 USD in cents. Stripe's unit for `usd`. */
export const CENTS_PER_USD = 100;

/** FR-BIL-036: min $5 per top-up. Below this, fees eat the transaction. */
export const MIN_TOPUP_MICRO_USD = 5 * MICRO_PER_USD;
/** FR-BIL-036: max $500 per top-up (AML/fraud containment for MVP). */
export const MAX_TOPUP_MICRO_USD = 500 * MICRO_PER_USD;

/** FR-CON-006 preset chips, in micro-USD. */
export const TOPUP_PRESETS_MICRO_USD = [
  5 * MICRO_PER_USD,
  20 * MICRO_PER_USD,
  100 * MICRO_PER_USD,
] as const;

export type TopupAmountError =
  "not_a_number" | "not_a_whole_cent" | "below_minimum" | "above_maximum";

export type TopupAmountResult =
  | { ok: true; centsUsd: number; microUsd: number }
  | { ok: false; error: TopupAmountError; message: string };

/** micro-USD → cents. Exact: 10_000 micro-USD is one cent, no remainder. */
export function microUsdToCents(microUsd: number): number {
  return Math.round(microUsd / (MICRO_PER_USD / CENTS_PER_USD));
}

/** cents → micro-USD. */
export function centsToMicroUsd(cents: number): number {
  return cents * (MICRO_PER_USD / CENTS_PER_USD);
}

/** `5000000` → `"$5.00"`. Display only. */
export function formatUsdFromMicro(microUsd: number): string {
  const cents = microUsdToCents(microUsd);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Parse a human-typed dollar amount into cents WITHOUT floating point.
 *
 * Accepts `20`, `20.5`, `20.50`, `$20.50`, `1,000`. Rejects anything with more
 * than two decimal places instead of silently rounding it: a developer who
 * typed `19.999` should be told, not charged $20.00.
 */
export function parseUsdToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = (match[2] ?? "").padEnd(2, "0");
  if (!Number.isSafeInteger(whole)) return null;
  return whole * CENTS_PER_USD + Number(frac);
}

/**
 * The single validation used by the modal and by `POST /api/wallet/topup`.
 *
 * `raw` is either the text from the custom NumberField or a preset rendered as
 * a string, so there is exactly one code path and presets are validated by the
 * same rules as free text.
 */
export function validateTopupAmount(raw: string): TopupAmountResult {
  const cents = parseUsdToCents(raw);
  if (cents === null) {
    return {
      ok: false,
      error: "not_a_number",
      message: "Enter an amount in dollars, for example 20 or 20.50.",
    };
  }
  if (!Number.isSafeInteger(cents)) {
    return {
      ok: false,
      error: "not_a_whole_cent",
      message: "Amount must be a whole number of cents.",
    };
  }

  const microUsd = centsToMicroUsd(cents);
  if (microUsd < MIN_TOPUP_MICRO_USD) {
    return {
      ok: false,
      error: "below_minimum",
      message: `Minimum top-up is ${formatUsdFromMicro(MIN_TOPUP_MICRO_USD)}.`,
    };
  }
  if (microUsd > MAX_TOPUP_MICRO_USD) {
    return {
      ok: false,
      error: "above_maximum",
      message: `Maximum top-up is ${formatUsdFromMicro(MAX_TOPUP_MICRO_USD)}.`,
    };
  }

  return { ok: true, centsUsd: cents, microUsd };
}

/**
 * Would this credit breach the account cap (FR-BIL-036, $2,000 default)?
 *
 * Checked before Checkout so the developer is refused at a form field rather
 * than after their card is charged — the RPC's own cap check stays in place as
 * the authority, because the balance can move between here and the webhook.
 */
export function exceedsMaxBalance(
  balanceMicroUsd: number,
  topupMicroUsd: number,
  maxBalanceMicroUsd: number,
): boolean {
  return balanceMicroUsd + topupMicroUsd > maxBalanceMicroUsd;
}
