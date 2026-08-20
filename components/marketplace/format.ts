/**
 * Presentation helpers for the public catalog.
 *
 * Pure and dependency-free, so the same functions run in the Server Component
 * that fetches and in the `"use client"` component that renders. Nothing here
 * touches the database or a secret.
 *
 * THE IMPORTS BELOW ARE RELATIVE AND CARRY THEIR `.ts` EXTENSIONS, unlike the
 * `@/…` specifiers used elsewhere in `components/`. That is what makes this
 * module loadable by `node --test`, which resolves neither the `@/` path alias
 * (a tsconfig fiction the bundler implements) nor an extensionless specifier.
 * `lib/seo/json-ld.ts` spells its imports the same way and for the same reason;
 * `format.test.ts` next door is the thing that would otherwise be unwritable.
 */

import { formatMicroUsd } from "../../lib/format.ts";

import type { ModelCategory, PriceBand, QualityTier } from "./types.ts";
import { QUALITY_TIERS } from "./types.ts";

/**
 * Quantization tag → quality tier, from the ladder in PRD §4.3.3.3.
 *
 * The tag is disclosure-only; the tier is what a shopper actually reads. A tag
 * we do not recognise is deliberately reported as `balanced` rather than
 * guessed upward — over-promising quality on an unknown quant is the worse
 * failure of the two.
 */
const TIER_BY_TAG: Readonly<Record<string, QualityTier>> = {
  IQ2_M: "minimum",
  Q2_K: "minimum",
  IQ3_XS: "reduced",
  IQ3_M: "reduced",
  Q3_K_S: "reduced",
  Q3_K_M: "reduced",
  Q3_K_L: "reduced",
  IQ4_XS: "balanced",
  IQ4_NL: "balanced",
  Q4_K_S: "balanced",
  Q4_K_M: "balanced",
  Q4_0: "balanced",
  AWQ: "balanced",
  GPTQ: "balanced",
  Q5_K_S: "high",
  Q5_K_M: "high",
  Q5_0: "high",
  Q6_K: "maximum",
  Q8_0: "maximum",
  F16: "full",
  BF16: "full",
  FP16: "full",
};

/** All tags that map to a tier. Used to build the server-side `IN` filter. */
export function tagsForTier(tier: QualityTier): string[] {
  return Object.keys(TIER_BY_TAG).filter((tag) => TIER_BY_TAG[tag] === tier);
}

export function qualityTier(tag: string | null | undefined): QualityTier {
  if (!tag) return "full"; // NULL tag = native weights, no quantization applied.
  return TIER_BY_TAG[tag.toUpperCase()] ?? "balanced";
}

const TIER_LABEL: Readonly<Record<QualityTier, string>> = {
  minimum: "Minimum quality",
  reduced: "Reduced quality",
  balanced: "Balanced quality",
  high: "High quality",
  maximum: "Very high quality",
  full: "Full precision",
};

/** Short form for a Chip, where the surrounding context already says "quality". */
const TIER_SHORT: Readonly<Record<QualityTier, string>> = {
  minimum: "Minimum",
  reduced: "Reduced",
  balanced: "Balanced",
  high: "High",
  maximum: "Very high",
  full: "Full precision",
};

/**
 * The honest note attached to each tier. Quantization trades accuracy for cost,
 * and a marketplace that hides which side of that trade a model sits on is
 * selling degradation as a feature.
 */
const TIER_NOTE: Readonly<Record<QualityTier, string>> = {
  minimum: "2-bit weights. Severe degradation — offered, never recommended.",
  reduced: "3-bit weights. Noticeable quality loss on reasoning tasks.",
  balanced: "4-bit weights. The community default: best quality per byte.",
  high: "5-bit weights. Near-lossless for most tasks.",
  maximum: "6- to 8-bit weights. Effectively indistinguishable from FP16.",
  full: "Unquantized reference weights. No accuracy trade at all.",
};

export function qualityLabel(tier: QualityTier): string {
  return TIER_LABEL[tier];
}

