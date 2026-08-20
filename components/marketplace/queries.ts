/**
 * Catalog reads for the public marketplace (FR-MKT-003/004/005/006/010).
 *
 * Every function takes a Supabase client rather than creating one, matching
 * `lib/console/queries.ts`, so the same query can run from a Server Component
 * and (later) from the browser without a second implementation.
 *
 * Two rules govern this file:
 *
 *  1. **All filtering is server-side.** Search goes through the `search_vector`
 *     GIN index, not through JavaScript over a fetched array. Filtering client-
 *     side would mean shipping every public model to every visitor, and would
 *     make the result count in the UI a lie.
 *
 *  2. **The projection is the security boundary.** `select *` would publish
 *     `upstream_endpoint_ref`, `placement_rationale`, `gpu_tier_id` and the
 *     solver's internals to anonymous visitors — and, because these rows are
 *     handed to a `"use client"` component, straight into the RSC payload in the
 *     browser. `CATALOG_COLUMNS` is an allow-list, and nothing hardware-shaped
 *     is on it (FR-MKT-002).
 *
 * NOTE ON RLS: the `visibility`/`status`/`deleted_at` predicates below are not
 * redundant with the `custom_models_select_public` policy. That policy is one of
 * TWO select policies and Postgres ORs them: a signed-in creator also matches
 * `custom_models_select_own`, which admits their own rows in ANY status. Without
 * these predicates, a creator browsing the public catalog would see their own
 * drafts and failed deployments listed as though they were public. RLS is the
 * floor that stops anonymous visitors reading private rows; this is the query
 * actually asking for the public catalog.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { CONTEXT_STEPS, priceRungs, qualityRungs, qualityTier, SPEED_STEPS } from "./format";
import { handleFragment, toPrefixTsQuery } from "./search-query.ts";
import { PAGE_SIZE } from "./search-params";
import type {
  CatalogCounts,
  CatalogGroup,
  CatalogGroupPage,
  CatalogModel,
  CatalogQuery,
  ModelCategory,
} from "./types";
import { MODEL_CATEGORIES } from "./types";

/**
 * Allow-listed projection. `creator_public` is a SECURITY DEFINER view whose
 * column list is itself a security boundary (migration 20260817001900) — and it
 * is the only way to read a creator handle as `anon`, because `profiles` has no
 * public SELECT policy at all.
 *
 * `!inner`, not a left join: a row whose creator is suspended (the view filters
 * `is_suspended = false`) has no public identity, therefore no addressable
 * `creator/slug` id, and must not be listed.
 */
const CATALOG_COLUMNS =
  "id, user_id, slug, display_name, description, " +
  "measured_tokens_per_second, context_length, context_verified, variant_quant_tag, " +
  "price_prompt_micro_usd_per_mtoken, price_completion_micro_usd_per_mtoken, " +
  "total_requests, total_prompt_tokens, total_completion_tokens, " +
  "p50_ttft_ms, p95_ttft_ms, created_at, ready_at, " +
  "creator_public!inner(handle, display_name)";

type CreatorEmbed = { handle: string; display_name: string | null };

type CatalogRow = {
  id: string;
  user_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  measured_tokens_per_second: number | null;
  context_length: number;
  context_verified: boolean;
  variant_quant_tag: string | null;
  price_prompt_micro_usd_per_mtoken: number;
  price_completion_micro_usd_per_mtoken: number;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  p50_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  created_at: string;
  ready_at: string | null;
  creator_public: CreatorEmbed | CreatorEmbed[] | null;
};

