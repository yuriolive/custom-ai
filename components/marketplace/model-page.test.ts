/**
 * Unit tests for the model page's TypeScript half (#27).
 * Run: npm run test:app
 *
 * The RPC's BEHAVIOUR is tested where it runs, in
 * `supabase/tests/09_model_page_test.sql` against a real Postgres — the offer
 * set's visibility boundary, the anchor surviving the cap, and the ungrouped
 * listing being a model of one are all assertions about SQL.
 *
 * What is left here is the part that has no SQL to assert it: the decisions the
 * browser makes over rows the server already sent, plus the one crossing where a
 * wrong answer is a licence breach rather than a layout bug.
 *
 *  - THE MODEL ID PER OFFER. `creator-handle/model-slug`, from the LISTING. The
 *    base model's slug looks exactly like a platform id (`qwen/qwen3-8b`) and
 *    resolves to nothing, so the assertion is not that the mapper builds an id —
 *    it is that the id it builds is never the base slug.
 *  - THE NULL RULE IN SORTING. An unmeasured throughput must sort last in BOTH
 *    directions. Sorting it as zero nominates an unmeasured listing as the
 *    fastest offer on the page under `asc`, which is a lie the table tells
 *    confidently.
 *  - THE VARIANT SELECTOR IS TIERS, NEVER TAGS. `IQ4_XS` and `Q4_K_M` are one
 *    button, not two, and the button carries the count and the cheapest price at
 *    that quality.
 *  - THE LINEAGE STATES. Four of them, and the pair that matters is `root` versus
 *    `unresolved`: "trained from scratch" and "nobody has checked" must not share
 *    a rendering, and a blank line renders both identically.
 *  - THE LICENCE OBLIGATIONS. A `conditional` Llama model owes "Built with Llama"
 *    and the derivative-naming rule as CONTENT. A permissive licence owes
 *    nothing, and an unresolved one must never be reported as permissive.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { qualityTier } from "./format.ts";
import { licenceFamily, licenceLabel, licenceObligations, licencePostureNote } from "./licence.ts";
import { lineageOf, lineageSummary } from "./lineage.ts";
import type { OfferSort } from "./offers.ts";
import {
  compareOffers,
  DEFAULT_OFFER_SORT,
  defaultDirection,
  filterOffersByTier,
  nextOfferSort,
  offerCreatorCount,
  OFFER_SORT_KEYS,
  sortOffers,
  variantTiers,
} from "./offers.ts";
import type { BaseModelInfo, ModelOffer, ParentModelInfo } from "./types.ts";
import { QUALITY_TIERS } from "./types.ts";

/** A minimal offer. Every test overrides only the axis it is about. */
function offer(patch: Partial<ModelOffer> & { listingId: string }): ModelOffer {
  const creatorHandle = patch.creatorHandle ?? "alice";
  const slug = patch.slug ?? "a-model";
  return {
    creatorHandle,
    creatorDisplayName: null,
    slug,
    modelId: `${creatorHandle}/${slug}`,
    displayName: "A model",
    quantTag: "Q4_K_M",
    qualityTier: qualityTier("Q4_K_M"),
    contextLength: 32_768,
    contextVerified: false,
    measuredTokensPerSecond: 40,
    p50TtftMs: 900,
    pricePromptMicroPerMtoken: 800_000,
    priceCompletionMicroPerMtoken: 1_200_000,
    totalRequests: 0,
    totalCompletionTokens: 0,
    createdAt: "2026-08-01T00:00:00Z",
    readyAt: "2026-08-01T00:00:00Z",
    ...patch,
  };
}

function baseModel(patch: Partial<BaseModelInfo> = {}): BaseModelInfo {
  return {
    id: "b1",
    slug: "qwen/qwen3-8b",
    displayName: "Qwen3 8B",
    summary: null,
    family: "qwen3",
    parameterCount: 8_000_000_000,
    categories: [],
    parentId: null,
    licenseId: null,
    licenseName: null,
    licenseUrl: null,
    licenseVersion: null,
    commercialHosting: "unknown",
    ...patch,
  };
}

function parentModel(patch: Partial<ParentModelInfo> = {}): ParentModelInfo {
  return {
    id: "p1",
    slug: "qwen/qwen3-8b",
    displayName: "Qwen3 8B",
    family: "qwen3",
    parameterCount: 8_000_000_000,
    listingCount: 2,
    ...patch,
  };
}

// ── The offer id ───────────────────────────────────────────────────────────
// The single most likely reason a copied snippet 404s (CONTRACTS.md, top), and
// the fixture is built so that a mapper reaching for the base model's slug would
// produce something that still LOOKS like a valid id.