/**
 * The tier chip's text — and the only thing that carries the tier.
 *
 * There is deliberately no `qualityChipColor` companion. One used to exist and
 * returned `success` for the top tiers, which put a green chip directly beside
 * the accent-green throughput chip on every high-quality card: two greens a few
 * degrees apart in one row, neither of which the eye can assign a meaning to.
 * The tier reads from this label and, in full, from `qualityNote` in the
 * tooltip. Do not reintroduce a status colour to carry it.
 */
export function qualityChipLabel(tier: QualityTier): string {
  return TIER_SHORT[tier];
}

export function qualityNote(tier: QualityTier): string {
  return TIER_NOTE[tier];
}

/** Price band boundaries, in micro-USD per 1M completion tokens. */
export const PRICE_BAND_MAX_MICRO: Readonly<Record<Exclude<PriceBand, "premium">, number>> = {
  budget: 500_000, // <= $0.50 / 1M out
  standard: 2_000_000, // <= $2.00 / 1M out
};

export function priceBandLabel(band: PriceBand): string {
  switch (band) {
    case "budget":
      return "Under $0.50 / 1M out";
    case "standard":
      return "$0.50 – $2.00 / 1M out";
    case "premium":
      return "Over $2.00 / 1M out";
  }
}

/**
 * Context window as a developer says it out loud: 8k, 128k, 1M.
 *
 * Uses 1000, not 1024. "128k context" universally means 131072 in model specs,
 * but the number people compare against is the decimal one, and rounding to it
 * is what makes two models comparable at a glance.
 */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Measured throughput. Null renders as an em dash, never as "0 tok/s". */
export function formatSpeed(tokensPerSecond: number | null): string {
  if (tokensPerSecond == null) return "—";
  return `${Math.round(tokensPerSecond)} tok/s`;
}

/**
 * Price per 1M tokens. The stored value is already micro-USD per 1M tokens, so
 * this is a straight micro-USD render — integer maths only (CONTRACTS.md §Money).
 */
export function formatPricePerMtoken(micro: number): string {
  return formatMicroUsd(micro);
}

/** Compact counts for "tokens served": 1.2M, 934k, 812. */
export function formatCompact(value: number): string {
  if (value >= 1_000_000_000) {
    return `${Math.round(value / 100_000_000) / 10}B`;
  }
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString("en-US");
}

/** Latency in the units a developer reads: ms below a second, seconds above. */
export function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

/**
 * Measured throughput as a bare figure, for the card's headline pair where the
 * unit is carried by a separate `TOK/S` label. Null renders as an em dash,
 * never as "0".
 *
 * This is `measuredTokensPerSecond` and nothing else (FR-DEP-052/FR-MKT-002) —
 * there is no predicted figure in `CatalogModel` and there must never be one.
 */
export function formatSpeedValue(tokensPerSecond: number | null): string {
  if (tokensPerSecond == null) return "—";
  return String(Math.round(tokensPerSecond));
}

/**
 * The rungs the Speed facet offers, and the rungs whose counts the RPC returns.
 *
 * They live here rather than in `catalog-controls.tsx` because two places need
 * the same list: the rail that renders the rungs, and `queries.ts`, which sends
 * them to `catalog_grouped` so the counts come back keyed by the same values.
 * Two copies would drift into a rail with a rung that has no count and a count
 * for a rung nobody can click.
 */
export const SPEED_STEPS = [20, 40, 60, 90, 120] as const;

/** The rungs the Context facet offers. Same reasoning as `SPEED_STEPS`. */
export const CONTEXT_STEPS = [8_192, 32_768, 128_000, 200_000, 1_000_000] as const;

/** One rung of the quality ladder, as `catalog_grouped` consumes it. */
export type QualityRung = {
  key: QualityTier;
  tags: string[];
  /** True when the rung also matches a NULL tag. Only `full` does. */
  native?: boolean;
};

