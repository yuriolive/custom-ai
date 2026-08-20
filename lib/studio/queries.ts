/**
 * Read-only Creator Studio queries.
 *
 * Every function takes a Supabase client rather than creating one, so the same
 * query runs from a Server Component (initial paint) and from the browser
 * (post-mutation refresh) — the console's convention, kept.
 *
 * SCOPING. `custom_models` has two SELECT policies: the public catalog one
 * (`visibility = 'public' AND status = 'ready'`) and the owner one
 * (`user_id = auth.uid()`). "Every row I can read" is therefore NOT "every row
 * I own" — a signed-in creator can read every public model on the platform
 * through the first policy. So `fetchMyModels` filters on `user_id` explicitly
 * rather than leaning on RLS, exactly as `lib/console/queries.ts` does for
 * `usage_transactions` and for the same class of reason: an omitted filter here
 * would list somebody else's models on a page whose every control assumes
 * ownership.
 *
 * Earnings come from `creator_earnings_feed`, the view that strips the payer's
 * identity. A creator may see what their models earned; they may not see who
 * called them or with which key.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CommercialHosting } from "@nexus/hf-probe";

import { evaluateLicenseGate, holdHintForListing } from "./license";
import type { ModelStatus, MyModelRow } from "./types";

const MODEL_COLUMNS =
  "id, slug, display_name, status, visibility, context_length, " +
  "measured_tokens_per_second, predicted_tokens_per_second, cost_floor_micro_per_mtoken, " +
  "price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken, pricing_version, " +
  "total_requests, remediation_hint, provisioning_error, created_at, ready_at, " +
  // The licence gate's own state (#29). Read here rather than left to the
  // constraint because the alternative is a creator pressing "Make public" and
  // being shown the text of a CHECK violation.
  "license_hosting, license_terms_version, license_ack_version, license_public_requested_at";

/** Rows shaped as PostgREST returns them, before renaming. */
type RawModel = {
  id: string;
  slug: string;
  display_name: string;
  status: ModelStatus;
  visibility: "public" | "private";
  context_length: number;
  measured_tokens_per_second: number | null;
  predicted_tokens_per_second: number | null;
  cost_floor_micro_per_mtoken: number | null;
  price_prompt_micro_usd_per_mtoken: number;
  price_completion_micro_usd_per_mtoken: number;
  pricing_version: number;
  total_requests: number;
  remediation_hint: string | null;
  provisioning_error: unknown;
  created_at: string;
  ready_at: string | null;
  license_hosting: CommercialHosting;
  license_terms_version: string | null;
  license_ack_version: string | null;
  license_public_requested_at: string | null;
};

/** The upstream's own message out of the `provisioning_error` envelope. */
function errorMessage(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = (raw as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * Every model the creator owns, in any status, newest first.
 *
 * Soft-deleted rows are excluded. They still exist — `usage_transactions`
 * references them and a caller's ledger must stay readable — but they are not
 * the creator's models any more.
 */
export async function fetchMyModels(
  supabase: SupabaseClient,
  userId: string,
): Promise<MyModelRow[]> {
  const { data, error } = await supabase
    .from("custom_models")
    .select(MODEL_COLUMNS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(error.message);
  const models = (data ?? []) as unknown as RawModel[];
  if (models.length === 0) return [];

  const rollup = await fetchEarningsRollup(supabase);

  return models.map((m) => {
    const totals = rollup.get(m.id);
    return {
      id: m.id,
      slug: m.slug,
      displayName: m.display_name,
      status: m.status,
      visibility: m.visibility,
      contextLength: m.context_length,
      measuredTokensPerSecond: m.measured_tokens_per_second,
      predictedTokensPerSecond: m.predicted_tokens_per_second,
      costFloorMicroPerMtoken: m.cost_floor_micro_per_mtoken,
      pricePromptMicro: m.price_prompt_micro_usd_per_mtoken,
      priceCompletionMicro: m.price_completion_micro_usd_per_mtoken,
      pricingVersion: m.pricing_version,
      totalRequests: m.total_requests,
      tokens30d: totals?.tokens ?? 0,
      earnings30dMicro: totals?.earningsMicro ?? 0,
      remediationHint: m.remediation_hint,
      provisioningError: errorMessage(m.provisioning_error),
      createdAt: m.created_at,
      readyAt: m.ready_at,
      ...licenseFields(m),
    };
  });
}

/**
 * Can this listing be public, and if not, why not (#29)?
 *
 * Asked with `wantsPublic: true` unconditionally, including for a row that is
 * already private and has not asked: the question the page has to answer is
 * whether the "Make public" control would work, not whether anybody has pressed
 * it. A row that IS public necessarily answers yes — the CHECK guarantees it —
 * so `licenseHold` is null there without a special case.
 */
function licenseFields(m: RawModel): Pick<
  MyModelRow,
  "licenseHosting" | "licenseTermsVersion" | "licenseHold" | "licenseAwaitingReview"
> {
  const decision = evaluateLicenseGate({
    hosting: m.license_hosting,
    termsVersion: m.license_terms_version,
    wantsPublic: true,
    acknowledgedVersion: m.license_ack_version,
  });
  return {
    licenseHosting: m.license_hosting,
    licenseTermsVersion: m.license_terms_version,
    licenseHold:
      decision.publish || decision.hold === null
        ? null
        : { message: decision.message ?? "", hint: holdHintForListing(decision.hold) },
    // In the operator queue right now: the creator asked, and the answer is one
    // only an operator can give.
    licenseAwaitingReview:
      m.license_public_requested_at !== null && m.license_hosting === "unknown",
  };
}

/**
 * Trailing-30-day tokens and creator earnings, per model.
 *
 * Summed in JS over the raw feed rather than in SQL, because PostgREST cannot
 * GROUP BY without a database view and this page is bounded: a creator's models
 * are few and this window is 30 days. `ROLLUP_LIMIT` is the point past which
 * the sum would silently start under-reporting — at which point this needs a
 * materialized view, not a bigger limit. The cap is stated rather than assumed
 * so the failure is visible in the code that would produce it.
 *
 * The addition is integer micro-USD throughout (CONTRACTS.md §Money).
 */
const ROLLUP_LIMIT = 5_000;

async function fetchEarningsRollup(
  supabase: SupabaseClient,
): Promise<Map<string, { tokens: number; earningsMicro: number }>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("creator_earnings_feed")
    .select("model_id, total_tokens, creator_micro_usd")
    .gte("created_at", since)
    .limit(ROLLUP_LIMIT);

  // A failed rollup must not blank the models table: the page's primary job is
  // listing and managing models, and earnings are a column on it. Zeroes with a
  // working table beat an error page with neither.
  if (error) return new Map();

  const out = new Map<string, { tokens: number; earningsMicro: number }>();
  for (const row of (data ?? []) as {
    model_id: string;
    total_tokens: number | null;
    creator_micro_usd: number | null;
  }[]) {
    const current = out.get(row.model_id) ?? { tokens: 0, earningsMicro: 0 };
    current.tokens += row.total_tokens ?? 0;
    current.earningsMicro += row.creator_micro_usd ?? 0;
    out.set(row.model_id, current);
  }
  return out;
}
