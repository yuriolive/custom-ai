/**
 * Layer A: the closed use-case vocabulary (#28 §4.1).
 *
 * What is worth asserting here is not "does the regex fire" — it is the two
 * properties that make a facet usable:
 *
 *   1. DETERMINISM AND ORDER. The same input produces the same array, in
 *      vocabulary order. A facet whose value reorders between deploys shows up
 *      as a diff on every re-resolution and as a cache miss on every count.
 *   2. PRECISION. A wrong tag is worse than a missing one: it puts a model in
 *      front of somebody who asked for something else, and it makes the number
 *      on that tab a lie. So the negative cases below carry as much weight as
 *      the positive ones.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyUseCases, LONG_CONTEXT_TOKENS, USE_CASES } from "../src/use-cases.ts";

test("the vocabulary is the one the schema enforces", () => {
  // The CHECK in 20260820000100 lists exactly these twelve. A thirteenth here is
  // a value the database rejects on insert; a missing one is a tab that can
  // never have a row.
  assert.deepEqual([...USE_CASES].toSorted(), [
    "chat",
    "code",
    "embeddings",
    "long-context",
    "math",
    "multilingual",
    "reasoning",
    "roleplay",
    "summarization",
    "tool-use",
    "uncensored",
    "vision",
  ]);
});

test("an HF tag is a deliberate act and is trusted alone", () => {
  assert.deepEqual(classifyUseCases({ tags: ["code", "conversational"] }), ["code", "chat"]);
  assert.deepEqual(classifyUseCases({ tags: ["function-calling"] }), ["tool-use"]);
});

test("a pipeline tag files the repo the way HF itself files it", () => {
  assert.deepEqual(classifyUseCases({ pipelineTag: "image-text-to-text" }), ["vision"]);
  assert.deepEqual(classifyUseCases({ pipelineTag: "sentence-similarity" }), ["embeddings"]);
  // `text-generation` covers every instruct model ever published. Tagging on it
  // would put the entire catalog under one tab, which is the same as no tab.
  assert.deepEqual(classifyUseCases({ pipelineTag: "text-generation" }), []);
});

test("multilingual needs two declared languages, not one", () => {
  assert.deepEqual(classifyUseCases({ tags: ["en", "pt", "fr"] }), ["multilingual"]);
  // A monolingual Portuguese model is not multilingual, and calling it that is
  // the exact mistake an English-centric default makes.
  assert.deepEqual(classifyUseCases({ tags: ["pt"] }), []);
});

test("long context is read from the ARCHITECTURE, not from a deployment", () => {
  assert.deepEqual(classifyUseCases({ maxPositionEmbeddings: LONG_CONTEXT_TOKENS }), [
    "long-context",
  ]);
  assert.deepEqual(classifyUseCases({ maxPositionEmbeddings: 32_768 }), []);
  // 8192 here is `custom_models.context_length`'s territory — one creator's
  // choice of what to serve. If that fed this, one model's use cases would
  // depend on how somebody else deployed it.
  assert.deepEqual(classifyUseCases({ maxPositionEmbeddings: 8_192 }), []);
});

test("a name is trusted only where the name IS the claim", () => {
  assert.deepEqual(classifyUseCases({ repoSlug: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF" }), [
    "uncensored",
  ]);
  assert.deepEqual(classifyUseCases({ repoSlug: "Qwen/Qwen3-Coder-8B" }), ["code"]);
  // Nothing is inferred from a bare family name: `Qwen3-8B` is a model, not a
  // description of one.
  assert.deepEqual(classifyUseCases({ repoSlug: "Qwen/Qwen3-8B" }), []);
});

test("the card is read for phrases, never for words", () => {
  assert.deepEqual(classifyUseCases({ cardText: "A code generation model for Python and Go." }), [
    "code",
  ]);
  assert.deepEqual(
    classifyUseCases({ cardText: "Fine-tuned for step-by-step reasoning on hard problems." }),
    ["reasoning"],
  );
  // The trap this file exists for: the word appears, the claim does not.
  assert.deepEqual(
    classifyUseCases({ cardText: "Mathematical notation renders correctly in the table below." }),
    [],
  );
  assert.deepEqual(
    classifyUseCases({ cardText: "See the code in the snippet below to get started." }),
    [],
  );
});

test("an embedding model is not a chat model", () => {
  // A repo tagged both is tagged wrong, and the narrower claim wins: the gateway
  // cannot serve chat completions from an embedding model at all.
  assert.deepEqual(
    classifyUseCases({ tags: ["sentence-transformers", "conversational", "reasoning"] }),
    ["embeddings"],
  );
});

test("the output is vocabulary-ordered and deduplicated", () => {
  const input = {
    tags: ["uncensored", "code", "conversational", "code-generation", "rp"],
    repoSlug: "Someone/Model-Uncensored",
    cardText: "An uncensored code generation model for role-play.",
  };
  const first = classifyUseCases(input);
  // Discovery order would be tags-then-name-then-card; vocabulary order is what
  // makes a re-probe a no-op instead of a diff.
  assert.deepEqual(first, ["code", "chat", "roleplay", "uncensored"]);
  assert.deepEqual(classifyUseCases(input), first, "the same input classifies the same way twice");
});

test("nothing to go on is an empty array, not a guess", () => {
  assert.deepEqual(classifyUseCases({}), []);
  assert.deepEqual(classifyUseCases({ tags: [], cardText: "", repoSlug: "" }), []);
});
