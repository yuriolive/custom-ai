/**
 * Plain, serializable row shapes for the developer console.
 *
 * Every one of these crosses a Server Component -> Client Component boundary,
 * so they hold only JSON primitives: timestamps stay as ISO strings and money
 * stays as an integer number of micro-USD (CONTRACTS.md §Money — no floats
 * anywhere in a monetary path; the single division happens in `formatMicroUsd`
 * at render time and is never read back).
 *
 * `api_keys.key_hash` is deliberately absent from `ApiKeyRow`. RLS lets the
 * owner read it, and it is not reversible, but it is the exact value the
 * gateway compares against — it has no business in a browser bundle, a React
 * payload, or a devtools network tab.
 */

/** One row of `api_keys`, minus the hash. */
export type ApiKeyRow = {
  id: string;
  name: string;
  /** Display-only, e.g. `sk-plat-a1b2c3d4`. Insufficient to authenticate. */
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  request_count: number;
};

/**
 * The response of `POST /api/keys`, and the ONLY place a plaintext key exists
 * outside the caller's own storage. It is never persisted, never logged, and
 * never returned by any subsequent read.
 */
export type CreatedApiKey = ApiKeyRow & {
  /** Shown exactly once, in the reveal modal. */
  plaintext: string;
};

export type UsageStatus = "reserved" | "settled" | "voided" | "expired" | "failed";

/** One row of `usage_transactions`, joined to the model's slug. */
export type UsageRow = {
  id: string;
  created_at: string;
  settled_at: string | null;
  status: UsageStatus;
  model_id: string;
  /** `custom_models.slug`. Null when the model row is not readable (private, deleted). */
  model_slug: string | null;
  model_display_name: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_prompt_tokens: number;
  cost_micro_usd: number | null;
  hold_micro_usd: number;
  usage_estimated: boolean;
  ttft_ms: number | null;
  duration_ms: number | null;
  cold_start: boolean | null;
  error_code: string | null;
};

export type LedgerKind =
  | "topup"
  | "grant"
  | "usage_debit"
  | "refund"
  | "chargeback"
  | "adjustment";

/** One row of `wallet_ledger`. Signed amount: credits > 0, debits < 0. */
export type LedgerRow = {
  id: number;
  created_at: string;
  kind: LedgerKind;
  amount_micro_usd: number;
  balance_after_micro_usd: number;
  memo: string | null;
  usage_transaction_id: string | null;
};

/** Keyset cursor for `usage_transactions`, ordered (created_at desc, id desc). */
export type UsageCursor = { createdAt: string; id: string };

/** A model the caller has actually spent money on — the usage filter's options. */
export type CalledModel = { id: string; label: string };

/** Wallet + 30-day rollup for the overview card. */
export type ConsoleSummary = {
  balanceMicroUsd: number;
  lifetimeSpendMicroUsd: number;
  handle: string;
  /** Settled spend over the trailing 30 days, micro-USD. */
  spend30dMicroUsd: number;
  /** Requests over the trailing 30 days, all statuses. */
  requests30d: number;
  /** Settled requests over the trailing 30 days. */
  settled30d: number;
  /** Settled requests in the window whose token counts were estimated, not reported. */
  estimated30d: number;
  /**
   * True when the 30-day window holds more rows than the rollup query read, so
   * `spend30dMicroUsd` is a floor rather than the exact figure. Surfaced in the
   * UI rather than silently rounded away.
   */
  truncated: boolean;
};
