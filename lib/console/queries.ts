/**
 * Read-only console queries.
 *
 * Every function here takes a Supabase client rather than creating one, so the
 * exact same query runs from a Server Component (initial paint, cookie-bound
 * session) and from the browser (pagination, filtering, post-mutation refresh).
 * Nothing in this module writes.
 *
 * SCOPING. For `api_keys` and `wallet_ledger`, RLS is the whole story: their
 * only SELECT policy is `user_id = auth.uid()`, so those functions take no user
 * id and cannot leak across accounts even if a caller forgets one.
 *
 * `usage_transactions` is DIFFERENT, and the difference is a money bug waiting
 * to happen. That table has TWO select policies
 * (20260817000900_usage_transactions.sql):
 *
 *   usage_txn_select_own        user_id    = auth.uid()
 *   usage_txn_select_as_creator creator_id = auth.uid() AND status = 'settled'
 *
 * The second exists so a creator can see earnings on their own models. It means
 * "every row I can read" is NOT "every row I paid for": a creator reading this
 * table sees other people's spend on their models, at the payer's cost. Summing
 * that into a "spend" figure reports money the account never spent — observed
 * live, before this note existed: the seeded creator has a $0 balance, has never
 * paid for a request, and their console read "Spend · 30 days $0.000384".
 *
 * So every `usage_transactions` read below takes `userId` as a REQUIRED
 * positional argument and filters on it explicitly. That is deliberately not an
 * optional field on the query object — an omitted filter here misstates a bill,
 * so it must be impossible to omit. Creator-side earnings are a separate
 * surface (`creator_earnings_feed`), not this one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ApiKeyRow,
  CalledModel,
  ConsoleSummary,
  LedgerRow,
  UsageCursor,
  UsageRow,
} from "./types";

/** Rows per page in the usage and ledger tables. */
export const PAGE_SIZE = 25;

/**
 * How many rows the 30-day rollup will read before it gives up on being exact.
 * A developer with more than this many calls in a month needs a real analytics
 * surface, not a console card — so the card says so instead of lying.
 */
const ROLLUP_LIMIT = 5_000;

/**
 * `key_hash` is not in this list, and must never be added. See the note on
 * `ApiKeyRow`.
 */
const KEY_COLUMNS =
  "id, name, key_prefix, created_at, last_used_at, revoked_at, request_count";

const USAGE_COLUMNS =
  "id, created_at, settled_at, status, model_id, prompt_tokens, completion_tokens, " +
  "cached_prompt_tokens, cost_micro_usd, hold_micro_usd, usage_estimated, ttft_ms, " +
  "duration_ms, cold_start, error_code, custom_models(slug, display_name)";

const LEDGER_COLUMNS =
  "id, created_at, kind, amount_micro_usd, balance_after_micro_usd, memo, usage_transaction_id";

/** PostgREST value quoting — timestamps carry `:` and `+`, which are reserved. */
function quoted(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** An embedded to-one relation arrives as an object, or as a 1-element array. */
function firstEmbedded<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return (value as T) ?? null;
}

// ─── API keys ───────────────────────────────────────────────────────────────