/** An embedded to-one relation arrives as an object, or as a 1-element array. */
function firstEmbedded<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toCatalogModel(row: CatalogRow): CatalogModel | null {
  const creator = firstEmbedded(row.creator_public);
  if (!creator?.handle) return null;

  return {
    id: row.id,
    creatorHandle: creator.handle,
    creatorDisplayName: creator.display_name ?? null,
    slug: row.slug,
    // The ONE place the platform model id is constructed. Both halves are
    // lowercase by schema CHECK, so this is already the exact string the gateway
    // resolves — see the header of snippets.ts for why it is never `hf_repo_slug`.
    modelId: `${creator.handle}/${row.slug}`,
    displayName: row.display_name,
    description: row.description,
    measuredTokensPerSecond: row.measured_tokens_per_second,
    contextLength: row.context_length,
    contextVerified: row.context_verified,
    quantTag: row.variant_quant_tag,
    qualityTier: qualityTier(row.variant_quant_tag),
    pricePromptMicroPerMtoken: row.price_prompt_micro_usd_per_mtoken,
    priceCompletionMicroPerMtoken: row.price_completion_micro_usd_per_mtoken,
    totalRequests: row.total_requests,
    totalPromptTokens: row.total_prompt_tokens,
    totalCompletionTokens: row.total_completion_tokens,
    p50TtftMs: row.p50_ttft_ms,
    p95TtftMs: row.p95_ttft_ms,
    createdAt: row.created_at,
    readyAt: row.ready_at,
  };
}

/**
 * True when there is no public+ready model at all.
 *
 * `head: true`, so this costs a COUNT over the partial catalog index and
 * transfers no rows. It is what lets the UI say "nothing is published yet, here
 * is how to publish something" instead of "no results, try clearing your
 * filters" when there is nothing to find either way (FR-MKT-011).
 */
export async function isCatalogEmpty(supabase: SupabaseClient): Promise<boolean> {
  const { count, error } = await supabase
    .from("custom_models")
    .select("id", { count: "exact", head: true })
    .eq("visibility", "public")
    .eq("status", "ready")
    .is("deleted_at", null)
    // `suspended_at is null` matches the visibility block in `catalog_grouped`
    // and the RLS policy in 20260820000100: an operator-suspended listing leaves
    // the public catalog. Explicit here for the same reason as the three
    // predicates above it — `custom_models_select_own` ORs a creator's own rows
    // back in, in any status.
    .is("suspended_at", null);

  // On error, claim the catalog is not empty: the zero-results copy ("try
  // clearing a filter") is a safer thing to show than "nobody has published
  // anything", which would be a false statement about the whole platform.
  if (error) return false;
  return (count ?? 0) === 0;
}

/**
 * One model by its addressable identity, or `null`.
 *
 * `null` covers "does not exist", "not public", "not ready" and "creator
 * suspended" identically, and the caller turns all of them into a 404. Telling
 * an anonymous visitor which of those it was would leak the existence of private
 * models — the same reason the gateway returns 404 rather than 403 for a private
 * model (CONTRACTS.md).
 */
export async function fetchModelByHandleAndSlug(
  supabase: SupabaseClient,
  creatorHandle: string,
  slug: string,
): Promise<CatalogModel | null> {
  const { data, error } = await supabase
    .from("custom_models")
    .select(CATALOG_COLUMNS)
    .eq("visibility", "public")
    .eq("status", "ready")
    .is("deleted_at", null)
    // `suspended_at is null` matches the visibility block in `catalog_grouped`
    // and the RLS policy in 20260820000100: an operator-suspended listing leaves
    // the public catalog. Explicit here for the same reason as the three
    // predicates above it — `custom_models_select_own` ORs a creator's own rows
    // back in, in any status.
    .is("suspended_at", null)
    .eq("slug", slug)
    .eq("creator_public.handle", creatorHandle)
    .maybeSingle();

  if (error || !data) return null;
  return toCatalogModel(data as unknown as CatalogRow);
}

