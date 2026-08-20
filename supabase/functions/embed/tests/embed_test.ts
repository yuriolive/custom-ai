/**
 * Embedder unit tests.
 *
 * Written against `node:test` + `node:assert/strict` so the SAME file runs under
 * Deno (`deno test`) and under Node (`node --test`), exactly as the gateway's
 * tests do.
 *
 * Everything here is pure: no database, no network, and no `Supabase.ai` —
 * `embed()` itself is a thin wrapper over a platform global that does not exist
 * outside the edge runtime, so what is asserted here is everything AROUND the
 * model call: the document the model is given, the width contract, and the two
 * auth decisions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  isEmbedding,
  MAX_QUERY_CHARS,
  MIN_SEMANTIC_QUERY_LENGTH,
} from "../dimension.ts";
import { baseModelDocument, normalizeQuery } from "../document.ts";
import { bearerToken, secretEquals } from "../index.ts";

test("the dimension is gte-small's, in one place", () => {
  assert.equal(EMBEDDING_MODEL, "gte-small");
  // The number the column type, the RPC and every fixture agree on. If this
  // moves, `public.embedding_dimension()` and the column typmod move with it —
  // pgTAP asserts that pair, this asserts the TypeScript side of it.
  assert.equal(EMBEDDING_DIMENSION, 384);
});

test("isEmbedding accepts only a full-width finite vector", () => {
  const good = Array.from({ length: EMBEDDING_DIMENSION }, () => 0.1);
  assert.equal(isEmbedding(good), true);
  assert.equal(isEmbedding(good.slice(1)), false, "a short vector is not an embedding");
  assert.equal(isEmbedding([...good.slice(1), Number.NaN]), false, "NaN is not a coordinate");
  assert.equal(isEmbedding("[0.1,0.2]"), false, "a serialized vector is not a vector");
  assert.equal(isEmbedding(null), false);
});

test("the semantic floor is 3 characters", () => {
  // Below this the vector arm is skipped and prefix FTS answers alone: `qw` is a
  // legal prefix of `qwen`, while the embedding of `qw` is an embedding of
  // nothing.
  assert.equal(MIN_SEMANTIC_QUERY_LENGTH, 3);
});

test("a base model document carries name, publisher, size and use cases", () => {
  const document = baseModelDocument({
    display_name: "Qwen3 Coder 8B",
    slug: "qwen/qwen3-coder-8b",
    family: "qwen3",
    summary: "Dense 8B tuned for repository-scale editing.",
    use_cases: ["code", "tool-use"],
    parameter_count: 8_000_000_000,
  });

  assert.match(document, /Qwen3 Coder 8B/);
  // The slug's separators are spaces in the document: `qwen/qwen3-coder-8b` is a
  // path, and the model reads text.
  assert.match(document, /qwen qwen3 coder 8b/);
  assert.match(document, /8B parameters/);
  // THE JOIN BETWEEN THE TWO LAYERS. Without this sentence a query about a task
  // ("write unit tests") is being matched against a document that only names a
  // product.
  assert.match(document, /Used for code, tool use\./);
  assert.match(document, /repository-scale editing/);
});

test("a document holds nothing that belongs to a listing", () => {
  const document = baseModelDocument({
    display_name: "Pixie 11B",
    slug: "meta/pixie-11b",
    family: "pixie",
    summary: null,
    use_cases: ["vision"],
    parameter_count: 11_000_000_000,
  });

  // Price, speed, quantization and hardware are properties of a DEPLOYMENT. Any
  // of them in the document means a creator editing a price silently invalidates
  // the vector on weights that did not change.
  for (const forbidden of ["Q4", "tok/s", "$", "L4", "GPU"]) {
    assert.ok(!document.includes(forbidden), `document must not mention ${forbidden}`);
  }
});

test("a document degrades rather than inventing", () => {
  assert.equal(
    baseModelDocument({
      display_name: null,
      slug: null,
      family: null,
      summary: null,
      use_cases: [],
      parameter_count: null,
    }),
    "",
    "nothing to say produces an empty document, which the writer skips",
  );

  const partial = baseModelDocument({
    display_name: "Ghost 9B",
    slug: null,
    family: null,
    summary: null,
    use_cases: null,
    parameter_count: 900_000_000,
  });
  assert.equal(partial, "Ghost 9B. 900M parameters");
});

test("parameter counts read the way a shopper reads them", () => {
  const of = (n: number) =>
    baseModelDocument({
      display_name: null,
      slug: null,
      family: null,
      summary: null,
      use_cases: [],
      parameter_count: n,
    });

  assert.equal(of(8_000_000_000), "8B parameters");
  assert.equal(of(7_500_000_000), "7.5B parameters");
  // PostgREST returns bigint as a string; the document must not render `NaN`.
  assert.equal(
    baseModelDocument({
      display_name: null,
      slug: null,
      family: null,
      summary: null,
      use_cases: [],
      parameter_count: "27000000000",
    }),
    "27B parameters",
  );
});

test("normalizeQuery collapses whitespace and bounds length", () => {
  assert.equal(normalizeQuery("  a   model\nfor  code "), "a model for code");
  assert.equal(normalizeQuery("x".repeat(MAX_QUERY_CHARS + 100)).length, MAX_QUERY_CHARS);
  // NOT lowercased and NOT stemmed: those are lexical normalizations, and the
  // embedding model was trained on text humans write.
  assert.equal(normalizeQuery("Qwen Coder"), "Qwen Coder");
});

test("bearerToken reads the header the write path is gated on", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://embed.test/", { headers });
  assert.equal(bearerToken(req({ authorization: "Bearer abc123" })), "abc123");
  assert.equal(bearerToken(req({ authorization: "bearer abc123" })), "abc123");
  assert.equal(bearerToken(req({ authorization: "abc123" })), undefined);
  assert.equal(bearerToken(req({})), undefined);
});

test("secretEquals is total and never true by accident", () => {
  assert.equal(secretEquals("service-role-key", "service-role-key"), true);
  assert.equal(secretEquals("service-role-key", "service-role-ke"), false);
  assert.equal(secretEquals("service-role-key", "Service-Role-Key"), false);
  // An unset secret must never match an absent header — otherwise a
  // misconfigured deployment opens the write path to everyone.
  assert.equal(secretEquals(undefined, undefined), false);
  assert.equal(secretEquals("", ""), false);
});
