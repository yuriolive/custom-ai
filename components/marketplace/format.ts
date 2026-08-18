/**
 * Presentation helpers for the public catalog.
 *
 * Pure and dependency-free, so the same functions run in the Server Component
 * that fetches and in the `"use client"` component that renders. Nothing here
 * touches the database or a secret.
 */

import { formatMicroUsd } from "@/lib/format";

import type { PriceBand, QualityTier } from "./types";

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

export function qualityChipLabel(tier: QualityTier): string {
  return TIER_SHORT[tier];
}

export function qualityNote(tier: QualityTier): string {
  return TIER_NOTE[tier];
}

/** Chip colour for a tier. Only the genuinely degraded tiers get a warning colour. */
export function qualityChipColor(
  tier: QualityTier,
): "default" | "warning" | "success" {
  if (tier === "minimum" || tier === "reduced") return "warning";
  if (tier === "maximum" || tier === "full") return "success";
  return "default";
}

/** Price band boundaries, in micro-USD per 1M completion tokens. */
export const PRICE_BAND_MAX_MICRO: Readonly<
  Record<Exclude<PriceBand, "premium">, number>
> = {
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
