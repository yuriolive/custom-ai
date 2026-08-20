/**
 * The offer table's view logic: which variants exist, and how a reader reorders
 * them.
 *
 * ── Why this sorts in the browser, when rule 1 of `queries.ts` says otherwise ─
 * Rule 1 is "all filtering is server-side", and its reason is stated there: a
 * client that filtered would have to fetch the whole catalog to know what
 * matched, which is both a payload nobody asked for and a count in the UI that
 * would be a lie. Neither applies to one model's offers. The complete offer set
 * IS the page's subject — `model_page` returns all of it in the one round trip
 * that renders the page, and it is bounded by how many people serve one set of
 * weights. Re-sorting it server-side would re-fetch the same rows to put them in
 * a different order, and every count on the page would stay exactly what it was.
 *
 * The line that still holds: this module never DROPS an offer the server sent.
 * `filterOffersByTier` narrows the visible rows to a tier the reader clicked, and
 * `variantTiers` publishes the count of every tier beside its button, so nothing
 * is hidden without a number saying how much.
 *
 * Pure and dependency-free, so `node --test` can load it — which is why the
 * relative imports carry their `.ts` extensions. See the header of `format.ts`.
 */

import { qualityChipLabel, qualityTier } from "./format.ts";
import type { ModelOffer, QualityTier } from "./types.ts";
import { QUALITY_TIERS } from "./types.ts";

/**
 * The axes the offer table sorts on, and they are its columns — every column a
 * buyer would compare down is clickable, and no column is clickable that has
 * nothing to compare.
 *
 * `priceIn` and `priceOut` are separate axes rather than one "price" because the
 * two do not move together: a long-prompt workload is priced by the first column
 * and a generation workload by the second, and a table that sorted on the sum
 * would answer neither question.
 */
export const OFFER_SORT_KEYS = [
  "creator",
  "quality",
  "context",
  "speed",
  "latency",
  "priceIn",
  "priceOut",
] as const;

