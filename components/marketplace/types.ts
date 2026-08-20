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
export const QUALITY_TIERS = ["minimum", "reduced", "balanced", "high", "maximum", "full"] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Price bands, evaluated against the COMPLETION price — the one that dominates a bill. */
export const PRICE_BANDS = ["budget", "standard", "premium"] as const;
export type PriceBand = (typeof PRICE_BANDS)[number];

/**
 * The `use_cases` vocabulary from `base_models` (migration 20260820000100),
 * which is a CLOSED set enforced by a CHECK constraint — an open vocabulary
 * would split one facet three ways the first time someone typed "coding".
 *
 * The ORDER is the tab order, and it is fixed rather than sorted by count. A
 * count-sorted tab strip reorders itself every time a filter changes, so the tab
 * a visitor is reaching for moves under the cursor; a fixed order costs one
 * scan and never does that. It runs roughly most- to least-shopped-for.
 *
 * Must stay a subset of the constraint's list, or a tab silently returns zero
 * rows for a category no row can ever hold.
 */
export const MODEL_CATEGORIES = [
  "code",
  "reasoning",
  "chat",
  "tool-use",
  "vision",
  "long-context",
  "multilingual",
  "math",
  "roleplay",
  "uncensored",
  "summarization",
  "embeddings",
] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

/** FR-MKT-010. */
export const CATALOG_SORTS = ["newest", "speed", "tokens", "price", "latency"] as const;
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
  /**
   * The selected category tab, or null for `All`.
   *
   * Not part of the facet rail: it reads on the group's `use_cases`, which is a
   * property of the MODEL, while every rail facet reads on a listing. Filtering
   * a group by a listing-shaped facet narrows what the card quotes; filtering by
   * category removes the card.
   */
  category: ModelCategory | null;
  sort: CatalogSort;
  /** 1-based. */
  page: number;
};

/**
 * ONE CATALOG CARD: a model, aggregated over its ready, public, unsuspended
 * listings (#26).
 *
 * The card used to be a `CatalogModel`, i.e. a DEPLOYMENT, and that was the
 * defect: six quantizations of one model drew six unrelated cards, and the
 * quality facet deleted cards instead of picking a variant inside one.
 *
 * The fields split into three groups and mixing them up is the whole risk here:
 *
 *  1. **The model.** `displayName`, `description`, `categories`, `baseSlug` —
 *     from `base_models`, or from the single listing when nothing has been
 *     resolved yet (`baseModelId === null`).
 *  2. **Best cases over the matching listings.** `best*`, and they are
 *     labelled as best cases everywhere they are rendered. An unlabelled max
 *     reads as a promise the median listing does not keep.
 *  3. **The QUOTED listing** — `modelId`, `slug`, `creatorHandle`, the two
 *     prices, `qualityTier`. This is one real listing: the cheapest one that
 *     matches the active filters. It is what the card links to and what the copy
 *     button puts on the clipboard, so the `from` price is a price the visitor
 *     can actually pay on the page the card opens.
 *
 * NO HARDWARE IS REPRESENTABLE HERE, exactly as in `CatalogModel`: no
 * `gpu_tier_id`, no predicted throughput, no GPU name, not as a field and not as
 * a label (FR-MKT-002).
 */