/**
 * The whole quality ladder, in the shape `catalog_grouped(p_quality_rungs)`
 * expects.
 *
 * THE LADDER IS DEFINED ONCE, HERE. The RPC takes it as a parameter rather than
 * restating `TIER_BY_TAG` in SQL, because a second copy of these constants is
 * the exact failure CLAUDE.md documents for the two GPU tier catalogs: a change
 * landing in one silently makes the two disagree, and the symptom is a facet
 * whose count and whose rows come from different definitions of `balanced`.
 *
 * `native` on `full` is a widening, and a deliberate one. The old direct query
 * filtered `full` as `variant_quant_tag IS NULL` only, so a listing explicitly
 * tagged `F16` — native precision, spelled out — failed the "full precision"
 * filter. Both now match: NULL means the tag was never recorded, `F16` means it
 * was, and they describe the same weights.
 */
export function qualityRungs(): QualityRung[] {
  return QUALITY_TIERS.map((tier) => ({
    key: tier,
    tags: tagsForTier(tier),
    native: tier === "full" ? true : undefined,
  }));
}

/** One price band, as `catalog_grouped(p_price_rungs)` expects it. */
export type PriceRung = {
  key: PriceBand;
  /** EXCLUSIVE lower bound in micro-USD per 1M completion tokens. */
  min?: number;
  /** INCLUSIVE upper bound. */
  max?: number;
};

/**
 * The three price bands, boundaries and all, in the RPC's shape.
 *
 * The bounds are half-open the same way `fetchCatalogPage` has always banded
 * them — `> min` and `<= max` — so a model sitting exactly on $0.50 is budget in
 * both the count and the rows. Flipping either side would put it in two bands or
 * in none, and the visible symptom is a band count that does not add up to the
 * total.
 */
export function priceRungs(): PriceRung[] {
  return [
    { key: "budget", max: PRICE_BAND_MAX_MICRO.budget },
    { key: "standard", min: PRICE_BAND_MAX_MICRO.budget, max: PRICE_BAND_MAX_MICRO.standard },
    { key: "premium", min: PRICE_BAND_MAX_MICRO.standard },
  ];
}

/** Category labels for the tabs. Short — the tab strip has to fit at 375px. */
const CATEGORY_LABEL: Readonly<Record<ModelCategory, string>> = {
  code: "Code",
  reasoning: "Reasoning",
  chat: "Chat",
  "tool-use": "Tools",
  vision: "Vision",
  "long-context": "Long context",
  multilingual: "Multilingual",
  math: "Math",
  roleplay: "Roleplay",
  uncensored: "Uncensored",
  summarization: "Summarization",
  embeddings: "Embeddings",
};

export function categoryLabel(category: ModelCategory): string {
  return CATEGORY_LABEL[category];
}

/**
 * Who published the WEIGHTS, from `base_models.slug`.
 *
 * The slug is `publisher/name`, and the first segment is the upstream publisher —
 * an unrelated namespace to the platform creator handle in the second half of a
 * model id. Returning it separately is what lets the card say
 * "weights by qwen · served by alice": without that line, a creator who did
 * nothing but run a deploy reads as the author of the model.
 *
 * Null when nothing has been resolved yet. There is no honest fallback: the
 * platform genuinely does not know who published the weights until #25's
 * cascade runs, and guessing from the creator's handle would print the very
 * claim this line exists to stop.
 */
export function weightsPublisher(baseSlug: string | null): string | null {
  if (!baseSlug) return null;
  const publisher = baseSlug.split("/")[0]?.trim();
  return publisher ? publisher : null;
}

/** `1 listing` / `3 listings`. */
export function formatListingCount(count: number): string {
  return count === 1 ? "1 listing" : `${count} listings`;
}

/**
 * "served by alice", or "served by alice +2" when the group spans creators.
 *
 * The named handle is the one the card QUOTES, so it matches the model id below
 * it. The overflow count is deliberately a count and not a list: the other
 * creators' listings are not the ones this card is pricing, and naming them
 * would imply the figures above apply to all of them.
 */
export function formatServedBy(creatorHandle: string, creatorCount: number): string {
  return creatorCount > 1 ? `${creatorHandle} +${creatorCount - 1}` : creatorHandle;
}
