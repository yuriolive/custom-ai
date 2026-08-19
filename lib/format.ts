/**
 * Display formatting for micro-USD. Integer maths only, per CONTRACTS.md
 * §Money: "No floats anywhere in a monetary path". The division below is the
 * single, final presentation step — nothing downstream reads the result back.
 */
export function formatMicroUsd(
  micro: number | null | undefined,
  opts: { rounding?: "nearest" | "down" } = {},
): string {
  if (micro == null) return "—";
  const negative = micro < 0;
  const abs = Math.abs(Math.trunc(micro));

  // Below a tenth of a cent, show 4 decimals so a real charge never reads $0.00.
  const decimals = abs < 1_000 ? 6 : abs < 10_000 ? 4 : 2;
  const divisor = 10 ** (6 - decimals);
  const scaled = opts.rounding === "down" ? Math.floor(abs / divisor) : Math.round(abs / divisor);
  const whole = Math.floor(scaled / 10 ** decimals);
  const frac = String(scaled % 10 ** decimals).padStart(decimals, "0");

  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/**
 * An AVAILABLE BALANCE must never be displayed rounded UP.
 *
 * `formatMicroUsd` rounds to nearest, which is right for a cost already
 * incurred but wrong for spendable funds: a balance of 9,999,328 micro-USD
 * renders as "$10.00", telling the holder they can spend more than they
 * actually have, and the shortfall only surfaces as a 402 mid-request.
 * Rounding down is the conservative direction for funds you are about to
 * spend, exactly as CEIL is the conservative direction for a charge
 * (CONTRACTS.md §Money).
 *
 * Use this for wallet balances and any "available" figure. Use
 * `formatMicroUsd` for costs, charges and ledger amounts.
 */
export function formatBalanceMicroUsd(micro: number | null | undefined): string {
  return formatMicroUsd(micro, { rounding: "down" });
}

/** Compact integer formatting for token counts. */
export function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US");
}

/** Milliseconds, rendered as ms under a second and seconds above it. */
export function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(Math.round(value / 100) / 10).toFixed(1)} s`;
}

/** Tokens per second, one decimal. */
export function formatRate(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(Math.round(value * 10) / 10).toFixed(1)} tok/s`;
}

/**
 * The reference credit the catalog card's value footer is quoted against, in
 * micro-USD.
 *
 * $5 is chosen deliberately: small enough that a developer reads it as "what I
 * would top up with to try this", and large enough that both figures land in
 * the millions for every price band we sell, so two cards stay comparable
 * instead of one collapsing to a thousands figure.
 */
export const VALUE_FOOTER_CREDIT_MICRO = 5_000_000;

/**
 * How many tokens a given credit buys at a given per-1M-token price.
 *
 * `pricePerMtokenMicro` is micro-USD per 1,000,000 tokens (CONTRACTS.md §Money,
 * and the two `price*MicroPerMtoken` fields on `CatalogModel`), so:
 *
 *     tokens = credit_micro × 1_000_000 ÷ price_micro_per_Mtoken
 *
 * FLOORED, NOT ROUNDED. This is an "at most" claim about someone's money, and
 * rounding to nearest — the reflex, and what `formatMicroUsd` correctly does for
 * a charge already incurred — would promise tokens the balance cannot pay for.
 * Both operands are integers and the intermediate product tops out around 1e13,
 * well inside the exact integer range of a double, so no float error enters.
 *
 * Returns null for a zero or nonsensical price: "free" is a different sentence
 * from a number, and dividing by zero here would render "Infinity tokens".
 *
 * THIS LIVES IN `lib/` RATHER THAN BESIDE THE CARD THAT RENDERS IT because it
 * is money arithmetic and this is where money arithmetic is tested — `test:app`
 * cannot load a module under `components/` at all, since Node's test runner
 * does not resolve the `@/` path alias that those modules import through.
 */
export function tokensForCredit(
  pricePerMtokenMicro: number,
  creditMicro: number = VALUE_FOOTER_CREDIT_MICRO,
): number | null {
  if (!Number.isFinite(pricePerMtokenMicro) || pricePerMtokenMicro <= 0) return null;
  if (!Number.isFinite(creditMicro) || creditMicro <= 0) return null;
  return Math.floor((creditMicro * 1_000_000) / pricePerMtokenMicro);
}

/** Compact token counts for the value footer: 1.2B, 3.5M, 934k, 812. */
function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${Math.round(value / 100_000_000) / 10}B`;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString("en-US");
}

/**
 * The catalog card's value footer: a per-token price restated as the question a
 * developer actually has — "what do I get for a fiver?".
 *
 * Reads as `$5.00 buys ~3.5M input / 1.1M output tokens`. The `~` is honest:
 * `compactTokens` rounds to one decimal, and the credit is a reference amount
 * rather than a balance anyone actually holds.
 */
export function formatCreditValue(
  pricePromptMicroPerMtoken: number,
  priceCompletionMicroPerMtoken: number,
  creditMicro: number = VALUE_FOOTER_CREDIT_MICRO,
): string {
  const credit = formatMicroUsd(creditMicro);
  const input = tokensForCredit(pricePromptMicroPerMtoken, creditMicro);
  const output = tokensForCredit(priceCompletionMicroPerMtoken, creditMicro);

  if (input == null && output == null) {
    return `Free — ${credit} of credit is never drawn down by this model`;
  }

  const part = (tokens: number | null) =>
    tokens == null ? "unmetered" : `~${compactTokens(tokens)}`;
  return `${credit} buys ${part(input)} input / ${part(output)} output tokens`;
}
