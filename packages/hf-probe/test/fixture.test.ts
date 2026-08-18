/**
 * FR-DEP-047 — THE blocking regression test.
 *
 * Replays the committed file list of the MVP's acceptance target repo through
 * the classifier and asserts every field of the fixture's `expected` block.
 * Offline: no network, no mocks beyond the fixture itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { HfFile, ModelVariant } from "../../shared/types.ts";
import { classifyRepoFiles } from "../src/classify.ts";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../tests/fixtures/hf-qwen38-27b-uncensored-gguf.json", import.meta.url),
);

interface Fixture {
  repoSlug: string;
  revision: string;
  library_name: string;
  siblings: HfFile[];
  expected: {
    weightsFormat: string;
    runtime: string;
    deployableVariantCount: number;
    families: (string | null)[];
    companionCount: number;
    companions: { role: string; file: string }[];
    mustNotBeOffered: string[];
    mvpTargetVariant: {
      id: string;
      quantTag: string;
      family: string | null;
      files: string[];
      weightsBytes: number;
    };
  };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const expected = fixture.expected;

const result = classifyRepoFiles({
  repoSlug: fixture.repoSlug,
  files: fixture.siblings,
});
const deployable = result.variants.filter((v) => v.deployable);

test("fixture: weightsFormat is gguf and runtime is derived as llamacpp (FR-DEP-060)", () => {
  assert.equal(result.weightsFormat, expected.weightsFormat);
  assert.equal(result.runtime, expected.runtime);
});

test("fixture: exactly 12 deployable variants (FR-DEP-047)", () => {
  assert.equal(
    deployable.length,
    expected.deployableVariantCount,
    `got ${deployable.length}: ${deployable.map((v) => v.id).join(", ")}`,
  );
});

test("fixture: exactly two families, [null, 'noMTP'] (FR-DEP-041b)", () => {
  const families = [...new Set(deployable.map((v) => v.family))];
  assert.deepEqual(families, expected.families);
  // Six variants in each family — a quant-tag-keyed map would collapse to six.
  for (const fam of expected.families) {
    assert.equal(deployable.filter((v) => v.family === fam).length, 6, `family ${fam}`);
  }
});

test("fixture: every variant id is unique across families", () => {
  const ids = deployable.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(", "));
});

test("fixture: two companions, draft + mmproj, with the right files (FR-DEP-046)", () => {
  assert.equal(result.companions.length, expected.companionCount);
  const got = result.companions
    .map((c) => ({ role: c.role, file: c.file }))
    .toSorted((a, b) => (a.file < b.file ? -1 : 1));
  const want = expected.companions.toSorted((a, b) => (a.file < b.file ? -1 : 1));
  assert.deepEqual(got, want);
  for (const c of result.companions) {
    const sibling = fixture.siblings.find((s) => s.path === c.file);
    assert.ok(sibling, `companion ${c.file} is a real file`);
    assert.equal(c.sizeBytes, sibling!.sizeBytes);
  }
});

test("fixture: draft, vision and imatrix are NEVER offered (FR-DEP-041a/041c)", () => {
  const offered = new Set(result.variants.flatMap((v) => v.files));
  const offeredDeployable = new Set(deployable.flatMap((v) => v.files));
  for (const path of expected.mustNotBeOffered) {
    assert.ok(!offeredDeployable.has(path), `${path} must not be deployable`);
    assert.ok(!offered.has(path), `${path} must not appear as a variant at all`);
  }
});

test("fixture: imatrix.dat is excluded by extension before any parsing (FR-DEP-041c)", () => {
  const everyPath = new Set([
    ...result.variants.flatMap((v) => v.files),
    ...result.companions.map((c) => c.file),
  ]);
  assert.ok(!everyPath.has("Qwen3.8-27B-Uncensored-imatrix.dat"));
  assert.ok(!everyPath.has("README.md"));
  assert.ok(!everyPath.has(".gitattributes"));
  assert.ok(!everyPath.has("heretic-study/optuna-journal.jsonl"));
  assert.ok(!everyPath.has("heretic-study/abliteration_metrics.json"));
});

test("fixture: the MVP target variant is exact (base:Q4_K_M)", () => {
  const v = deployable.find((x) => x.id === expected.mvpTargetVariant.id);
  assert.ok(v, `no variant with id ${expected.mvpTargetVariant.id}`);
  assert.equal(v!.quantTag, expected.mvpTargetVariant.quantTag);
  assert.equal(v!.family, expected.mvpTargetVariant.family);
  assert.deepEqual(v!.files, expected.mvpTargetVariant.files);
  assert.equal(v!.weightsBytes, expected.mvpTargetVariant.weightsBytes);
  // Dense model: bytes read per decoded token == all weights.
  assert.equal(v!.activeWeightsBytes, expected.mvpTargetVariant.weightsBytes);
  assert.equal(v!.role, "model");
  assert.equal(v!.bitsPerWeight, 4.8);
  assert.equal(v!.qualityLabel, "Balanced");
  assert.equal(v!.excludedReason, undefined);
  // FR-DEP-061: llama.cpp needs the SPECIFIC file.
  assert.equal(v!.files.length, 1);
});

test("fixture: every deployable variant maps 1:1 onto a real sibling file", () => {
  const sizes = new Map(fixture.siblings.map((s) => [s.path, s.sizeBytes]));
  for (const v of deployable) {
    assert.equal(v.files.length, 1, `${v.id} is not split`);
    assert.ok(sizes.has(v.files[0]), `${v.files[0]} exists`);
    assert.equal(v.weightsBytes, sizes.get(v.files[0]));
    assert.ok(v.quantTag !== null && v.bitsPerWeight !== null, `${v.id} has a graded quant tag`);
    assert.notEqual(v.qualityLabel, v.quantTag, `${v.id} label is not the raw tag`);
  }
});

test("fixture: quality ladder labels match §4.3.3.2 exactly", () => {
  const want: Record<string, [number, string]> = {
    IQ2_M: [2.7, "Minimum"],
    IQ4_XS: [4.25, "Balanced (compact)"],
    Q4_K_M: [4.8, "Balanced"],
    Q5_K_M: [5.7, "High"],
    Q6_K: [6.6, "Very high"],
    Q8_0: [8.5, "Maximum"],
  };
  for (const v of deployable) {
    const row = want[v.quantTag!];
    assert.ok(row, `unexpected quant tag ${v.quantTag}`);
    assert.equal(v.bitsPerWeight, row[0], v.id);
    assert.equal(v.qualityLabel, row[1], v.id);
  }
});

test("fixture: base name is stripped correctly, so families are clean", () => {
  assert.equal(result.baseName, "Qwen3.8-27B-Uncensored");
  const noMtp = deployable.filter((v) => v.family === "noMTP");
  assert.equal(noMtp.length, 6);
  for (const v of noMtp) assert.ok(v.files[0].includes("-noMTP-"), v.files[0]);
});

test("fixture: variants are ordered base-family-first, ascending quality", () => {
  const ids = deployable.map((v: ModelVariant) => v.id);
  assert.deepEqual(ids, [
    "base:IQ2_M",
    "base:IQ4_XS",
    "base:Q4_K_M",
    "base:Q5_K_M",
    "base:Q6_K",
    "base:Q8_0",
    "noMTP:IQ2_M",
    "noMTP:IQ4_XS",
    "noMTP:Q4_K_M",
    "noMTP:Q5_K_M",
    "noMTP:Q6_K",
    "noMTP:Q8_0",
  ]);
});