export type CatalogGroup = {
  /** Stable identity for a React key. A base model id, or `listing:<uuid>`. */
  groupKey: string;
  /** Null until #25's resolution cascade attaches a base model. */
  baseModelId: string | null;
  /**
   * `publisher/name` on `base_models`. NOT a platform model id and NOT a Hugging
   * Face repo path — see `weightsPublisher` in format.ts for the one thing it is
   * used for.
   */
  baseSlug: string | null;
  displayName: string;
  description: string | null;
  family: string | null;
  parameterCount: number | null;
  categories: ModelCategory[];

  /** How many listings this card speaks for, after filtering. */
  listingCount: number;
  /** How many distinct creators serve them. Drives the provenance line. */
  creatorCount: number;
  bestTokensPerSecond: number | null;
  bestContextLength: number;
  /** Verified flag OF THE LISTING that reaches `bestContextLength`. */
  bestContextVerified: boolean;
  totalRequests: number;
  totalCompletionTokens: number;

  /** The quoted listing's row id. */
  listingId: string;
  creatorHandle: string;
  creatorDisplayName: string | null;
  slug: string;
  /**
   * The id a caller passes as `model`, built from the QUOTED LISTING —
   * `creator-handle/model-slug`, lowercase.
   *
   * NOT `baseSlug`. `baseSlug` looks like an id (`qwen/qwen3-8b`) and resolves
   * to nothing: it is a weights publisher and a model name, not a platform
   * handle and a listing slug (CONTRACTS.md, top). Copying it would be a 404.
   */
  modelId: string;
  quantTag: string | null;
  qualityTier: QualityTier;
  /** micro-USD per 1M tokens, from the quoted listing. Integers (CONTRACTS.md §Money). */
  fromPricePromptMicroPerMtoken: number;
  fromPriceCompletionMicroPerMtoken: number;
  p50TtftMs: number | null;
  createdAt: string;
  readyAt: string | null;
};

/**
 * The counts the tabs and the rail render, all from the same filtered set as the
 * rows — which is the only way a tab that says `Code 11` can be trusted above a
 * grid of 11.
 *
 * Every count is a GROUP count, and every one is computed with its own dimension
 * excluded: the number beside `120+ tok/s` answers "how many models would I
 * still have if I asked for this too". A rail whose counts include its own
 * active filter reports the thing you already chose and zero for everything
 * else, and goes dead after one click.
 */
export type CatalogCounts = {
  /** The `All` tab: groups matching every facet except the category. */
  all: number;
  /** Sparse on purpose — a category with no rows has no tab, not a zero tab. */
  categories: Partial<Record<ModelCategory, number>>;
  /** Keyed by the rung value as a string, e.g. `"90"`. */
  speed: Record<string, number>;
  context: Record<string, number>;
  quality: Partial<Record<QualityTier, number>>;
  price: Partial<Record<PriceBand, number>>;
  /** Keyed by creator handle. The rail offers the handles actually in the catalog. */
  creator: Record<string, number>;
};

