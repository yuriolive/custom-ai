/**
 * Unit tests for the TypeScript half of hybrid retrieval (#28).
 * Run: npm run test:app
 *
 * The RRF RPC's BEHAVIOUR is tested where it runs, in
 * `supabase/tests/09_search_rrf_test.sql` against a real Postgres: the two arms,
 * the fusion arithmetic, the visibility predicates, and the drift guard against
 * `catalog_grouped` are all assertions about SQL and belong there.
 *
 * What is left for this file is the same thing `grouped-catalog.test.ts` covers
 * for the catalog: THE CONTRACT BETWEEN ARTIFACTS THAT CANNOT IMPORT EACH OTHER.
 * Three constants are written down in three runtimes — Deno (the embedder),
 * Node/Next (the catalog) and SQL (the column and the RPC) — and each pair fails
 * silently when it drifts:
 *
 *  - the EMBEDDING DIMENSION. A wrong width is DROPPED by the RPC, deliberately,
 *    so the failure is not an error: the semantic arm simply stops contributing
 *    and search keeps working, slightly worse, forever.
 *  - the SEMANTIC FLOOR. If the catalog's floor drops below the embedder's, the
 *    catalog pays for an inference the embedder was going to refuse; if it rises
 *    above it, three-character queries silently lose the arm they were promised.
 *  - the CLOSED VOCABULARY, which the probe's classifier writes and the schema's
 *    CHECK rejects. A value in one and not the other is an insert that fails at
 *    deploy time, in the pipeline, on a model that was otherwise fine.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { MIN_SEMANTIC_QUERY_LENGTH, shouldEmbedQuery } from "./search-query.ts";
import { MODEL_CATEGORIES } from "./types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DIMENSION_TS = join(ROOT, "supabase", "functions", "embed", "dimension.ts");
const BASE_MODELS_SQL = join(ROOT, "supabase", "migrations", "20260820000100_base_models.sql");
const SEARCH_SQL = join(
  ROOT,
  "supabase",
  "migrations",
  "20260820006000_rpc_search_base_models.sql",
);
const USE_CASES_TS = join(ROOT, "packages", "hf-probe", "src", "use-cases.ts");

const dimensionSource = readFileSync(DIMENSION_TS, "utf8");
const baseModelsSql = readFileSync(BASE_MODELS_SQL, "utf8");
const searchSql = readFileSync(SEARCH_SQL, "utf8");
const useCasesSource = readFileSync(USE_CASES_TS, "utf8");

/** `export const NAME = 123;` → 123, read out of a module this tree cannot import. */
function numericConstant(source: string, name: string): number {
  const value = new RegExp(`export const ${name} = (\\d+)`).exec(source)?.[1];
  assert.ok(value, `${name} not found — the constant was renamed, not just changed`);
  return Number(value);
}

test("the embedding dimension agrees across all three runtimes", () => {
  const ts = numericConstant(dimensionSource, "EMBEDDING_DIMENSION");

  // SQL's copy, which exists because a column typmod cannot be taken from a
  // function call.
  const sqlFunction = /embedding_dimension\(\)[\s\S]*?as \$\$ select (\d+) \$\$/.exec(
    baseModelsSql,
  )?.[1];
  assert.ok(sqlFunction, "public.embedding_dimension() not found in 20260820000100");

  const column = /embedding extensions\.vector\((\d+)\)/.exec(baseModelsSql)?.[1];
  assert.ok(column, "base_models.embedding column type not found");

  assert.equal(ts, Number(sqlFunction), "dimension.ts and embedding_dimension() disagree");
  assert.equal(ts, Number(column), "dimension.ts and the column typmod disagree");
});

test("the semantic floor agrees between the catalog and the embedder", () => {
  assert.equal(
    MIN_SEMANTIC_QUERY_LENGTH,
    numericConstant(dimensionSource, "MIN_SEMANTIC_QUERY_LENGTH"),
  );
});

test("shouldEmbedQuery measures the trimmed query", () => {
  assert.equal(shouldEmbedQuery("qw"), false, "two characters is prefix-FTS territory");
  assert.equal(shouldEmbedQuery("qwen"), true);
  // Padding is not a query. Embedding `  q  ` would be paying an inference for
  // whitespace.
  assert.equal(shouldEmbedQuery("  q  "), false);
  assert.equal(shouldEmbedQuery(""), false);
});

test("RRF's k is stated once, in SQL, and it is 60", () => {
  const k = /search_rrf_k\(\)[\s\S]*?as \$\$ select (\d+) \$\$/.exec(searchSql)?.[1];
  assert.ok(k, "public.search_rrf_k() not found in 20260820006000");
  assert.equal(Number(k), 60, "the published RRF constant");
});

test("the probe's vocabulary is exactly the schema's CHECK", () => {
  const check = /base_models_use_cases_vocab check \(([\s\S]*?)\)\s*,/.exec(baseModelsSql)?.[1];
  assert.ok(check, "base_models_use_cases_vocab not found in 20260820000100");
  const allowed = [...check.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string).toSorted();

  const probe = [...useCasesSource.matchAll(/^ {2}"([a-z-]+)",$/gm)]
    .map((m) => m[1] as string)
    .toSorted();
  assert.deepEqual(
    probe,
    allowed,
    "the classifier writes a value the CHECK rejects, or misses one the tabs count",
  );

  // The UI's list is the same set in TAB order. Order differs on purpose (see
  // MODEL_CATEGORIES); membership must not.
  assert.deepEqual([...MODEL_CATEGORIES].toSorted(), allowed);
});
