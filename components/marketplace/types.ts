/**
 * Plain, serializable shapes that cross the Server Component → Client Component
 * boundary for the public catalog.
 *
 * These are deliberately NOT the database row. Two reasons:
 *
 *  1. `@heroui/react` is client-only (PRD §4.1.0), so every marketplace surface
 *     sits behind `"use client"`. Anything handed across that boundary is
 *     serialized into the RSC payload and therefore shipped to the browser.
 *     A row-shaped prop would publish `upstream_endpoint_ref`,
 *     `placement_rationale` and friends to the anonymous internet.
 *  2. NO HARDWARE IS REPRESENTABLE HERE (FR-MKT-002/004). There is no
 *     `gpu_tier_id`, no `predicted_tokens_per_second`, no GPU name — not as a
 *     field, not as a label. A developer shops on capability: how fast, how
 *     much context, what quality, what price. Which silicon delivers that is
 *     the platform's problem, and adding a field for it here is the first step
 *     to leaking it into the UI.
 */

/**
 * Quality ladder (PRD §4.3.3.3). Ordered worst → best. `full` is the
 * unquantized reference (`variant_quant_tag IS NULL`), which is why it is a
 * tier of its own rather than the top of `maximum`: filtering it needs an
 * `IS NULL` predicate, not an `IN` list.
 */
export const QUALITY_TIERS = [
  "minimum",
  "reduced",
  "balanced",
  "high",
  "maximum",
  "full",
] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Price bands, evaluated against the COMPLETION price — the one that dominates a bill. */
export const PRICE_BANDS = ["budget", "standard", "premium"] as const;
export type PriceBand = (typeof PRICE_BANDS)[number];

/** FR-MKT-010. */
export const CATALOG_SORTS = [
  "newest",
  "speed",
  "tokens",
  "price",
  "latency",
] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** One catalog entry. Every field is safe to render to an anonymous visitor. */
export type CatalogModel = {
  id: string;
  /** Platform creator handle. Lowercase by schema CHECK. */
  creatorHandle: string;
  creatorDisplayName: string | null;
  /** Model slug. Lowercase by schema CHECK; may contain dots. */
  slug: string;
  /**
   * The id a caller passes as `model`. `creator-handle/model-slug`, lowercase.
   *
   * THIS IS NOT THE HUGGING FACE REPO PATH (CONTRACTS.md). `hf_repo_slug` is
   * `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF`; the platform id is
   * `jonathancoletti/qwen3.8-27b-uncensored-gguf`. Passing the former is a 404,
   * and it is the single most likely reason a copied snippet fails.
   */
  modelId: string;
  displayName: string;
  description: string | null;
  /**
   * MEASURED throughput from the post-provision smoke test (FR-DEP-052), never
   * the solver's prediction (FR-MKT-002). Null only if a row somehow reached
   * `ready` without one, which the schema's
   * `custom_models_ready_needs_placement` CHECK forbids.
   */
  measuredTokensPerSecond: number | null;
  contextLength: number;
  contextVerified: boolean;
  /** Raw quantization tag — disclosure only. The tier is what a shopper reads. */
  quantTag: string | null;
  qualityTier: QualityTier;
  /** micro-USD per 1,000,000 tokens. Integers, per CONTRACTS.md §Money. */
  pricePromptMicroPerMtoken: number;
  priceCompletionMicroPerMtoken: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  createdAt: string;
  readyAt: string | null;
  /**
   * True when the Hugging Face account behind this creator owns the upstream
   * repository the listing serves — its `hf_repo_slug` owner, or the publisher
   * of the base model it is grouped to (FR/#30). Decided in SQL by
   * `public.listing_is_official`; this is the projection of that boolean.
   *
   * `false` IS THE NEUTRAL STATE, not a demerit. Third-party hosting is the
   * normal case in a working marketplace, and the UI renders the two as peers.
   *
   * It says nothing about the weights. Hugging Face OAuth proves control of an
   * ACCOUNT — an org member can publish a repo they did not train — so this must
   * never reach a price, a sort key or a payout. #29 owns the gate that governs
   * earning, and it reads different columns on purpose.
   */
  isOfficial: boolean;
};

/** Normalized catalog query, parsed from URL search params. */
export type CatalogQuery = {
  /** Free-text search. Empty string means "no search". */
  q: string;
  /** Minimum measured tokens/sec, or null. */
  minSpeed: number | null;
  /** Minimum context window in tokens, or null. */
  minContext: number | null;
  quality: QualityTier | null;
  price: PriceBand | null;
  creator: string | null;
  sort: CatalogSort;
  /** 1-based. */
  page: number;
};

export type CatalogPage = {
  models: CatalogModel[];
  /** Total rows matching the filters, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  /**
   * True when the catalog holds no public+ready models at all, regardless of
   * filters — the difference between "nothing here yet" and "nothing matched",
   * which need different next steps (FR-MKT-011).
   */
  catalogIsEmpty: boolean;
};