/**
 * Hard ceiling on the number of model URLs `app/sitemap.ts` will emit.
 *
 * The sitemap format caps a single file at 50,000 URLs / 50 MB uncompressed. At
 * today's catalog size that is not close, so no sitemap-index machinery exists
 * here. If the catalog ever approaches this number the honest fix is a real
 * index — `generateSitemaps()` sharding the models into 50k chunks — not a
 * bigger limit: past 50,000 the file is rejected wholesale, not truncated, and
 * the platform would silently lose every model URL at once. Rows come back
 * newest-updated-first so that if this ceiling is ever hit, what survives is the
 * half a crawler most wants.
 */
export const SITEMAP_MODEL_LIMIT = 20_000;

/** One row of the sitemap projection. */
export type SitemapModel = {
  creatorHandle: string;
  slug: string;
  /** `custom_models.updated_at`, ISO-8601, maintained by a trigger. */
  updatedAt: string;
};

/**
 * Every publicly listable model, as `{creator handle, slug, updated_at}`.
 *
 * The `visibility`/`status`/`deleted_at` predicates carry more weight here than
 * anywhere else in this file. Leaning on `custom_models_select_public` alone
 * would make this function's output depend on WHICH CLIENT the caller passed:
 * Postgres ORs the second select policy, `custom_models_select_own`, in for an
 * authenticated owner, so a cookie-bound client would publish that creator's
 * drafts and failed deployments — private model ids, in a file whose entire
 * purpose is to be fetched by strangers. `app/sitemap.ts` passes a session-free
 * client as well, so this is belt and braces on the one query whose result is
 * served verbatim to the public; neither layer is load-bearing alone.
 *
 * A narrow projection, not `CATALOG_COLUMNS`: a sitemap needs the addressable
 * identity and a timestamp, and nothing else should be shipped 20,000 times.
 *
 * Returns `[]` rather than throwing — see the failure-mode note in `sitemap.ts`.
 */
