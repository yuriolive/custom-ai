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

import { PRICE_BAND_MAX_MICRO, qualityTier, tagsForTier } from "./format";
import { PAGE_SIZE } from "./search-params";
import type { CatalogModel, CatalogPage, CatalogQuery } from "./types";

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
 * Free text → a prefix `tsquery`, safe to interpolate into a PostgREST filter.
 *
 * Prefix matching (`token:*`) rather than plain `to_tsquery`, because this is a
 * search-as-you-type box: "qwen" must match `qwen3.8` on the fourth keystroke,
 * not only once the whole lexeme is typed.
 *
 * The character class is the load-bearing part. Dots and hyphens are KEPT,
 * because `to_tsvector` emits `qwen3.8` and `qwen3.8-27b-uncensored-gguf` as
 * single lexemes — splitting the user's `qwen3.8` into `qwen3` and `8` turns a
 * hit into a miss, since `8:*` prefixes nothing in that vector. Everything else
 * is dropped, which keeps the value legal inside a PostgREST `or=(…)` tree and
 * makes a malformed `to_tsquery` — a 500 on the front page — unreachable.
 */
export function toPrefixTsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, " ")
    .split(" ")
    .map((token) => token.replace(/^[._/-]+/, "").replace(/[._/-]+$/, ""))
    // At least one alphanumeric: `to_tsquery('english', '-:*')` is a syntax error.
    .filter((token) => /[a-z0-9]/.test(token))
    .slice(0, 8);

  return tokens.length > 0 ? tokens.map((token) => `${token}:*`).join("&") : null;
}

/** Handle-shaped fragment for an `ilike`. Strips `%`, `_`, `,` and `*`. */
function handleFragment(text: string): string | null {
  const fragment = text.toLowerCase().replace(/[^a-z0-9-]+/g, "");
  return fragment.length >= 2 ? fragment : null;
}

/**
 * Creator ids whose handle contains the search fragment.
 *
 * FR-MKT-003 requires search to cover the creator handle, but `search_vector`
 * lives on `custom_models` while the handle lives on `profiles` — and PostgREST
 * rejects an embedded column inside a top-level `or=(…)` outright
 * (`PGRST100: failed to parse logic tree`). So the handle match is resolved to
 * ids first and folded into the same `or` as `user_id.in.(…)`, which keeps the
 * whole search one indexed server-side query instead of two merged in JS.
 */
async function creatorIdsMatching(supabase: SupabaseClient, text: string): Promise<string[]> {
  const fragment = handleFragment(text);
  if (!fragment) return [];

  const { data, error } = await supabase
    .from("creator_public")
    .select("id")
    .ilike("handle", `%${fragment}%`)
    .limit(50);

  // A failure here degrades search to "models only" rather than 500-ing the
  // front page: the visitor still gets results, just not handle hits.
  if (error || !data) return [];
  return (data as { id: string }[]).map((row) => row.id);
}

/** `ORDER BY` for each sort (FR-MKT-010). */
function orderColumns(sort: CatalogQuery["sort"]): { column: string; ascending: boolean }[] {
  switch (sort) {
    case "speed":
      return [{ column: "measured_tokens_per_second", ascending: false }];
    case "tokens":
      // "Tokens served" is output tokens — what the GPU actually produced.
      return [{ column: "total_completion_tokens", ascending: false }];
    case "price":
      return [{ column: "price_completion_micro_usd_per_mtoken", ascending: true }];
    case "latency":
      // A model with no measured TTFT yet sorts LAST rather than first: an
      // unmeasured model is not the fastest one.
      return [{ column: "p50_ttft_ms", ascending: true }];
    case "newest":
      return [{ column: "created_at", ascending: false }];
  }
}

/**
 * One page of the catalog, plus the total and the "is the catalog empty at all"
 * flag that separates FR-MKT-011's two states.
 */
export async function fetchCatalogPage(
  supabase: SupabaseClient,
  query: CatalogQuery,
): Promise<CatalogPage> {
  const from = (query.page - 1) * PAGE_SIZE;

  let builder = supabase
    .from("custom_models")
    .select(CATALOG_COLUMNS, { count: "exact" })
    .eq("visibility", "public")
    .eq("status", "ready")
    .is("deleted_at", null);

  if (query.minSpeed != null) {
    builder = builder.gte("measured_tokens_per_second", query.minSpeed);
  }
  if (query.minContext != null) {
    builder = builder.gte("context_length", query.minContext);
  }

  if (query.quality === "full") {
    // The unquantized reference is `variant_quant_tag IS NULL`; an `IN` list
    // cannot express it (see types.ts).
    builder = builder.is("variant_quant_tag", null);
  } else if (query.quality) {
    builder = builder.in("variant_quant_tag", tagsForTier(query.quality));
  }

  if (query.price) {
    // Banded on the COMPLETION price: it is the side of the bill that scales
    // with what the model actually generates.
    const column = "price_completion_micro_usd_per_mtoken";
    if (query.price === "budget") {
      builder = builder.lte(column, PRICE_BAND_MAX_MICRO.budget);
    } else if (query.price === "standard") {
      builder = builder
        .gt(column, PRICE_BAND_MAX_MICRO.budget)
        .lte(column, PRICE_BAND_MAX_MICRO.standard);
    } else {
      builder = builder.gt(column, PRICE_BAND_MAX_MICRO.standard);
    }
  }

  if (query.creator) {
    // Embedded-column filters ARE accepted outside a logic tree, so the creator
    // facet stays one indexed join rather than a handle→id round trip.
    builder = builder.eq("creator_public.handle", query.creator);
  }

  const tsQuery = toPrefixTsQuery(query.q);
  if (tsQuery) {
    const creatorIds = await creatorIdsMatching(supabase, query.q);
    builder =
      creatorIds.length > 0
        ? builder.or(`search_vector.fts(english).${tsQuery},user_id.in.(${creatorIds.join(",")})`)
        : builder.textSearch("search_vector", tsQuery, { config: "english" });
  }

  let ordered = builder;
  for (const spec of orderColumns(query.sort)) {
    ordered = ordered.order(spec.column, {
      ascending: spec.ascending,
      nullsFirst: false,
    });
  }
  // Deterministic tiebreak. Without it, two models with equal speed can swap
  // places between page 1 and page 2, and one of them is never shown at all.
  ordered = ordered.order("id", { ascending: true });

  const [pageResult, catalogIsEmpty] = await Promise.all([
    ordered.range(from, from + PAGE_SIZE - 1),
    isCatalogEmpty(supabase),
  ]);

  // Degrade, do not throw. A catalog read failing is a reason to show the empty
  // state, not to 500 the front door — the homepage is the one page that must
  // survive the database being briefly unreachable. `isCatalogEmpty` already
  // takes this stance (it claims non-empty on error so the copy stays sensible).
  if (pageResult.error) {
    console.error("catalog page query failed", { message: pageResult.error.message });
    return { models: [], total: 0, page: query.page, pageSize: PAGE_SIZE, catalogIsEmpty };
  }

  const models = ((pageResult.data ?? []) as unknown as CatalogRow[])
    .map(toCatalogModel)
    .filter((model): model is CatalogModel => model !== null);

  return {
    models,
    total: pageResult.count ?? models.length,
    page: query.page,
    pageSize: PAGE_SIZE,
    catalogIsEmpty,
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
    .is("deleted_at", null);

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