export type OfferSortKey = (typeof OFFER_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export type OfferSort = { key: OfferSortKey; direction: SortDirection };

/**
 * Where the table starts: cheapest output price first.
 *
 * The same order `model_page` returns, deliberately — the first paint must not
 * reshuffle, and cheapest-first is the ordering a price comparison defaults to.
 */
export const DEFAULT_OFFER_SORT: OfferSort = { key: "priceOut", direction: "asc" };

/**
 * The direction a column means when you first click it.
 *
 * "Best first" in every case, which is not one direction: cheap and quick are
 * ascending, fast and roomy are descending. A table that opened every column
 * ascending would answer "who is slowest" on the first click of the speed
 * column, and the reader would have to click twice to ask the question they
 * meant.
 */
export function defaultDirection(key: OfferSortKey): SortDirection {
  switch (key) {
    case "creator":
    case "latency":
    case "priceIn":
    case "priceOut":
      return "asc";
    case "quality":
    case "context":
    case "speed":
      return "desc";
  }
}

/** Click a column: same column flips, a new column opens at its best-first. */
export function nextOfferSort(current: OfferSort, key: OfferSortKey): OfferSort {
  if (current.key !== key) return { key, direction: defaultDirection(key) };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** Ladder position, so `quality` is an ordering and not an alphabetisation. */
function tierRank(tier: QualityTier): number {
  return QUALITY_TIERS.indexOf(tier);
}

/**
 * The comparable value of one offer on one axis, or null when it is unmeasured.
 *
 * Null is not zero. A listing with no measured throughput has not been shown to
 * be slow, and a table that ranked it 0 tok/s would put it last under `desc` and
 * FIRST under `asc` — i.e. would nominate an unmeasured model as the quickest
 * thing on the page. `compareOffers` sorts nulls last in both directions
 * instead, matching the `nulls last` the catalog RPC applies to the same two
 * columns.
 */
function axisValue(offer: ModelOffer, key: OfferSortKey): number | string | null {
  switch (key) {
    case "creator":
      return offer.creatorHandle;
    case "quality":
      return tierRank(offer.qualityTier);
    case "context":
      return offer.contextLength;
    case "speed":
      return offer.measuredTokensPerSecond;
    case "latency":
      return offer.p50TtftMs;
    case "priceIn":
      return offer.pricePromptMicroPerMtoken;
    case "priceOut":
      return offer.priceCompletionMicroPerMtoken;
  }
}

/**
 * Total order over offers on one axis. Exported for the test, which asserts the
 * null and tiebreak rules directly rather than through a sorted array.
 */
export function compareOffers(a: ModelOffer, b: ModelOffer, sort: OfferSort): number {
  const left = axisValue(a, sort.key);
  const right = axisValue(b, sort.key);

  // Nulls last in BOTH directions — see `axisValue`.
  if (left === null && right === null) return a.listingId.localeCompare(b.listingId);
  if (left === null) return 1;
  if (right === null) return -1;

  let order = 0;
  if (typeof left === "string" && typeof right === "string") {
    order = left.localeCompare(right);
  } else if (typeof left === "number" && typeof right === "number") {
    order = left - right;
  }
  if (sort.direction === "desc") order = -order;

  // Deterministic tiebreak. Without it two offers at one price swap places on
  // every re-render, and a reader comparing two rows watches them move.
  return order !== 0 ? order : a.listingId.localeCompare(b.listingId);
}

/**
 * A NEW array, sorted. `toSorted`, not `sort`: the offers array arrives as a
 * prop, mutating it would reorder the caller's data under React, and `oxlint`'s
 * `no-array-sort` rule is enforced in CI for exactly that reason.
 */
export function sortOffers(offers: readonly ModelOffer[], sort: OfferSort): ModelOffer[] {
  return offers.toSorted((a, b) => compareOffers(a, b, sort));
}

/** One button of the variant selector. */
export type VariantTier = {
  tier: QualityTier;
  /** Short label — the surrounding heading already says "quality". */
  label: string;
  /** How many offers sit on this rung. Rendered beside the label. */
  count: number;
  /** The cheapest completion price available at this quality, in micro-USD. */
  fromCompletionMicro: number;
};

/**
 * The quality rungs this model is actually served at, in ladder order.
 *
 * Sparse on purpose, the same way the catalog's category tabs are: a tier with
 * no offers gets no button rather than a dead zero. Ladder order rather than
 * count order, for the reason the category tabs give — a strip that reorders
 * itself when a filter changes moves the button the reader is reaching for.
 *
 * THE BUTTON IS THE TIER, NEVER THE QUANT TAG. `Q4_K_M` is the detail and
 * `Balanced` is the label (`format.ts` rules on this); a selector built from tags
 * would offer `IQ4_XS` and `Q4_K_M` as two separate choices for what is one
 * decision, and would make a shopper learn the ladder to use the page.
 */
export function variantTiers(offers: readonly ModelOffer[]): VariantTier[] {
  const tiers: VariantTier[] = [];

  for (const tier of QUALITY_TIERS) {
    const onRung = offers.filter((offer) => offer.qualityTier === tier);
    if (onRung.length === 0) continue;
    tiers.push({
      tier,
      label: qualityChipLabel(tier),
      count: onRung.length,
      fromCompletionMicro: Math.min(...onRung.map((o) => o.priceCompletionMicroPerMtoken)),
    });
  }

  return tiers;
}

/** `null` is the `All` button, which is a real choice and not an absent filter. */
export function filterOffersByTier(
  offers: readonly ModelOffer[],
  tier: QualityTier | null,
): ModelOffer[] {
  if (tier === null) return [...offers];
  return offers.filter((offer) => offer.qualityTier === tier);
}

/**
 * How many distinct creators serve this model.
 *
 * Drives the provenance line's overflow count (`served by alice +2`) and the one
 * sentence that says whether the page is a comparison at all. Counted from the
 * offers rather than returned by the RPC, so it cannot disagree with the rows
 * the table renders.
 */
export function offerCreatorCount(offers: readonly ModelOffer[]): number {
  return new Set(offers.map((offer) => offer.creatorHandle)).size;
}

/**
 * The tier of a quant tag, for callers that hold a raw tag rather than an offer.
 *
 * A one-line re-export so this module is the single import the offer table
 * needs, and so `qualityTier` is not reached for directly in a component that
 * would then be free to build a selector out of tags.
 */
export function tierOf(quantTag: string | null): QualityTier {
  return qualityTier(quantTag);
}