export async function fetchSitemapModels(
  supabase: SupabaseClient,
  limit: number = SITEMAP_MODEL_LIMIT,
): Promise<SitemapModel[]> {
  const { data, error } = await supabase
    .from("custom_models")
    .select("slug, updated_at, creator_public!inner(handle)")
    .eq("visibility", "public")
    .eq("status", "ready")
    .is("deleted_at", null)
    // A suspended listing must leave the sitemap too, and this is the one query
    // whose result is served verbatim to strangers: leaving it in would keep
    // pointing crawlers at a URL that now 404s.
    .is("suspended_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.error("sitemap model query failed", { message: error?.message });
    return [];
  }

  const rows = data as unknown as {
    slug: string;
    updated_at: string;
    creator_public: { handle: string } | { handle: string }[] | null;
  }[];

  const models: SitemapModel[] = [];
  for (const row of rows) {
    const handle = firstEmbedded(row.creator_public)?.handle;
    // No handle means no addressable `creator/slug` id — the same reason the
    // catalog drops the row rather than linking to a URL that would 404.
    if (!handle) continue;
    models.push({ creatorHandle: handle, slug: row.slug, updatedAt: row.updated_at });
  }

  return models;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE GROUPED CATALOG (#26)
 *
 * `fetchCatalogPage` above returns DEPLOYMENTS. This returns MODELS: one row per
 * base model, aggregated over the listings that serve it.
 *
 * The two rules at the head of this file apply verbatim, and one of them is why
 * this is an RPC rather than a PostgREST query:
 *
 *  1. **All filtering is server-side.** Grouping is filtering — a client that
 *      fetched listings and grouped them in JavaScript would have to fetch EVERY
 *      public listing to know how many groups exist, which is both the payload
 *      this rule exists to prevent and a total in the UI that would be a lie.
 *      PostgREST cannot express `GROUP BY` with a per-group representative row,
 *      so the whole thing lives in `catalog_grouped` (20260820001000).
 *  2. **The projection is the security boundary.** The RPC's return is one
 *      `jsonb_build_object` with an explicit key list, and nothing
 *      hardware-shaped is on it. `mapGroup` below re-narrows it into
 *      `CatalogGroup`, so a key added to the RPC does not reach the RSC payload
 *      until someone adds it here too.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** The RPC's `groups[]` element, exactly as the migration builds it. */
type GroupRow = {
  group_key: string;
  base_model_id: string | null;
  base_slug: string | null;
  display_name: string;
  description: string | null;
  family: string | null;
  parameter_count: number | null;
  use_cases: string[] | null;
  listing_count: number;
  creator_count: number;
  best_tokens_per_second: number | null;
  best_context_length: number;
  best_context_verified: boolean;
  total_requests: number;
  total_completion_tokens: number;
  listing_id: string;
  creator_handle: string;
  creator_display_name: string | null;
  slug: string;
  quant_tag: string | null;
  price_prompt_micro: number;
  price_completion_micro: number;
  quoted_tokens_per_second: number | null;
  quoted_context_length: number;
  p50_ttft_ms: number | null;
  created_at: string;
  ready_at: string | null;
};

type GroupedResult = {
  total: number;
  page_size: number;
  offset: number;
  groups: GroupRow[];
  categories: { all: number; by_key: Record<string, number> };
  facets: {
    speed: Record<string, number>;
    context: Record<string, number>;
    quality: Record<string, number>;
    price: Record<string, number>;
    creator: Record<string, number>;
  };
};

/** Every count the RPC can return is a non-negative integer or it is not a count. */
function countMap(raw: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * Drop anything outside the closed vocabulary.
 *
 * The database CHECK already enforces it, so this only fires if the two lists
 * drift — and the failure it prevents is a chip labelled `undefined`, because
 * `categoryLabel` is a total function over `ModelCategory` and nothing else.
 */
function toCategories(raw: string[] | null): ModelCategory[] {
  const allowed = new Set<string>(MODEL_CATEGORIES);
  return (raw ?? []).filter((value): value is ModelCategory => allowed.has(value));
}

function mapGroup(row: GroupRow): CatalogGroup | null {
  // A group with no addressable listing cannot be linked to or called, so it is
  // not a card. The RPC's inner join on `creator_public` already guarantees the
  // handle, and this is the type-level echo of that.
  if (!row.creator_handle || !row.slug) return null;

  return {
    groupKey: row.group_key,
    baseModelId: row.base_model_id,
    baseSlug: row.base_slug,
    displayName: row.display_name,
    description: row.description,
    family: row.family,
    parameterCount: row.parameter_count,
    categories: toCategories(row.use_cases),

    listingCount: row.listing_count,
    creatorCount: row.creator_count,
    bestTokensPerSecond: row.best_tokens_per_second,
    bestContextLength: row.best_context_length,
    bestContextVerified: row.best_context_verified,
    totalRequests: row.total_requests,
    totalCompletionTokens: row.total_completion_tokens,

    listingId: row.listing_id,
    creatorHandle: row.creator_handle,
    creatorDisplayName: row.creator_display_name,
    slug: row.slug,
    // The ONE place the platform model id is constructed on this path, and it is
    // built from the QUOTED LISTING — never from `base_slug`, which looks like an
    // id and resolves to nothing (see `CatalogGroup.modelId`).
    modelId: `${row.creator_handle}/${row.slug}`,
    quantTag: row.quant_tag,
    qualityTier: qualityTier(row.quant_tag),
    fromPricePromptMicroPerMtoken: row.price_prompt_micro,
    fromPriceCompletionMicroPerMtoken: row.price_completion_micro,
    p50TtftMs: row.p50_ttft_ms,
    createdAt: row.created_at,
    readyAt: row.ready_at,
  };
}

function mapCounts(result: GroupedResult | null): CatalogCounts {
  const categories = countMap(result?.categories?.by_key);
  const kept: Partial<Record<ModelCategory, number>> = {};
  for (const category of MODEL_CATEGORIES) {
    if (categories[category] !== undefined) kept[category] = categories[category];
  }

  return {
    all: result?.categories?.all ?? 0,
    categories: kept,
    speed: countMap(result?.facets?.speed),
    context: countMap(result?.facets?.context),
    quality: countMap(result?.facets?.quality),
    price: countMap(result?.facets?.price),
    creator: countMap(result?.facets?.creator),
  };
}

const EMPTY_COUNTS: CatalogCounts = {
  all: 0,
  categories: {},
  speed: {},
  context: {},
  quality: {},
  price: {},
  creator: {},
};

/**
 * One page of the grouped catalog, plus every count the tabs and the rail need.
 *
 * ONE round trip, and that is a correctness requirement rather than a
 * performance one: the tab counts have to match the rows the tab returns, and two
 * queries can disagree — a listing goes `ready` between them and the page says
 * `Code 11` above eleven rows and one blank space. `catalog_grouped` computes
 * both from the same filtered set in the same snapshot.
 *
 * The rail's DEFINITION travels with the call (`qualityRungs()`, `priceRungs()`,
 * the two step arrays). The database does not hold a second copy of the quality
 * ladder — see `qualityRungs` for why that matters.
 */
export async function fetchCatalogGroups(
  supabase: SupabaseClient,
  query: CatalogQuery,
): Promise<CatalogGroupPage> {
  const [rpcResult, catalogIsEmpty] = await Promise.all([
    supabase.rpc("catalog_grouped", {
      // Tokenized here, not in SQL: `toPrefixTsQuery` is the one place the
      // search-as-you-type behaviour is defined, and the RPC re-validates the
      // shape so a hand-edited `?q=` cannot raise 42601 on the front page.
      p_ts_query: toPrefixTsQuery(query.q),
      // The creator-handle arm of search (FR-MKT-003). Sent independently of
      // `p_ts_query`, because the two sanitize differently and the gap is
      // reachable: `?q=--` yields no tsquery tokens but a legal handle fragment,
      // and the RPC treats "no search" as BOTH being absent rather than as the
      // tsquery alone being absent.
      p_handle_fragment: query.q ? handleFragment(query.q) : null,
      p_min_speed: query.minSpeed,
      p_min_context: query.minContext,
      p_quality_key: query.quality,
      p_price_key: query.price,
      p_creator: query.creator,
      p_category: query.category,
      p_sort: query.sort,
      p_limit: PAGE_SIZE,
      p_offset: (query.page - 1) * PAGE_SIZE,
      p_speed_steps: [...SPEED_STEPS],
      p_context_steps: [...CONTEXT_STEPS],
      p_quality_rungs: qualityRungs(),
      p_price_rungs: priceRungs(),
    }),
    isCatalogEmpty(supabase),
  ]);

  // Degrade, do not throw — the same stance as `fetchCatalogPage`, for the same
  // reason: the catalog is the front door and a brief database outage should show
  // the empty state, not a 500. Every field of the error is logged because a
  // TRANSPORT failure arrives as a PostgrestError with an undefined `message`,
  // so `{ message }` alone prints a bare `{}`.
  if (rpcResult.error) {
    console.error("grouped catalog query failed", {
      message: rpcResult.error.message ?? "(none — likely a transport failure)",
      code: rpcResult.error.code,
      details: rpcResult.error.details,
      hint: rpcResult.error.hint,
    });
    return {
      groups: [],
      total: 0,
      page: query.page,
      pageSize: PAGE_SIZE,
      counts: EMPTY_COUNTS,
      catalogIsEmpty,
    };
  }

  const result = rpcResult.data as GroupedResult | null;
  const groups = (result?.groups ?? [])
    .map(mapGroup)
    .filter((group): group is CatalogGroup => group !== null);

  return {
    groups,
    total: result?.total ?? groups.length,
    page: query.page,
    pageSize: PAGE_SIZE,
    counts: mapCounts(result),
    catalogIsEmpty,
  };
}