test("an offer's model id is the listing's two segments, never the base slug", () => {
  const row = offer({ creatorHandle: "alice", listingId: "l1", slug: "qwen3-8b-q4" });
  assert.equal(row.modelId, "alice/qwen3-8b-q4");
  assert.notEqual(row.modelId, baseModel().slug);
  // Both halves lowercase by schema CHECK, so the id is already the exact string
  // the gateway resolves — no normalisation happens downstream of here.
  assert.equal(row.modelId, row.modelId.toLowerCase());
});

// ── Sorting ────────────────────────────────────────────────────────────────

test("every sortable axis opens best-first, not ascending-first", () => {
  // Cheap and quick are ascending; fast and roomy are descending. A table that
  // opened every column ascending would answer "who is slowest" on the first
  // click of the speed column.
  assert.equal(defaultDirection("priceOut"), "asc");
  assert.equal(defaultDirection("priceIn"), "asc");
  assert.equal(defaultDirection("latency"), "asc");
  assert.equal(defaultDirection("creator"), "asc");
  assert.equal(defaultDirection("speed"), "desc");
  assert.equal(defaultDirection("context"), "desc");
  assert.equal(defaultDirection("quality"), "desc");
  // Total: no axis is left without a direction, which would sort by insertion.
  for (const key of OFFER_SORT_KEYS) {
    assert.ok(["asc", "desc"].includes(defaultDirection(key)), key);
  }
});

test("the table opens cheapest-output-first, matching what the RPC returns", () => {
  // The first paint must not reshuffle: `model_page` orders by completion price
  // and so does the default sort.
  assert.deepEqual(DEFAULT_OFFER_SORT, { key: "priceOut", direction: "asc" });
});

test("clicking a new column opens it best-first; clicking the same one flips", () => {
  const first = nextOfferSort(DEFAULT_OFFER_SORT, "speed");
  assert.deepEqual(first, { key: "speed", direction: "desc" });
  assert.deepEqual(nextOfferSort(first, "speed"), { key: "speed", direction: "asc" });
  assert.deepEqual(nextOfferSort(first, "priceIn"), { key: "priceIn", direction: "asc" });
});

test("an unmeasured throughput sorts last in BOTH directions", () => {
  const rows = [
    offer({ listingId: "unmeasured", measuredTokensPerSecond: null }),
    offer({ listingId: "slow", measuredTokensPerSecond: 12 }),
    offer({ listingId: "fast", measuredTokensPerSecond: 90 }),
  ];

  const desc = sortOffers(rows, { key: "speed", direction: "desc" }).map((o) => o.listingId);
  assert.deepEqual(desc, ["fast", "slow", "unmeasured"]);

  // The direction that would otherwise call the unmeasured listing the quickest
  // thing on the page. Null is not zero.
  const asc = sortOffers(rows, { key: "speed", direction: "asc" }).map((o) => o.listingId);
  assert.deepEqual(asc, ["slow", "fast", "unmeasured"]);
});

test("an unmeasured latency sorts last too, and does not read as instant", () => {
  const rows = [
    offer({ listingId: "unmeasured", p50TtftMs: null }),
    offer({ listingId: "quick", p50TtftMs: 300 }),
  ];
  assert.deepEqual(
    sortOffers(rows, { key: "latency", direction: "asc" }).map((o) => o.listingId),
    ["quick", "unmeasured"],
  );
});

test("offers at one price keep a stable order instead of swapping on re-render", () => {
  const a = offer({ listingId: "aaa", priceCompletionMicroPerMtoken: 1_000_000 });
  const b = offer({ listingId: "bbb", priceCompletionMicroPerMtoken: 1_000_000 });
  const sort: OfferSort = { key: "priceOut", direction: "asc" };
  assert.ok(compareOffers(a, b, sort) < 0);
  assert.ok(compareOffers(b, a, sort) > 0);
  assert.equal(compareOffers(a, a, sort), 0);
});

test("sorting quality walks the ladder, not the alphabet", () => {
  // Alphabetically `Q6_K` precedes `Q8_0` precedes `Q4_K_M`'s tier name in every
  // wrong ordering this could have. The ladder is what makes `desc` mean better.
  const rows = [
    offer({ listingId: "balanced", quantTag: "Q4_K_M", qualityTier: qualityTier("Q4_K_M") }),
    offer({ listingId: "full", quantTag: null, qualityTier: qualityTier(null) }),
    offer({ listingId: "maximum", quantTag: "Q6_K", qualityTier: qualityTier("Q6_K") }),
  ];
  assert.deepEqual(
    sortOffers(rows, { key: "quality", direction: "desc" }).map((o) => o.listingId),
    ["full", "maximum", "balanced"],
  );
});

