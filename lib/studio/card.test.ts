/**
 * Model-card parsing: the paragraph, and the licence it used to discard.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { descriptionFromCard, factsFromCard, frontmatterFromCard } from "./card.ts";

const CARD = `---
license: apache-2.0
base_model: Qwen/Qwen3-8B
base_model_relation: quantized
tags:
- gguf
- text-generation
---

# Qwen3-8B-GGUF

GGUF quantizations of Qwen3 8B, an instruction-tuned model with strong reasoning
and multilingual coverage.

## Usage
`;

test("the licence is kept, mapped, and no longer thrown away", () => {
  const facts = factsFromCard(CARD, { repoSlug: "bartowski/Qwen3-8B-GGUF", revision: "main" });
  assert.equal(facts.license?.id, "apache-2.0");
  assert.equal(facts.license?.commercialHosting, "allowed");
});

test("the frontmatter is still not the description", () => {
  const facts = factsFromCard(CARD, { repoSlug: "bartowski/Qwen3-8B-GGUF", revision: "main" });
  assert.ok(facts.description?.startsWith("GGUF quantizations of Qwen3 8B"));
  assert.ok(!facts.description?.includes("apache-2.0"));
});

test("the card's own declaration is signal 1's fallback source", () => {
  const facts = factsFromCard(CARD, { repoSlug: "bartowski/Qwen3-8B-GGUF", revision: "main" });
  assert.deepEqual(facts.declaredBaseModels, [
    { repoSlug: "Qwen/Qwen3-8B", relation: "quantized", source: "card_data" },
  ]);
});

test("a base_model LIST names every ingredient of a merge", () => {
  const card = `---
license: llama3.1
base_model:
- meta-llama/Llama-3.1-8B
- NousResearch/Hermes-3-Llama-3.1-8B
base_model_relation: merge
---

A merge of two Llama 3.1 8B derivatives, blended layer by layer.
`;
  const facts = factsFromCard(card, { repoSlug: "someone/Merged-8B", revision: "main" });
  assert.deepEqual(
    facts.declaredBaseModels.map((d) => d.repoSlug),
    ["meta-llama/Llama-3.1-8B", "NousResearch/Hermes-3-Llama-3.1-8B"],
  );
  assert.equal(facts.declaredBaseModels[0]?.relation, "merge");
  assert.equal(facts.license?.commercialHosting, "conditional");
});

test("`license: other` with a link resolves the link against the repo", () => {
  const card = `---
license: other
license_name: qwen-research
license_link: LICENSE
---

Research preview weights.
`;
  const facts = factsFromCard(card, { repoSlug: "SomeLab/Model", revision: "v2" });
  assert.equal(facts.license?.commercialHosting, "prohibited");
  assert.equal(facts.license?.url, "https://huggingface.co/SomeLab/Model/blob/v2/LICENSE");
});

test("quoted values and trailing comments are read, nested maps are not", () => {
  const card = `---
license: "mit"
base_model: 'Qwen/Qwen3-8B'  # the parent
model-index:
- name: Something
  license: cc-by-nc-4.0
---

Prose.
`;
  const parsed = frontmatterFromCard(card);
  assert.equal(parsed?.license, "mit");
  assert.equal(parsed?.base_model, "Qwen/Qwen3-8B");
});

test("no frontmatter at all is not an error", () => {
  const facts = factsFromCard("Just a README with no metadata whatsoever, and a sentence.", {
    repoSlug: "a/b",
    revision: "main",
  });
  assert.equal(facts.license, null);
  assert.deepEqual(facts.declaredBaseModels, []);
  assert.equal(frontmatterFromCard("no dashes here"), null);
});

test("a card that is only a badge wall suggests no description", () => {
  assert.equal(descriptionFromCard("---\nlicense: mit\n---\n\n![badge](x.svg)\n"), null);
});