export async function fetchApiKeys(
  supabase: SupabaseClient,
): Promise<ApiKeyRow[]> {
  const { data, error } = await supabase
    .from("api_keys")
    .select(KEY_COLUMNS)
    .order("revoked_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ApiKeyRow[];
}

// ─── Usage ledger ───────────────────────────────────────────────────────────

export type UsageQuery = {
  /** Keyset cursor; omit for the first page. */
  cursor?: UsageCursor | null;
  /** `custom_models.id`, or null for every model. */
  modelId?: string | null;
  /** Inclusive lower bound, ISO instant. */
  fromIso?: string | null;
  /** Inclusive upper bound, ISO instant. */
  toIso?: string | null;
  limit?: number;
};

export type UsagePage = {
  rows: UsageRow[];
  /** Cursor to pass back for the next page, or null when the ledger is exhausted. */
  nextCursor: UsageCursor | null;
};

type UsageRecord = Omit<UsageRow, "model_slug" | "model_display_name"> & {
  custom_models?: unknown;
};

export async function fetchUsagePage(
  supabase: SupabaseClient,
  /** The caller's own id. Rows where they are only the CREATOR are excluded. */
  userId: string,
  query: UsageQuery = {},
): Promise<UsagePage> {
  const limit = query.limit ?? PAGE_SIZE;

  let q = supabase
    .from("usage_transactions")
    .select(USAGE_COLUMNS)
    // Not redundant with RLS — see the note at the top of this file.
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    // One extra row is the has-more probe: cheaper and more honest than an
    // exact count over a table that grows with every request ever made.
    .limit(limit + 1);

  if (query.modelId) q = q.eq("model_id", query.modelId);
  if (query.fromIso) q = q.gte("created_at", query.fromIso);
  if (query.toIso) q = q.lte("created_at", query.toIso);

  if (query.cursor) {
    const { createdAt, id } = query.cursor;
    q = q.or(
      `created_at.lt.${quoted(createdAt)},` +
        `and(created_at.eq.${quoted(createdAt)},id.lt.${quoted(id)})`,
    );
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const records = (data ?? []) as unknown as UsageRecord[];
  const hasMore = records.length > limit;
  const page = hasMore ? records.slice(0, limit) : records;

  const rows: UsageRow[] = page.map((record) => {
    const { custom_models, ...rest } = record;
    const model = firstEmbedded<{ slug: string; display_name: string }>(custom_models);
    return {
      ...rest,
      model_slug: model?.slug ?? null,
      model_display_name: model?.display_name ?? null,
    };
  });

  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor:
      hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

/**
 * The distinct models the caller has actually called, for the filter Select.
 *
 * Deliberately bounded: it scans the caller's most recent `scan` transactions
 * rather than the whole ledger. A model the developer last used two thousand
 * calls ago is not worth a full table scan on every console load, and the date
 * filter still reaches those rows.
 */
export async function fetchCalledModels(
  supabase: SupabaseClient,
  /** The caller's own id — models they PAID to call, not models they own. */
  userId: string,
  scan = 500,
): Promise<CalledModel[]> {
  const { data, error } = await supabase
    .from("usage_transactions")
    .select("model_id, custom_models(slug, display_name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(scan);

  if (error) throw new Error(error.message);

  const seen = new Map<string, CalledModel>();
  for (const record of (data ?? []) as unknown as {
    model_id: string;
    custom_models?: unknown;
  }[]) {
    if (seen.has(record.model_id)) continue;
    const model = firstEmbedded<{ slug: string; display_name: string }>(
      record.custom_models,
    );
    seen.set(record.model_id, {
      id: record.model_id,
      label: model?.slug ?? model?.display_name ?? "unavailable model",
    });
  }

  return [...seen.values()].toSorted((a, b) => a.label.localeCompare(b.label));
}

// ─── Wallet ledger ──────────────────────────────────────────────────────────

export type LedgerPage = {
  rows: LedgerRow[];
  /** `wallet_ledger.id` (bigserial) to page past, or null when exhausted. */
  nextCursor: number | null;
};

export async function fetchLedgerPage(
  supabase: SupabaseClient,
  cursor: number | null = null,
  limit = PAGE_SIZE,
): Promise<LedgerPage> {
  let q = supabase
    .from("wallet_ledger")
    .select(LEDGER_COLUMNS)
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (cursor != null) q = q.lt("id", cursor);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const records = (data ?? []) as unknown as LedgerRow[];
  const hasMore = records.length > limit;
  const rows = hasMore ? records.slice(0, limit) : records;
  const last = rows[rows.length - 1];

  return { rows, nextCursor: hasMore && last ? last.id : null };
}

// ─── Overview rollup ────────────────────────────────────────────────────────

/**
 * Wallet balance plus a trailing-30-day rollup.
 *
 * The rollup is summed in TypeScript over integer micro-USD rather than pushed
 * into a PostgREST aggregate: `sum()` over a `bigint` comes back as a string on
 * some paths and as a JS number on others, and a silent float coercion in the
 * monetary path is exactly what CONTRACTS.md §Money forbids. Integers up to
 * 2^53 cover $9 billion, so the addition below is exact.
 */
export async function fetchSummary(
  supabase: SupabaseClient,
  userId: string,
  sinceIso: string,
): Promise<ConsoleSummary> {
  const [profileResult, usageResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("handle, balance_micro_usd, lifetime_spend_micro_usd")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("usage_transactions")
      .select("status, cost_micro_usd, usage_estimated", { count: "exact" })
      // Payer-scoped. Without this the creator policy folds other people's
      // spend on this account's models into `spend30dMicroUsd`.
      .eq("user_id", userId)
      .gte("created_at", sinceIso)
      .limit(ROLLUP_LIMIT),
  ]);

  if (profileResult.error) throw new Error(profileResult.error.message);
  if (usageResult.error) throw new Error(usageResult.error.message);

  const profile = profileResult.data as {
    handle: string;
    balance_micro_usd: number;
    lifetime_spend_micro_usd: number;
  } | null;

  const rows = (usageResult.data ?? []) as unknown as {
    status: string;
    cost_micro_usd: number | null;
    usage_estimated: boolean;
  }[];

  let spend = 0;
  let settled = 0;
  let estimated = 0;
  for (const row of rows) {
    if (row.status !== "settled") continue;
    settled += 1;
    spend += row.cost_micro_usd ?? 0;
    if (row.usage_estimated) estimated += 1;
  }

  const total = usageResult.count ?? rows.length;

  return {
    handle: profile?.handle ?? "account",
    balanceMicroUsd: profile?.balance_micro_usd ?? 0,
    lifetimeSpendMicroUsd: profile?.lifetime_spend_micro_usd ?? 0,
    spend30dMicroUsd: spend,
    requests30d: total,
    settled30d: settled,
    estimated30d: estimated,
    truncated: total > rows.length,
  };
}
