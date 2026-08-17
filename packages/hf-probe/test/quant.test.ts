/** FR-DEP-041 — the quant tag regex and the quality ladder. */

import assert from "node:assert/strict";
import test from "node:test";

import { matchQuantTag, qualityForTag } from "../src/quant.ts";

test("quant tags parse case-insensitively, longest form first", () => {
  const cases: [string, string | null][] = [
    ["Model-Q4_K_M", "Q4_K_M"],
    ["Model-q4_k_m", "Q4_K_M"],
    ["Model-Q4_K_S", "Q4_K_S"],
    ["Model-Q6_K", "Q6_K"],
    ["Model-Q8_0", "Q8_0"],
    ["Model-IQ2_M", "IQ2_M"],
    ["Model-IQ4_XS", "IQ4_XS"],
    ["Model-f16", "F16"],
    ["Model-BF16", "BF16"],
    ["Model-F32", "F32"],
    ["Model_Q5_K_M", "Q5_K_M"],
    ["Model.Q3_K_L", "Q3_K_L"],
    ["Model-nothing-here", null],
  ];
  for (const [stem, want] of cases) {
    const got = matchQuantTag(stem);
    assert.equal(got ? got.tag : null, want, stem);
  }
});

test("a tag-shaped substring of the base name does not win over the real tag", () => {
  // The trailing tag is the one that counts.
  const m = matchQuantTag("Qwen3.8-27B-Uncensored-Q4_K_M");
  assert.equal(m!.tag, "Q4_K_M");
  assert.equal(m!.end, "Qwen3.8-27B-Uncensored-Q4_K_M".length);
});

test("an undelimited tag-like run is not a tag", () => {
  assert.equal(matchQuantTag("ModelQ4_K_Mish"), null);
});

test("the quality ladder matches §4.3.3.2 for every PRD row", () => {
  const rows: [string, number, string][] = [
    ["IQ2_M", 2.7, "Minimum"],
    ["Q2_K", 2.6, "Minimum"],
    ["Q3_K_M", 3.9, "Reduced"],
    ["IQ4_XS", 4.25, "Balanced (compact)"],
    ["Q4_K_M", 4.8, "Balanced"],
    ["Q5_K_M", 5.7, "High"],
    ["Q6_K", 6.6, "Very high"],
    ["Q8_0", 8.5, "Maximum"],
    ["F16", 16, "Full precision"],
    ["BF16", 16, "Full precision"],
    ["AWQ", 4.2, "Balanced (GPU-native)"],
    ["GPTQ", 4.2, "Balanced (GPU-native)"],
  ];
  for (const [tag, bpw, label] of rows) {
    const q = qualityForTag(tag);
    assert.equal(q.bitsPerWeight, bpw, tag);
    assert.equal(q.qualityLabel, label, tag);
  }
});

test("bits-per-weight is monotone along the ladder", () => {
  const ladder = ["IQ2_M", "Q3_K_M", "IQ4_XS", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "F16"];
  const bpw = ladder.map((t) => qualityForTag(t).bitsPerWeight!);
  for (let i = 1; i < bpw.length; i++) {
    assert.ok(bpw[i] > bpw[i - 1], `${ladder[i]} > ${ladder[i - 1]}`);
  }
});

test("an unknown tag grades as null bits, never as a guess", () => {
  const q = qualityForTag("Q9_Z_Q");
  assert.equal(q.bitsPerWeight, null);
});
