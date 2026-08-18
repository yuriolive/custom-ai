/**
 * ONE live test. Probes the real MVP target repo over the network and reads
 * the real GGUF header. Skipped unless HF_PROBE_LIVE=1.
 *
 *   HF_PROBE_LIVE=1 node --test test/live.test.ts
 *
 * It asserts the same acceptance numbers as the offline fixture test, so a
 * drift between the committed fixture and the live repo shows up here rather
 * than in production.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { probeRepo } from "../src/probe.ts";

const LIVE = process.env.HF_PROBE_LIVE === "1";
const SLUG = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF";

test(
  "live: probe the real MVP target repo end to end",
  { skip: LIVE ? false : "set HF_PROBE_LIVE=1 to run the network test" },
  async () => {
    const result = await probeRepo(SLUG, {
      hfToken: process.env.HF_TOKEN,
      signal: AbortSignal.timeout(120_000),
    });

    console.log(
      JSON.stringify(
        {
          exists: result.exists,
          isPrivate: result.isPrivate,
          isGated: result.isGated,
          libraryName: result.libraryName,
          weightsFormat: result.weightsFormat,
          runtime: result.runtime,
          deployable: result.variants.filter((v) => v.deployable).length,
          families: [...new Set(result.variants.filter((v) => v.deployable).map((v) => v.family))],
          companions: result.companions,
          architecture: result.architecture,
          architectureError: result.architectureError,
          variants: result.variants.map((v) => ({
            id: v.id,
            bytes: v.weightsBytes,
            files: v.files,
            deployable: v.deployable,
            label: v.qualityLabel,
            excludedReason: v.excludedReason,
          })),
        },
        null,
        2,
      ),
    );

    assert.equal(result.exists, true);
    assert.equal(result.isPrivate, false);
    assert.equal(result.isGated, false);
    assert.equal(result.weightsFormat, "gguf");
    assert.equal(result.runtime, "llamacpp");

    const deployable = result.variants.filter((v) => v.deployable);
    assert.equal(deployable.length, 12, deployable.map((v) => v.id).join(", "));
    assert.deepEqual([...new Set(deployable.map((v) => v.family))], [null, "noMTP"]);
    assert.equal(result.companions.length, 2);

    const offered = new Set(result.variants.flatMap((v) => v.files));
    for (const bad of [
      "Qwen3.8-27B-Uncensored-draft-Q8_0.gguf",
      "Qwen3.8-27B-Uncensored-vision-f16.gguf",
      "Qwen3.8-27B-Uncensored-imatrix.dat",
    ]) {
      assert.ok(!offered.has(bad), `${bad} must never be offered`);
    }

    // FR-DEP-043 path 2: this repo has no config.json, so the architecture can
    // only have come from the GGUF key-value header.
    assert.ok(result.architecture, `architecture read failed: ${result.architectureError}`);
    assert.equal(result.architecture!.source, "gguf-header");
    assert.ok(result.architecture!.nLayers > 0);
    assert.ok(result.architecture!.nKvHeads > 0);
    assert.ok(result.architecture!.nKvHeads <= result.architecture!.nAttentionHeads);
    assert.ok(result.architecture!.headDim > 0);

    // The exact hybrid geometry the capacity solver is blocked on. These are
    // the live header's own values, not estimates: qwen35, 65 blocks of which
    // 1 is an MTP head, 1 full-attention block every 4 -> 16 KV-bearing layers.
    assert.equal(result.architecture!.architecture, "qwen35");
    assert.equal(result.architecture!.nLayers, 65);
    assert.equal(result.architecture!.fullAttentionInterval, 4);
    assert.equal(result.architecture!.nAttentionLayers, 16);
    assert.equal(result.architecture!.headDim, 256);
    assert.equal(result.architecture!.nKvHeads, 4);
    assert.deepEqual(result.architecture!.ssm, {
      stateSize: 128,
      innerSize: 6144,
      groupCount: 16,
      convKernel: 4,
    });
  },
);
