/**
 * Unit tests for Hugging Face namespace handling.
 * Run: npm run test:app
 *
 * The whole `official` badge (#30) rests on one comparison, and these pin the
 * two ways that comparison silently goes wrong:
 *
 * 1. **Case.** HF paths are case-preserving and case-insensitive. Org names on
 *    the Hub are overwhelmingly capitalised (`Qwen`, `TheBloke`) while
 *    `base_models.slug` is lowercase by schema CHECK, so a raw string compare
 *    denies the badge to exactly the accounts most likely to earn one.
 * 2. **Shape.** A value that passes here and fails the column's CHECK is a
 *    sign-in that 500s on write, so the regex in `namespaces.ts` and the one in
 *    migration 20260820004000 are the same regex and these tests are where that
 *    is asserted from the TypeScript side.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hfRepoOwner, normalizeHfNamespace, normalizeHfNamespaces } from "./namespaces.ts";

test("a namespace is lowercased, not rejected, for its case", () => {
  assert.equal(normalizeHfNamespace("JonathanColetti"), "jonathancoletti");
  assert.equal(normalizeHfNamespace("Qwen"), "qwen");
  assert.equal(normalizeHfNamespace("  NousResearch  "), "nousresearch");
});

test("the punctuation HF actually allows survives", () => {
  assert.equal(normalizeHfNamespace("meta-llama"), "meta-llama");
  assert.equal(normalizeHfNamespace("some.org"), "some.org");
  assert.equal(normalizeHfNamespace("some_org"), "some_org");
});

test("anything that is not a namespace is null, never a throw", () => {
  // A sign-in must survive every one of these; the cost is a badge.
  for (const value of [
    "",
    "   ",
    "-leading-hyphen",
    ".leading-dot",
    "has space",
    "has/slash",
    "a".repeat(64),
    null,
    undefined,
    42,
    { preferred_username: "qwen" },
  ]) {
    assert.equal(normalizeHfNamespace(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("the owner of a repo path is its first segment", () => {
  assert.equal(hfRepoOwner("JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"), "jonathancoletti");
  assert.equal(hfRepoOwner("Qwen/Qwen3-8B"), "qwen");
});

test("a path with no owner segment yields null, not the whole string", () => {
  // The failure this prevents: a malformed `hf_repo_slug` of `qwen3-8b` matching
  // a creator whose username happens to be the model name.
  assert.equal(hfRepoOwner("qwen3-8b"), null);
  assert.equal(hfRepoOwner("/leading-slash"), null);
  assert.equal(hfRepoOwner(""), null);
  assert.equal(hfRepoOwner(null), null);
});

test("a repo path with extra segments still names its owner", () => {
  // Not a real repo path, but a probe or a paste can produce one and the owner
  // segment is still unambiguous.
  assert.equal(hfRepoOwner("Qwen/Qwen3-8B/tree/main"), "qwen");
});

test("a namespace list is lowercased, deduped and sorted", () => {
  assert.deepEqual(normalizeHfNamespaces(["Qwen", "qwen", "TheBloke"]), ["qwen", "thebloke"]);
});

test("malformed entries drop out of a list without taking it down", () => {
  // A single bad org must not cost the creator the orgs that are fine — and must
  // not reach the column, whose CHECK would reject the whole array.
  assert.deepEqual(normalizeHfNamespaces(["Qwen", null, "has space", { a: 1 }, "meta-llama"]), [
    "meta-llama",
    "qwen",
  ]);
});

test("an empty list stays empty", () => {
  assert.deepEqual(normalizeHfNamespaces([]), []);
});
