/**
 * Model selection for the chat surface (FR-CHAT-002/003).
 *
 * Pure functions over the same `CatalogModel` the marketplace renders. Reusing
 * that type rather than defining a chat-shaped one is a security decision, not
 * a convenience: its projection is an allow-list that deliberately carries no
 * `upstream_endpoint_ref`, no `gpu_tier_id` and no solver internals, and it has
 * already been reviewed as safe to hand to a `"use client"` component. A second
 * type here would be a second thing to keep safe.
 */

import type { CatalogModel } from "@/components/marketplace/types";

/**
 * Normalize a model id from a URL to the exact string the gateway resolves.
 *
 * `resolve.ts` lowercases both halves, so case is forgiving and names are not
 * (CONTRACTS.md). Anything without exactly one `/`, or with an empty half, is
 * rejected here rather than sent on to earn a 400 — the caller turns `null`
 * into "we ignored your ?model and picked one for you", which is a better
 * outcome than an error page for a mistyped share link.
 */
export function normalizeModelId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 130) return null;

  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;

  const [creator, slug] = parts;
  if (!creator || !slug) return null;

  return `${creator.toLowerCase()}/${slug.toLowerCase()}`;
}

/**
 * The default model when the URL asks for nothing.
 *
 * Most-requested wins. That is not a popularity contest dressed as a
 * recommendation — it is the closest thing to a warmth signal this schema
 * exposes today. Every model here scales to zero, so the one with the most
 * traffic is the one most likely to have a worker already up, and a first-time
 * visitor's first message is exactly where a 90-second cold start does the most
 * damage (FR-CHAT-006).
 *
 * `NEXT_PUBLIC_DEFAULT_MODEL` is deliberately NOT consulted: it names a model
 * that need not be in the public catalog at all, and chat cannot render a price
 * or a speed for a row it cannot read.
 */
export function defaultModel(models: CatalogModel[]): CatalogModel | null {
  if (models.length === 0) return null;

  return models.reduce((best, candidate) => {
    if (candidate.totalRequests !== best.totalRequests) {
      return candidate.totalRequests > best.totalRequests ? candidate : best;
    }
    // Deterministic tie-break, so the default does not flip between renders on
    // a catalog where nothing has been called yet.
    return candidate.modelId < best.modelId ? candidate : best;
  });
}

export type InitialModelChoice = {
  model: CatalogModel | null;
  /**
   * Set when the URL asked for a model that is not on the public catalog. The
   * page renders this as a notice and carries on with the default — never a
   * 404, because the usual cause is a shared link to a model whose creator has
   * since unpublished it.
   */
  unavailableModelId: string | null;
};

export function pickInitialModel(
  models: CatalogModel[],
  requested: string | null | undefined,
): InitialModelChoice {
  const normalized = normalizeModelId(requested);

  if (normalized) {
    const match = models.find((model) => model.modelId === normalized);
    if (match) return { model: match, unavailableModelId: null };
    return { model: defaultModel(models), unavailableModelId: normalized };
  }

  return { model: defaultModel(models), unavailableModelId: null };
}

/**
 * What a turn costs, as a single number a person can actually compare.
 *
 * Prices are micro-USD per 1,000,000 tokens, integers (CONTRACTS.md §Money).
 * A "typical exchange" is priced at 500 prompt + 500 completion tokens: it is
 * arbitrary, it is stated where it is shown, and it beats two per-million
 * figures that nobody converts in their head. CEIL in both halves, matching the
 * billing direction — never quote a price lower than what would be charged.
 */
export function typicalExchangeMicroUsd(model: CatalogModel, tokensEachWay = 500): number {
  const prompt = Math.ceil((tokensEachWay * model.pricePromptMicroPerMtoken) / 1_000_000);
  const completion = Math.ceil((tokensEachWay * model.priceCompletionMicroPerMtoken) / 1_000_000);
  return Math.max(1, prompt + completion);
}

/**
 * How many exchanges to quote a price for.
 *
 * One exchange on a cheap model is a few hundred micro-USD, which renders as
 * `$0.000400` — six decimal places of noise that tells a reader nothing except
 * that the number is small. A hundred of them lands in cents, where the figure
 * is both readable and the one people actually want: what does using this for
 * an afternoon cost.
 */
export const QUOTED_EXCHANGES = 100;

export function quotedExchangesMicroUsd(model: CatalogModel): number {
  return typicalExchangeMicroUsd(model) * QUOTED_EXCHANGES;
}