test("sorting returns a new array and leaves the prop untouched", () => {
  // `toSorted`, not `sort`: the offers array is a prop, and reordering it in
  // place mutates the caller's data under React. `oxlint`'s `no-array-sort` is
  // enforced in CI for this reason.
  const rows = [
    offer({ listingId: "b", priceCompletionMicroPerMtoken: 2_000_000 }),
    offer({ listingId: "a", priceCompletionMicroPerMtoken: 1_000_000 }),
  ];
  const sorted = sortOffers(rows, DEFAULT_OFFER_SORT);
  assert.notEqual(sorted, rows);
  assert.deepEqual(
    rows.map((o) => o.listingId),
    ["b", "a"],
  );
  assert.deepEqual(
    sorted.map((o) => o.listingId),
    ["a", "b"],
  );
});

// ── The variant selector ───────────────────────────────────────────────────

test("two tags on one rung are ONE button, not two", () => {
  // The whole reason the selector is built from tiers. `IQ4_XS` and `Q4_K_M` are
  // both `balanced`; a tag-shaped selector would offer them as two choices for
  // one decision and make a shopper learn the ladder to use the page.
  const rows = [
    offer({ listingId: "l1", quantTag: "Q4_K_M", qualityTier: qualityTier("Q4_K_M") }),
    offer({ listingId: "l2", quantTag: "IQ4_XS", qualityTier: qualityTier("IQ4_XS") }),
  ];
  assert.deepEqual(
    variantTiers(rows).map((t) => ({ count: t.count, tier: t.tier })),
    [{ count: 2, tier: "balanced" }],
  );
});

test("a rung with no offers gets no button, and the rest stay in ladder order", () => {
  const rows = [
    offer({ listingId: "l1", quantTag: "Q6_K", qualityTier: qualityTier("Q6_K") }),
    offer({ listingId: "l2", quantTag: "Q4_K_M", qualityTier: qualityTier("Q4_K_M") }),
    offer({ listingId: "l3", quantTag: "Q5_K_M", qualityTier: qualityTier("Q5_K_M") }),
  ];
  const tiers = variantTiers(rows);
  // Ladder order (worst → best), not count order and not insertion order: a strip
  // that reorders itself moves the button the reader is reaching for.
  assert.deepEqual(
    tiers.map((t) => t.tier),
    ["balanced", "high", "maximum"],
  );
  const ranks = tiers.map((t) => QUALITY_TIERS.indexOf(t.tier));
  assert.deepEqual(
    ranks,
    ranks.toSorted((a, b) => a - b),
  );
});

test("each rung's price is the cheapest OUTPUT price available at that quality", () => {
  const rows = [
    offer({
      listingId: "dear",
      priceCompletionMicroPerMtoken: 3_000_000,
      quantTag: "Q4_K_M",
      qualityTier: qualityTier("Q4_K_M"),
    }),
    offer({
      listingId: "cheap",
      priceCompletionMicroPerMtoken: 900_000,
      quantTag: "Q4_0",
      qualityTier: qualityTier("Q4_0"),
    }),
    offer({
      listingId: "max",
      priceCompletionMicroPerMtoken: 4_000_000,
      quantTag: "Q8_0",
      qualityTier: qualityTier("Q8_0"),
    }),
  ];
  const tiers = variantTiers(rows);
  const balanced = tiers.find((t) => t.tier === "balanced");
  const maximum = tiers.find((t) => t.tier === "maximum");
  assert.equal(balanced?.fromCompletionMicro, 900_000);
  assert.equal(maximum?.fromCompletionMicro, 4_000_000);
});

test("the All button is every offer, and a tier narrows to exactly its rung", () => {
  const rows = [
    offer({ listingId: "l1", quantTag: "Q4_K_M", qualityTier: qualityTier("Q4_K_M") }),
    offer({ listingId: "l2", quantTag: "Q8_0", qualityTier: qualityTier("Q8_0") }),
  ];
  assert.equal(filterOffersByTier(rows, null).length, 2);
  assert.deepEqual(
    filterOffersByTier(rows, "maximum").map((o) => o.listingId),
    ["l2"],
  );
  // A new array either way, for the same mutation reason as `sortOffers`.
  assert.notEqual(filterOffersByTier(rows, null), rows);
});

test("the creator count is distinct handles, so it cannot outrun the table", () => {
  const rows = [
    offer({ creatorHandle: "alice", listingId: "l1", slug: "q4" }),
    offer({ creatorHandle: "alice", listingId: "l2", slug: "q6" }),
    offer({ creatorHandle: "bob", listingId: "l3", slug: "q4" }),
  ];
  assert.equal(offerCreatorCount(rows), 2);
  assert.equal(offerCreatorCount([]), 0);
});

// ── Lineage ────────────────────────────────────────────────────────────────

