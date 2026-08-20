/**
 * Unit tests for the two rules the fixture cannot exercise:
 * split-shard grouping (FR-DEP-042) and the 25% size backstop (FR-DEP-041a).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { HfFile } from "../../shared/types.ts";
import {
  classifyRepoFiles,
  classifyRole,
  COMPANION_SIZE_FRACTION,
  deriveBaseName,
  deriveFamily,
  isNonWeightArtifact,
  splitShardSuffix,
} from "../src/classify.ts";
import { matchQuantTag } from "../src/quant.ts";

const GB = 1_000_000_000;

function f(path: string, sizeBytes: number): HfFile {
  return { path, sizeBytes };
}

// ─── split shards (FR-DEP-042) ──────────────────────────────────────────────

test("split shards: three shards become ONE variant with summed bytes", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Big-Model-GGUF",
    files: [
      f("Big-Model-Q4_K_M-00001-of-00003.gguf", 20 * GB),
      f("Big-Model-Q4_K_M-00002-of-00003.gguf", 20 * GB),
      f("Big-Model-Q4_K_M-00003-of-00003.gguf", 5 * GB),
    ],
  });
  assert.equal(r.variants.length, 1);
  const v = r.variants[0];
  assert.equal(v.id, "base:Q4_K_M");
  assert.equal(v.files.length, 3);
  assert.deepEqual(v.files, [
    "Big-Model-Q4_K_M-00001-of-00003.gguf",
    "Big-Model-Q4_K_M-00002-of-00003.gguf",
    "Big-Model-Q4_K_M-00003-of-00003.gguf",
  ]);
  // The whole point: a shard's own size would under-count weights by 3x.
  assert.equal(v.weightsBytes, 45 * GB);
  assert.equal(v.activeWeightsBytes, 45 * GB);
  assert.equal(v.deployable, true);
});

test("split shards: two split quants do not merge with each other", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Big-Model-GGUF",
    files: [
      f("Big-Model-Q4_K_M-00001-of-00002.gguf", 20 * GB),
      f("Big-Model-Q4_K_M-00002-of-00002.gguf", 20 * GB),
      f("Big-Model-Q8_0-00001-of-00002.gguf", 35 * GB),
      f("Big-Model-Q8_0-00002-of-00002.gguf", 35 * GB),
    ],
  });
  assert.deepEqual(r.variants.map((v) => v.id).toSorted(), ["base:Q4_K_M", "base:Q8_0"]);
  assert.equal(r.variants.find((v) => v.id === "base:Q4_K_M")!.weightsBytes, 40 * GB);
  assert.equal(r.variants.find((v) => v.id === "base:Q8_0")!.weightsBytes, 70 * GB);
});

test("split shards: families stay separate across a split (FR-DEP-041b + 042)", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Big-Model-GGUF",
    files: [
      f("Big-Model-Q4_K_M-00001-of-00002.gguf", 20 * GB),
      f("Big-Model-Q4_K_M-00002-of-00002.gguf", 20 * GB),
      f("Big-Model-noMTP-Q4_K_M-00001-of-00002.gguf", 19 * GB),
      f("Big-Model-noMTP-Q4_K_M-00002-of-00002.gguf", 19 * GB),
    ],
  });
  assert.deepEqual(
    r.variants.map((v) => v.id),
    ["base:Q4_K_M", "noMTP:Q4_K_M"],
  );
  assert.equal(r.variants[0].weightsBytes, 40 * GB);
  assert.equal(r.variants[1].weightsBytes, 38 * GB);
});

test("split shards: the backstop compares grouped totals, not single shards", () => {
  // Each shard is 8 GB — under 25% of the 45 GB largest — but the VARIANT is 24 GB.
  const r = classifyRepoFiles({
    repoSlug: "acme/Big-Model-GGUF",
    files: [
      f("Big-Model-Q8_0-00001-of-00002.gguf", 25 * GB),
      f("Big-Model-Q8_0-00002-of-00002.gguf", 20 * GB),
      f("Big-Model-Q4_K_M-00001-of-00003.gguf", 8 * GB),
      f("Big-Model-Q4_K_M-00002-of-00003.gguf", 8 * GB),
      f("Big-Model-Q4_K_M-00003-of-00003.gguf", 8 * GB),
    ],
  });
  const q4 = r.variants.find((v) => v.id === "base:Q4_K_M")!;
  assert.equal(q4.weightsBytes, 24 * GB);
  assert.equal(q4.deployable, true, q4.excludedReason);
});

test("splitShardSuffix parses and strips the shard suffix", () => {
  assert.deepEqual(splitShardSuffix("Model-Q4_K_M-00002-of-00003"), {
    stem: "Model-Q4_K_M",
    shard: { index: 2, total: 3 },
  });
  assert.deepEqual(splitShardSuffix("Model-Q4_K_M"), {
    stem: "Model-Q4_K_M",
    shard: null,
  });
  // Not a shard: wrong digit count.
  assert.equal(splitShardSuffix("Model-001-of-003").shard, null);
});

// ─── size backstop (FR-DEP-041a) ────────────────────────────────────────────

test("size backstop: an unlabelled sub-25% GGUF is quarantined, not offered", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Model-GGUF",
    files: [
      f("Model-Q8_0.gguf", 30 * GB),
      f("Model-Q4_K_M.gguf", 17 * GB),
      // No "draft"/"vision" marker anywhere — only the size gives it away.
      f("Model-tiny-Q8_0.gguf", 3 * GB),
    ],
  });
  const tiny = r.variants.find((v) => v.files[0] === "Model-tiny-Q8_0.gguf");
  assert.ok(tiny, "the file is still surfaced");
  assert.equal(tiny!.deployable, false);
  assert.match(tiny!.excludedReason ?? "", /suspected companion/i);
  assert.equal(tiny!.role, "unknown");
  assert.equal(r.variants.filter((v) => v.deployable).length, 2);
});

test("size backstop: the threshold is exactly 25% of the largest GGUF", () => {
  const largest = 40 * GB;
  const justUnder = largest * COMPANION_SIZE_FRACTION - 1;
  const justOver = largest * COMPANION_SIZE_FRACTION;
  const r = classifyRepoFiles({
    repoSlug: "acme/Model-GGUF",
    files: [
      f("Model-Q8_0.gguf", largest),
      f("Model-alpha-Q4_K_M.gguf", justUnder),
      f("Model-beta-Q4_K_M.gguf", justOver),
    ],
  });
  const alpha = r.variants.find((v) => v.family === "alpha")!;
  const beta = r.variants.find((v) => v.family === "beta")!;
  assert.equal(alpha.deployable, false, "just under 25% is quarantined");
  assert.equal(beta.deployable, true, "exactly 25% is kept");
});

test("size backstop: a companion is measured against the largest file too", () => {
  // The largest artifact is a draft; the backstop must not use a companion as
  // the yardstick in a way that would knock out real models. Here the biggest
  // model is 30 GB, so 7.5 GB is the floor.
  const r = classifyRepoFiles({
    repoSlug: "acme/Model-GGUF",
    files: [
      f("Model-Q8_0.gguf", 30 * GB),
      f("Model-IQ2_M.gguf", 9 * GB),
      f("Model-draft-Q8_0.gguf", 3 * GB),
    ],
  });
  assert.equal(r.variants.filter((v) => v.deployable).length, 2);
  assert.deepEqual(r.companions, [
    { role: "draft", file: "Model-draft-Q8_0.gguf", sizeBytes: 3 * GB },
  ]);
});

// ─── roles, families, extensions ────────────────────────────────────────────

test("role markers are matched at both ends of the stem", () => {
  assert.equal(classifyRole("Model-draft-Q8_0"), "draft");
  assert.equal(classifyRole("draft-Q8_0"), "draft");
  assert.equal(classifyRole("Model.mmproj.f16"), "mmproj");
  assert.equal(classifyRole("Model-vision-f16"), "mmproj");
  assert.equal(classifyRole("Model_clip_f16"), "mmproj");
  assert.equal(classifyRole("Model-lora-Q4_K_M"), "lora");
  assert.equal(classifyRole("Model-adapter-Q4_K_M"), "lora");
  assert.equal(classifyRole("Model-Q4_K_M"), "model");
  // A word merely containing "draft" is not a marker.
  assert.equal(classifyRole("Model-drafting-Q4_K_M"), "model");
});

test("lora adapters are companions, never variants (FR-DEP-045)", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Model-GGUF",
    files: [f("Model-lora-Q8_0.gguf", 500_000_000)],
  });
  assert.equal(r.variants.length, 0);
  assert.equal(r.companions.length, 1);
  assert.equal(r.companions[0].role, "lora");
});

test("non-weight artifacts are excluded by extension", () => {
  for (const p of [
    "Model-imatrix.dat",
    "config.json",
    "README.md",
    "notes.txt",
    ".gitattributes",
    "a/b/journal.jsonl",
  ]) {
    assert.equal(isNonWeightArtifact(p), true, p);
  }
  assert.equal(isNonWeightArtifact("Model-Q4_K_M.gguf"), false);
  assert.equal(isNonWeightArtifact("model-00001-of-00002.safetensors"), false);
});

test("deriveBaseName strips the packaging suffix from the repo name", () => {
  assert.equal(
    deriveBaseName("o/Qwen3.8-27B-Uncensored-GGUF", ["Qwen3.8-27B-Uncensored-Q4_K_M"]),
    "Qwen3.8-27B-Uncensored",
  );
  assert.equal(deriveBaseName("o/Model.gguf", ["Model-Q4_K_M"]), "Model");
  // Repo name unrelated to the filenames -> longest common prefix, at a boundary.
  assert.equal(
    deriveBaseName("o/unrelated", ["Weird-Name-Q4_K_M", "Weird-Name-Q8_0"]),
    "Weird-Name",
  );
});

test("deriveFamily returns null for the base family and the residue otherwise", () => {
  const base = "Qwen3.8-27B-Uncensored";
  const q1 = matchQuantTag("Qwen3.8-27B-Uncensored-Q4_K_M");
  assert.equal(deriveFamily("Qwen3.8-27B-Uncensored-Q4_K_M", base, q1), null);
  const q2 = matchQuantTag("Qwen3.8-27B-Uncensored-noMTP-Q4_K_M");
  assert.equal(deriveFamily("Qwen3.8-27B-Uncensored-noMTP-Q4_K_M", base, q2), "noMTP");
  const q3 = matchQuantTag("Qwen3.8-27B-Uncensored-i1-IQ4_XS");
  assert.equal(deriveFamily("Qwen3.8-27B-Uncensored-i1-IQ4_XS", base, q3), "i1");
  // Role markers are stripped out of the residue, so a draft has no family.
  const q4 = matchQuantTag("Qwen3.8-27B-Uncensored-draft-Q8_0");
  assert.equal(deriveFamily("Qwen3.8-27B-Uncensored-draft-Q8_0", base, q4), null);
});

test("a .gguf with no parseable quant tag is surfaced but not deployable", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Model-GGUF",
    files: [f("Model-Q8_0.gguf", 30 * GB), f("Model-mystery.gguf", 20 * GB)],
  });
  const mystery = r.variants.find((v) => v.files[0] === "Model-mystery.gguf")!;
  assert.equal(mystery.quantTag, null);
  assert.equal(mystery.role, "unknown");
  assert.equal(mystery.deployable, false);
  assert.match(mystery.excludedReason ?? "", /unrecognized quantization/i);
});

// ─── safetensors / runtime derivation (FR-DEP-060) ──────────────────────────

test("safetensors repo is one native variant on the vLLM runtime", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Model",
    files: [
      f("model-00001-of-00002.safetensors", 10 * GB),
      f("model-00002-of-00002.safetensors", 6 * GB),
      f("config.json", 900),
    ],
  });
  assert.equal(r.weightsFormat, "safetensors");
  assert.equal(r.runtime, "vllm");
  assert.equal(r.variants.length, 1);
  assert.equal(r.variants[0].id, "base:native");
  assert.equal(r.variants[0].quantTag, null);
  assert.equal(r.variants[0].weightsBytes, 16 * GB);
  assert.equal(r.variants[0].qualityLabel, "Full precision");
});

test("an AWQ repo is a single AWQ variant on the vLLM runtime", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Model-AWQ",
    files: [f("model.safetensors", 8 * GB), f("config.json", 900)],
    explicitQuantMethod: "awq",
  });
  assert.equal(r.weightsFormat, "awq");
  assert.equal(r.runtime, "vllm");
  assert.equal(r.variants[0].id, "base:AWQ");
  assert.equal(r.variants[0].bitsPerWeight, 4.2);
  assert.equal(r.variants[0].qualityLabel, "Balanced (GPU-native)");
});

test("a repo with no weights at all yields zero variants (FR-DEP-045)", () => {
  const r = classifyRepoFiles({
    repoSlug: "acme/Model",
    files: [f("README.md", 100), f("config.json", 900)],
  });
  assert.equal(r.weightsFormat, "unknown");
  assert.equal(r.variants.length, 0);
});