export type CatalogGroupPage = {
  groups: CatalogGroup[];
  /** Total GROUPS matching the filters, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  counts: CatalogCounts;
  /**
   * True when the catalog holds no public+ready listing at all, regardless of
   * filters — the difference between "nothing here yet" and "nothing matched",
   * which need different next steps (FR-MKT-011).
   */
  catalogIsEmpty: boolean;
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE MODEL PAGE (#27)
 *
 * `CatalogGroup` above is a model as a CARD — one quoted listing and a handful
 * of labelled best cases. This is the same model as a PAGE: every visible
 * listing of it, side by side, on the axes a buyer compares. That is the point
 * of the page and the reason the shapes below carry a list where the card
 * carries a maximum.
 *
 * NO HARDWARE IS REPRESENTABLE HERE, for the third time in this file and for
 * the same reason (FR-MKT-002): these values cross into the RSC payload, and a
 * field is the first step to a label.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Whether a THIRD PARTY may serve these weights for money (`base_models`,
 * migration 20260820000100). Not derivable from the SPDX id alone: Llama's
 * community licence permits commercial hosting WITH obligations, CC-BY-NC
 * forbids it outright, and `other` says nothing at all.
 *
 * `conditional` is the value this page owes content for. `unknown` is the value
 * that must never auto-publish — but the gate that decides that is #29's, on the
 * write path; here all four are read and reported.
 */
export const COMMERCIAL_HOSTING = ["allowed", "conditional", "prohibited", "unknown"] as const;
export type CommercialHosting = (typeof COMMERCIAL_HOSTING)[number];

/**
 * ONE OFFER: a single listing of the model, as a row of the comparison table.
 *
 * Every field is an axis a buyer sorts on, plus the two things that make the row
 * actionable: `creatorHandle` (who is selling) and `modelId` (what to paste).
 *
 * `quantTag` IS DISCLOSURE ONLY. The tier is the label and the tag is the
 * detail — `format.ts` rules on this and the table follows it: the Quality
 * column reads the tier, and the tag sits beside it as the specific build.
 */
export type ModelOffer = {
  /** The listing's row id. A React key, and the anchor comparison. */
  listingId: string;
  creatorHandle: string;
  creatorDisplayName: string | null;
  slug: string;
  /**
   * The id a caller passes as `model` — `creator-handle/model-slug`, lowercase,
   * built from THIS LISTING.
   *
   * NEVER the base model's slug. `qwen/qwen3-8b` looks exactly like a platform
   * id and resolves to nothing, because its first half is a weights publisher
   * rather than a creator handle (CONTRACTS.md, top). Every offer row's copy
   * button puts this string on the clipboard and nothing else.
   */
  modelId: string;
  /** The LISTING's own name, e.g. "Qwen3.8 27B Uncensored (Q6_K)". */
  displayName: string;
  quantTag: string | null;
  qualityTier: QualityTier;
  contextLength: number;
  contextVerified: boolean;
  /** MEASURED throughput (FR-DEP-052), never the solver's prediction. */
  measuredTokensPerSecond: number | null;
  p50TtftMs: number | null;
  /** micro-USD per 1M tokens. Integers, per CONTRACTS.md §Money. */
  pricePromptMicroPerMtoken: number;
  priceCompletionMicroPerMtoken: number;
  totalRequests: number;
  totalCompletionTokens: number;
  createdAt: string;
  readyAt: string | null;
};

/**
 * THE MODEL the offers serve — `base_models`, not a listing.
 *
 * Null on the page when the anchor listing has no `base_model_id`, which is the
 * normal state until #25's resolution cascade runs. That null is a distinct
 * sentence from "this model is an original", and `lineage.ts` keeps them apart.
 */
export type BaseModelInfo = {
  id: string;
  /**
   * `publisher/name`. NOT a platform model id and NOT a Hugging Face repo path —
   * the page renders it as provenance and never offers it for copying.
   */
  slug: string;
  displayName: string;
  summary: string | null;
  family: string | null;
  parameterCount: number | null;
  categories: ModelCategory[];
  /** The model these weights were trained FROM, or null on an original (§1.2). */
  parentId: string | null;
  licenseId: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  /**
   * The revision of the licence TEXT in force. A version rather than a boolean
   * because the Llama community licence has been revised, and acknowledging the
   * old text is not acknowledging the new one.
   */
  licenseVersion: string | null;
  commercialHosting: CommercialHosting;
};

/**
 * The model this one was trained from (§1.2), for the lineage link.
 *
 * `listingCount` is how many visible listings serve the PARENT itself, and it is
 * honesty rather than decoration: at zero the lineage line must be text, not a
 * link, because the only place a link could go is a catalog search that returns
 * nothing. A parent legitimately has no listings of its own — `Qwen3-8B` may be
 * served here only through fine-tunes — and still owes the attribution.
 */
export type ParentModelInfo = {
  id: string;
  slug: string;
  displayName: string;
  family: string | null;
  parameterCount: number | null;
  listingCount: number;
};

/** Everything the model page renders, from one `model_page` round trip. */
export type ModelPage = {
  /**
   * The listing whose URL this is. The snippet, the price table and the measured
   * figures on the page are ITS, and the offer table marks its row — a table
   * whose highlighted row is absent is one the reader cannot place themselves in.
   */
  listing: CatalogModel;
  /** Null until #25's cascade attaches a base model. */
  model: BaseModelInfo | null;
  parent: ParentModelInfo | null;
  /** Every visible listing of the same model, cheapest completion price first. */
  offers: ModelOffer[];
  /**
   * Every offer that EXISTS, which differs from `offers.length` only above the
   * RPC's cap. The page says so when they differ: a silent truncation on a price
   * comparison reads as "these are all the offers".
   */
  offerTotal: number;
};