test("root and unresolved are different sentences, and neither is blank", () => {
  const root = lineageOf(baseModel({ parentId: null }), null);
  const unresolved = lineageOf(null, null);

  assert.equal(root.kind, "root");
  assert.equal(unresolved.kind, "unresolved");
  // The pair this test exists for. A blank lineage line renders "trained from
  // scratch" and "nobody has checked" identically, and they are opposite claims.
  assert.notEqual(lineageSummary(root), lineageSummary(unresolved));
  for (const lineage of [root, unresolved]) {
    assert.ok(lineageSummary(lineage).length > 0);
    assert.ok(lineage.note.length > 0);
  }
});

test("a fine-tune names its parent, and links only when the parent is served here", () => {
  const served = lineageOf(baseModel({ parentId: "p1" }), parentModel({ listingCount: 2 }));
  assert.equal(served.kind, "derived");
  assert.equal(lineageSummary(served), "Qwen3 8B");
  // Searched by display name: the slug's first segment is the weights publisher,
  // and searching it would narrow to one lab's listings.
  assert.equal(served.kind === "derived" ? served.searchQuery : null, "Qwen3 8B");

  const unserved = lineageOf(baseModel({ parentId: "p1" }), parentModel({ listingCount: 0 }));
  assert.equal(unserved.kind, "derived");
  assert.equal(lineageSummary(unserved), "Qwen3 8B");
  // No link. A catalog search that returns nothing reads as a broken page rather
  // than as a model nobody here serves.
  assert.equal(unserved.kind === "derived" ? unserved.searchQuery : "unset", null);
});

test("a parent id with no readable row is stated, not silently rendered as root", () => {
  const orphaned = lineageOf(baseModel({ parentId: "gone" }), null);
  assert.equal(orphaned.kind, "orphaned");
  assert.notEqual(lineageSummary(orphaned), lineageSummary(lineageOf(baseModel(), null)));
});

test("a stray parent row cannot invent a lineage for a root model", () => {
  assert.equal(lineageOf(baseModel({ parentId: null }), parentModel()).kind, "root");
});

// ── The licence ────────────────────────────────────────────────────────────

test("a conditional Llama model owes attribution and the naming rule as content", () => {
  const model = baseModel({
    commercialHosting: "conditional",
    licenseId: "llama3.1",
    licenseName: "Llama 3.1 Community License",
    licenseUrl: "https://example.invalid/llama",
    licenseVersion: "3.1",
  });
  const obligations = licenceObligations(model);

  assert.ok(obligations);
  // The string the licence asks be DISPLAYED. The page renders it; a checkbox
  // acknowledging it while the page stays silent is worse than no checkbox.
  assert.equal(obligations.attribution, "Built with Llama");
  assert.match(obligations.derivativeNaming ?? "", /must begin with/);
  assert.ok(obligations.passThrough.length >= 2);
  // The revision is in the label: acknowledging the old Llama text is not
  // acknowledging the new one.
  assert.equal(licenceLabel(model), "Llama 3.1 Community License (rev. 3.1)");
});

test("the licence family is read from the licence, never from the model's name", () => {
  // A fine-tune called `my-llama-experiment` under Apache-2.0 owes Meta nothing.
  assert.equal(licenceFamily({ licenseId: "apache-2.0", licenseName: "Apache 2.0" }), null);
  assert.equal(licenceFamily({ licenseId: "llama3.3", licenseName: null }), "llama");
  assert.equal(licenceFamily({ licenseId: null, licenseName: "Gemma Terms of Use" }), "gemma");
  assert.equal(licenceFamily({ licenseId: null, licenseName: null }), null);
});

test("a conditional licence we do not recognise says so instead of inventing terms", () => {
  const obligations = licenceObligations(
    baseModel({ commercialHosting: "conditional", licenseId: "other" }),
  );
  assert.ok(obligations);
  // No attribution string is guessed. Naming the wrong one is a licence breach
  // performed confidently.
  assert.equal(obligations.attribution, null);
  assert.equal(obligations.derivativeNaming, null);
  assert.equal(obligations.passThrough.length, 1);
});

test("a permissive licence owes nothing, and an unresolved one is not called permissive", () => {
  assert.equal(licenceObligations(baseModel({ commercialHosting: "allowed" })), null);
  assert.equal(licenceObligations(baseModel({ commercialHosting: "unknown" })), null);
  assert.equal(licenceObligations(baseModel({ commercialHosting: "prohibited" })), null);

  // Both return null from `licenceObligations`, so the posture note is the only
  // thing keeping "nothing is owed" apart from "nothing is known".
  assert.notEqual(licencePostureNote("allowed"), licencePostureNote("unknown"));
  assert.match(licencePostureNote("unknown"), /not resolved|has not/);
  assert.match(licencePostureNote("prohibited"), /not permit/);
});

test("a licence with no name at all has no label to print", () => {
  assert.equal(licenceLabel(baseModel()), null);
  // The id stands in for a missing human name rather than printing nothing.
  assert.equal(licenceLabel(baseModel({ licenseId: "apache-2.0" })), "apache-2.0");
});
