/**
 * Unit tests for the grouped catalog's TypeScript half (#26).
 * Run: npm run test:app
 *
 * The RPC's BEHAVIOUR is tested where it runs, in
 * `supabase/tests/08_catalog_grouped_test.sql` against a real Postgres — grouping,
 * the quality facet's new within-group meaning, and the tab-count invariant are
 * all assertions about SQL and belong there.
 *
 * What is left for this file is the part that cannot be tested from either side
 * alone: THE CONTRACT BETWEEN THE TWO ARTIFACTS. Three constants are defined in
 * TypeScript and consumed by SQL (or vice versa), and every one of them fails
 * silently when the two drift:
 *
 *  - `MODEL_CATEGORIES` must be a subset of the `use_cases` CHECK in
 *    20260820000100. A category outside it is a tab that can never have a row,
 *    and it renders as a tab with a zero that never moves.
 *  - `toPrefixTsQuery`'s output must satisfy the pattern `catalog_grouped`
 *    validates `p_ts_query` against. If it stops matching, search silently stops
 *    filtering: the RPC discards the query as malformed and returns everything,
 *    which looks like "search is broken" and reads like "search found a lot".
 *  - `qualityRungs()` must cover the ladder exactly once. A tag on two rungs
 *    double-counts a group in the rail; a tag on none makes a listing
 *    unreachable through the facet that is supposed to find it.
 *
 * Plus the URL round trip for the new `use=` parameter, because the category tab
 * is state that has to survive being pasted into a Slack message (FR-MKT-004).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  categoryLabel,
  formatListingCount,
  formatServedBy,
  priceRungs,
  PRICE_BAND_MAX_MICRO,
  qualityRungs,
  qualityTier,
  tagsForTier,
  weightsPublisher,
} from "./format.ts";
import {
  catalogHref,
  catalogQueryToSearchParams,
  EMPTY_QUERY,
  hasActiveFilters,
  parseCatalogQuery,
} from "./search-params.ts";
import { handleFragment, toPrefixTsQuery } from "./search-query.ts";
import type { QualityTier } from "./types.ts";
import { MODEL_CATEGORIES, QUALITY_TIERS } from "./types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const BASE_MODELS_SQL = join(ROOT, "supabase", "migrations", "20260820000100_base_models.sql");
const GROUPED_SQL = join(ROOT, "supabase", "migrations", "20260820001000_rpc_catalog_grouped.sql");

// ── The category vocabulary ──────────────────────────────────────────────────

test("MODEL_CATEGORIES is a subset of the use_cases CHECK in the migration", () => {
  const sql = readFileSync(BASE_MODELS_SQL, "utf8");
  // The constraint body, from `use_cases <@ array[` to the closing `]::text[]`.
  const block = /use_cases <@ array\[([\s\S]*?)\]::text\[\]/.exec(sql)?.[1];
  assert.ok(block, "could not find the use_cases vocabulary constraint");

  const vocabulary = new Set(
    [...block.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as string),
  );
  assert.ok(vocabulary.size >= 12, `parsed only ${vocabulary.size} vocabulary entries`);

  for (const category of MODEL_CATEGORIES) {
    assert.ok(
      vocabulary.has(category),
      `${category} is a tab but not a legal use_case — no row can ever carry it`,
    );
  }
});

test("categoryLabel is total over MODEL_CATEGORIES", () => {
  for (const category of MODEL_CATEGORIES) {
    const label = categoryLabel(category);
    assert.equal(typeof label, "string");
    assert.notEqual(label.length, 0, `${category} has no label`);
  }
});

// ── The search-query contract ────────────────────────────────────────────────

test("toPrefixTsQuery's output satisfies the pattern the RPC validates against", () => {
  const sql = readFileSync(GROUPED_SQL, "utf8");
  // The literal the migration compares `p_ts_query` to. Lifted rather than
  // restated, so this test breaks if either side is edited alone.
  const pattern = /p_ts_query ~ '(\^[^']+\$)'/.exec(sql)?.[1];
  assert.ok(pattern, "could not find the p_ts_query validation pattern in the migration");

  // Postgres regexes double a backslash inside a single-quoted literal only when
  // E'' is used; this one is a plain literal, so the text is the pattern.
  const validator = new RegExp(pattern);

  const inputs = [
    "qwen",
    "qwen3.8",
    "Qwen3.8-27B-Uncensored-GGUF",
    "qwen 8b",
    "  spaced   out  ",
    "jonathancoletti/qwen3.8",
    "a-b_c.d/e",
    "!!!",
    "-",
    "drop table users; --",
    "8b 8b 8b 8b 8b 8b 8b 8b 8b 8b",
  ];

  for (const input of inputs) {
    const tokenized = toPrefixTsQuery(input);
    if (tokenized === null) continue;
    assert.match(
      tokenized,
      validator,
      `the RPC would discard "${tokenized}" as malformed and return the whole catalog`,
    );
  }
});

// ── The quality ladder ───────────────────────────────────────────────────────

test("qualityRungs covers every tier, once each, in ladder order", () => {
  const rungs = qualityRungs();
  assert.deepEqual(
    rungs.map((rung) => rung.key),
    [...QUALITY_TIERS],
  );
});

test("every quantization tag sits on exactly one rung", () => {
  const seen = new Map<string, QualityTier>();
  for (const rung of qualityRungs()) {
    for (const tag of rung.tags) {
      const previous = seen.get(tag);
      assert.equal(
        previous,
        undefined,
        `${tag} is on both ${previous} and ${rung.key} — the rail would count it twice`,
      );
      seen.set(tag, rung.key);
      // The rung a tag is sent to must be the tier the card renders for it, or a
      // facet finds a listing the card then labels differently.
      assert.equal(qualityTier(tag), rung.key);
    }
  }
  assert.ok(seen.size > 0, "the ladder is empty");
});

test("only `full` also matches a NULL tag", () => {
  for (const rung of qualityRungs()) {
    assert.equal(
      rung.native === true,
      rung.key === "full",
      `${rung.key} disagrees with qualityTier(null) about the unquantized reference`,
    );
  }
  // The reason `full` needs `native` at all: a NULL tag IS the unquantized
  // reference, and no `IN` list can express it.
  assert.equal(qualityTier(null), "full");
  assert.ok(tagsForTier("full").includes("F16"));
});

// ── The price bands ──────────────────────────────────────────────────────────

test("the price bands are contiguous, half-open, and cover every price", () => {
  const rungs = priceRungs();
  assert.deepEqual(
    rungs.map((rung) => rung.key),
    ["budget", "standard", "premium"],
  );

  const [budget, standard, premium] = rungs;
  assert.equal(budget?.min, undefined, "the cheapest band has no lower bound");
  assert.equal(budget?.max, PRICE_BAND_MAX_MICRO.budget);
  // The seam: `budget.max === standard.min`, and because `min` is exclusive
  // while `max` is inclusive, a price sitting exactly on it lands in exactly one
  // band. Both sides inclusive would double-count it in the rail.
  assert.equal(standard?.min, PRICE_BAND_MAX_MICRO.budget);
  assert.equal(standard?.max, PRICE_BAND_MAX_MICRO.standard);
  assert.equal(premium?.min, PRICE_BAND_MAX_MICRO.standard);
  assert.equal(premium?.max, undefined, "the dearest band has no upper bound");
});

// ── The `use=` parameter ─────────────────────────────────────────────────────

test("the category tab round-trips through the URL", () => {
  const parsed = parseCatalogQuery({ use: "code" });
  assert.equal(parsed.category, "code");
  assert.equal(catalogQueryToSearchParams(parsed).get("use"), "code");
  assert.equal(catalogHref(parsed), "/models?use=code");
});

test("an unknown category degrades to All rather than filtering to nothing", () => {
  for (const raw of ["coding", "CODE", "", "'; drop table --", "vision "]) {
    assert.equal(parseCatalogQuery({ use: raw }).category, null, `"${raw}" should not parse`);
  }
});

test("the canonical catalog URL carries no category", () => {
  assert.equal(catalogHref(EMPTY_QUERY), "/models");
  assert.equal(catalogQueryToSearchParams(EMPTY_QUERY).has("use"), false);
});

test("a category alone counts as an active filter", () => {
  // Drives FR-MKT-011: an empty grid under `?use=math` has to say "nothing
  // matched", not "nobody has published anything".
  assert.equal(hasActiveFilters(EMPTY_QUERY), false);
  assert.equal(hasActiveFilters({ ...EMPTY_QUERY, category: "math" }), true);
});

// ── Provenance and counts ────────────────────────────────────────────────────

test("weightsPublisher takes the first segment of the base slug, or nothing", () => {
  assert.equal(weightsPublisher("qwen/qwen3-8b"), "qwen");
  assert.equal(weightsPublisher("jonathancoletti/qwen3.8-27b-uncensored"), "jonathancoletti");
  // Null base slug means the resolution cascade has not run. There is no honest
  // fallback: guessing the publisher from the creator's handle would print the
  // exact claim the provenance line exists to prevent.
  assert.equal(weightsPublisher(null), null);
  assert.equal(weightsPublisher(""), null);
  assert.equal(weightsPublisher("/qwen3-8b"), null);
});

test("the handle fragment is sanitized and needs two characters to be a search", () => {
  assert.equal(handleFragment("Alice"), "alice");
  assert.equal(handleFragment("ali%ce_"), "alice");
  // One character would match most handles on the platform, which is the table
  // rather than a result.
  assert.equal(handleFragment("a"), null);
  assert.equal(handleFragment("%"), null);
});

test("listing and creator counts read as English", () => {
  assert.equal(formatListingCount(1), "1 listing");
  assert.equal(formatListingCount(3), "3 listings");
  assert.equal(formatListingCount(0), "0 listings");

  assert.equal(formatServedBy("alice", 1), "alice");
  assert.equal(formatServedBy("alice", 3), "alice +2");
});
