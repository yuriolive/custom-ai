/**
 * The resolution cascade — one test per signal, and the case the whole design
 * exists for: a fine-tune is NOT a variant of its parent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseGgufHeader } from "../src/gguf.ts";
import {
  baseModelSlugFromRepo,
  fingerprintMatches,
  nameSimilarity,
  normalizeModelName,
  normalizeRelation,
  repoSlugFromRef,
  resolveBaseModelIdentity,
  scoreCandidates,
  type BaseModelCandidate,
  type Fingerprint,
} from "../src/identity.ts";
import type { DeclaredBaseModel } from "../../shared/types.ts";

const QWEN3_8B: Fingerprint = {
  architecture: "qwen3",
  nLayers: 36,
  nAttentionHeads: 32,
  nKvHeads: 8,
  headDim: 128,
  hiddenSize: 4096,
};

// ─── signal 1: cardData.base_model + base_model_relation ────────────────────

test("signal 1: a declared quantization links to its parent, not to itself", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "bartowski/Qwen3-8B-GGUF",
    declared: [{ repoSlug: "Qwen/Qwen3-8B", relation: "quantized", source: "card_data" }],
    fingerprint: QWEN3_8B,
  });

  assert.equal(identity.autoLink, true);
  assert.equal(identity.signal, "card_data");
  assert.equal(identity.relation, "quantized");
  assert.equal(identity.parentRepoSlug, "Qwen/Qwen3-8B");
  // Same weights repackaged: the listing belongs UNDER the parent's row.
  assert.equal(identity.ownModel, false);
  assert.equal(identity.confidence, 1);
  assert.deepEqual(identity.suggestions, []);
});

test("signal 1: a declared fine-tune becomes its OWN model with a parent", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "SomeLab/Qwen3-8B-Uncensored",
    declared: [{ repoSlug: "Qwen/Qwen3-8B", relation: "finetune", source: "card_data" }],
    fingerprint: QWEN3_8B,
  });

  assert.equal(identity.autoLink, true);
  assert.equal(identity.relation, "finetune");
  assert.equal(identity.parentRepoSlug, "Qwen/Qwen3-8B");
  // The output of a fine-tune is not the parent's output.
  assert.equal(identity.ownModel, true);
});

test("signal 1: a merge names several parents; the first is the one attributed", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "SomeLab/Frankenmerge-12B",
    declared: [
      { repoSlug: "Qwen/Qwen3-8B", relation: "merge", source: "card_data" },
      { repoSlug: "mistralai/Mistral-7B-v0.3", relation: "merge", source: "card_data" },
    ],
    fingerprint: QWEN3_8B,
  });

  assert.equal(identity.parentRepoSlug, "Qwen/Qwen3-8B");
  assert.equal(identity.ownModel, true);
});

// ─── signal 2: general.base_model.0.repo_url ────────────────────────────────

test("signal 2: a GGUF header with no relation key infers `quantized` from the name", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "bartowski/Qwen3-8B-GGUF",
    declared: [
      {
        repoSlug: repoSlugFromRef("https://huggingface.co/Qwen/Qwen3-8B")!,
        relation: null,
        source: "gguf_header",
      },
    ],
    fingerprint: QWEN3_8B,
  });

  assert.equal(identity.autoLink, true);
  assert.equal(identity.signal, "gguf_header");
  assert.equal(identity.relation, "quantized");
  assert.equal(identity.ownModel, false);
});

test("signal 2: an unrelated name with no relation is recorded as DERIVED, never merged", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "mradermacher/Qwen3-8B-Uncensored-i1-GGUF",
    declared: [{ repoSlug: "Qwen/Qwen3-8B", relation: null, source: "gguf_header" }],
    fingerprint: QWEN3_8B,
  });

  assert.equal(identity.autoLink, true);
  assert.equal(identity.relation, null);
  // The safe direction: a wrong split is cosmetic, a wrong merge misattributes
  // a fine-tune's output to the base model.
  assert.equal(identity.ownModel, true);
});

test("card data outranks the GGUF header when both declare a parent", () => {
  const declared: DeclaredBaseModel[] = [
    { repoSlug: "Qwen/Qwen3-8B", relation: "quantized", source: "card_data" },
    { repoSlug: "Qwen/Qwen3-4B", relation: null, source: "gguf_header" },
  ];
  const identity = resolveBaseModelIdentity({
    repoSlug: "bartowski/Qwen3-8B-GGUF",
    declared,
    fingerprint: QWEN3_8B,
  });
  assert.equal(identity.parentRepoSlug, "Qwen/Qwen3-8B");
  assert.equal(identity.signal, "card_data");
});

test("a repo that declares ITSELF as its base model has declared nothing", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "Qwen/Qwen3-8B",
    declared: [{ repoSlug: "Qwen/Qwen3-8B", relation: "finetune", source: "card_data" }],
    fingerprint: QWEN3_8B,
  });
  assert.equal(identity.autoLink, false);
  assert.equal(identity.signal, null);
});

// ─── signals 3 and 4: SUGGEST ONLY ──────────────────────────────────────────

const CATALOG: BaseModelCandidate[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "qwen/qwen3-8b",
    displayName: "Qwen3 8B",
    fingerprint: QWEN3_8B,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "meta-llama/llama-3.1-8b-instruct",
    displayName: "Llama 3.1 8B Instruct",
    fingerprint: {
      architecture: "llama",
      nLayers: 32,
      nAttentionHeads: 32,
      nKvHeads: 8,
      headDim: 128,
      hiddenSize: 4096,
    },
  },
];

test("THE CASE THIS EXISTS FOR: a fine-tune is not auto-linked as a variant", () => {
  // Identical fingerprint to Qwen3-8B — same layers, same heads, same vocab —
  // and a name that contains the parent's. Both signals fire, and neither links.
  const identity = resolveBaseModelIdentity({
    repoSlug: "SomeLab/Qwen3-8B-Uncensored",
    declared: [],
    fingerprint: QWEN3_8B,
    candidates: CATALOG,
  });

  assert.equal(identity.autoLink, false);
  assert.equal(identity.signal, null);
  assert.equal(identity.parentRepoSlug, null);
  assert.equal(identity.confidence, 0);

  const top = identity.suggestions[0];
  assert.ok(top, "the parent is still offered as a suggestion");
  assert.equal(top.slug, "qwen/qwen3-8b");
  assert.deepEqual(top.matchedOn, ["fingerprint", "name"]);
  // Offered as a fine-tune OF the candidate, not as the candidate.
  assert.equal(top.relationHint, "finetune");
  assert.ok(top.confidence <= 0.75, `a suggestion never reaches certainty: ${top.confidence}`);
});

test("signal 3 alone (fingerprint, unrelated name) still only suggests", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "SomeLab/Zephyrus-Prime",
    declared: [],
    fingerprint: QWEN3_8B,
    candidates: CATALOG,
  });
  assert.equal(identity.autoLink, false);
  assert.equal(identity.suggestions.length, 1);
  assert.deepEqual(identity.suggestions[0]?.matchedOn, ["fingerprint"]);
});

test("signal 4 alone (name, no readable geometry) still only suggests", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "someone/Qwen3-8B-GGUF",
    declared: [],
    fingerprint: null,
    candidates: CATALOG,
  });
  assert.equal(identity.autoLink, false);
  const top = identity.suggestions[0];
  assert.equal(top?.slug, "qwen/qwen3-8b");
  assert.deepEqual(top?.matchedOn, ["name"]);
  // Same name once the packaging is stripped: a requantization, not a child.
  assert.equal(top?.relationHint, "quantized");
});

test("nothing declared and nothing resembling it yields no suggestion at all", () => {
  const identity = resolveBaseModelIdentity({
    repoSlug: "someone/Totally-New-Weights",
    declared: [],
    fingerprint: null,
    candidates: CATALOG,
  });
  assert.equal(identity.autoLink, false);
  assert.deepEqual(identity.suggestions, []);
});

test("a different SIZE of the same family is not the same model", () => {
  const qwen3_4b: Fingerprint = { ...QWEN3_8B, nLayers: 28, nKvHeads: 4, hiddenSize: 2560 };
  assert.equal(fingerprintMatches(QWEN3_8B, qwen3_4b), false);
});

test("an architecture string alone is not a fingerprint", () => {
  const bare: Fingerprint = {
    architecture: "qwen3",
    nLayers: null,
    nAttentionHeads: null,
    nKvHeads: null,
    headDim: null,
    hiddenSize: null,
  };
  assert.equal(fingerprintMatches(QWEN3_8B, bare), false);
});

test("candidates are ranked, and the floor keeps noise out", () => {
  const scored = scoreCandidates(
    { repoSlug: "bartowski/Qwen3-8B-GGUF", fingerprint: QWEN3_8B },
    CATALOG,
  );
  assert.equal(scored.length, 1);
  assert.equal(scored[0]?.slug, "qwen/qwen3-8b");
});

// ─── the pure helpers ───────────────────────────────────────────────────────

test("repoSlugFromRef accepts the shapes a declaration is written in", () => {
  assert.equal(repoSlugFromRef("Qwen/Qwen3-8B"), "Qwen/Qwen3-8B");
  assert.equal(repoSlugFromRef("https://huggingface.co/Qwen/Qwen3-8B"), "Qwen/Qwen3-8B");
  assert.equal(repoSlugFromRef("https://hf.co/Qwen/Qwen3-8B/tree/main"), "Qwen/Qwen3-8B");
  assert.equal(repoSlugFromRef("https://huggingface.co/models/Qwen/Qwen3-8B"), "Qwen/Qwen3-8B");
  assert.equal(repoSlugFromRef("  Qwen/Qwen3-8B  "), "Qwen/Qwen3-8B");
});

test("repoSlugFromRef refuses anything that is not a Hub repo", () => {
  assert.equal(repoSlugFromRef("Qwen3-8B"), null);
  assert.equal(repoSlugFromRef("https://example.com/Qwen/Qwen3-8B"), null);
  assert.equal(repoSlugFromRef("https://huggingface.co/Qwen"), null);
  assert.equal(repoSlugFromRef(""), null);
  assert.equal(repoSlugFromRef(undefined), null);
});

test("packaging and quant tokens are not part of a model's name", () => {
  assert.equal(normalizeModelName("Qwen3-8B-GGUF"), "qwen3-8b");
  assert.equal(normalizeModelName("Qwen3-8B-i1-GGUF"), "qwen3-8b");
  assert.equal(normalizeModelName("Qwen3-8B-Q4_K_M-GGUF"), "qwen3-8b");
  assert.equal(normalizeModelName("Qwen3-8B"), "qwen3-8b");
  assert.notEqual(normalizeModelName("Qwen3-8B-Uncensored"), normalizeModelName("Qwen3-8B"));
});

test("nameSimilarity never calls a containing name identical", () => {
  assert.equal(nameSimilarity("Qwen3-8B-GGUF", "Qwen3-8B"), 1);
  const finetune = nameSimilarity("Qwen3-8B-Uncensored", "Qwen3-8B");
  assert.ok(finetune > 0.5 && finetune < 1, `fine-tune scored ${finetune}`);
  assert.ok(nameSimilarity("Qwen3-8B", "Llama-3.1-8B-Instruct") < 0.3);
});

test("normalizeRelation maps the spellings the Hub actually carries", () => {
  assert.equal(normalizeRelation("quantized"), "quantized");
  assert.equal(normalizeRelation("Fine-Tuned"), "finetune");
  assert.equal(normalizeRelation("merge"), "merge");
  assert.equal(normalizeRelation("lora"), "adapter");
  assert.equal(normalizeRelation("something-else"), null);
  assert.equal(normalizeRelation(undefined), null);
});

test("baseModelSlugFromRepo produces a slug the schema's CHECK accepts", () => {
  const slugRe = /^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/;
  for (const repo of ["Qwen/Qwen3-8B", "bartowski/Qwen3-8B-GGUF", "TheBloke/Llama-2-7B-AWQ"]) {
    const slug = baseModelSlugFromRepo(repo);
    assert.ok(slug !== null, repo);
    assert.match(slug, slugRe);
  }
  assert.equal(baseModelSlugFromRepo("bartowski/Qwen3-8B-GGUF"), "bartowski/qwen3-8b");
  assert.equal(baseModelSlugFromRepo("not-a-repo"), null);
});

// ─── the two halves meeting: a GGUF header end to end ───────────────────────

test("a GGUF repo with a declared base links without asking the creator anything", () => {
  const header = parseGgufHeader(buildHeaderWithBaseModel());
  const declared: DeclaredBaseModel[] = [];
  const repoUrl = header.kv["general.base_model.0.repo_url"];
  assert.equal(typeof repoUrl, "string");
  const parent = repoSlugFromRef(repoUrl as string);
  assert.ok(parent);
  declared.push({ repoSlug: parent, relation: null, source: "gguf_header" });

  const identity = resolveBaseModelIdentity({
    repoSlug: "bartowski/Qwen3-8B-GGUF",
    declared,
    fingerprint: QWEN3_8B,
  });
  assert.equal(identity.autoLink, true);
  assert.deepEqual(identity.suggestions, []);
});

/** A minimal v3 header carrying only the keys this test reads. */
function buildHeaderWithBaseModel(): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  const str = (s: string) => {
    const bytes = enc.encode(s);
    return [u64(bytes.length), bytes];
  };
  const kv: [string, string][] = [
    ["general.architecture", "qwen3"],
    ["general.base_model.0.repo_url", "https://huggingface.co/Qwen/Qwen3-8B"],
  ];
  parts.push(enc.encode("GGUF"), u32(3), u64(0), u64(kv.length + 1));
  for (const [key, value] of kv) {
    parts.push(...str(key), u32(8), ...str(value));
  }
  // `general.base_model.count`, written as UINT32 the way llama.cpp writes it.
  parts.push(...str("general.base_model.count"), u32(4), u32(1));

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
