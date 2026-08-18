/** config.json -> ModelArchitecture. FR-DEP-043 path 1. */

import assert from "node:assert/strict";
import test from "node:test";

import { architectureFromConfig, moeFromConfig, quantMethodFromConfig } from "../src/config.ts";

const LLAMA = {
  model_type: "llama",
  num_hidden_layers: 32,
  num_attention_heads: 32,
  num_key_value_heads: 8,
  hidden_size: 4096,
  max_position_embeddings: 131072,
};

test("a plain transformer config: every block holds KV, no SSM", () => {
  const r = architectureFromConfig(LLAMA);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.architecture, {
    nLayers: 32,
    nAttentionLayers: 32,
    fullAttentionInterval: null,
    nKvHeads: 8,
    nAttentionHeads: 32,
    hiddenSize: 4096,
    headDim: 128,
    maxPositionEmbeddings: 131072,
    ssm: null,
    architecture: "llama",
    source: "config.json",
  });
});

test("head_dim is taken from the field, not the division, when both exist", () => {
  const r = architectureFromConfig({ ...LLAMA, head_dim: 256 });
  assert.ok(r.ok);
  assert.equal(r.architecture.headDim, 256);
});

test("the divisibility guard REJECTS rather than emitting 213", () => {
  // The exact shape of the MVP target: 5120 / 24 = 213.33. Emitting 213 would
  // under-size KV by 17%; emitting nothing forces the reject path instead.
  const r = architectureFromConfig({
    model_type: "qwen35",
    num_hidden_layers: 65,
    num_attention_heads: 24,
    num_key_value_heads: 4,
    hidden_size: 5120,
  });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /not divisible/);

  // And it accepts when the division IS exact.
  const ok = architectureFromConfig({ ...LLAMA, hidden_size: 4096, num_attention_heads: 32 });
  assert.ok(ok.ok);
  assert.equal(ok.architecture.headDim, 128);
});

test("full_attention_interval drives nAttentionLayers, MTP heads excluded", () => {
  const r = architectureFromConfig({
    model_type: "qwen3_next",
    num_hidden_layers: 65,
    num_attention_heads: 24,
    num_key_value_heads: 4,
    hidden_size: 5120,
    head_dim: 256,
    full_attention_interval: 4,
    num_nextn_predict_layers: 1,
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.nLayers, 65);
  assert.equal(r.architecture.nAttentionLayers, 16);
  assert.equal(r.architecture.fullAttentionInterval, 4);
});

test("an explicit layer_types array wins over the interval rule", () => {
  const layer_types = Array.from({ length: 12 }, (_, i) =>
    i % 3 === 0 ? "full_attention" : "linear_attention",
  );
  const r = architectureFromConfig({
    ...LLAMA,
    num_hidden_layers: 12,
    layer_types,
    full_attention_interval: 4, // deliberately inconsistent with layer_types
  });
  assert.ok(r.ok);
  assert.equal(r.architecture.nAttentionLayers, 4, "counted from layer_types, not the interval");
});

test("a purely recurrent config reports zero growing-KV layers", () => {
  const r = architectureFromConfig({
    ...LLAMA,
    num_hidden_layers: 8,
    layer_types: Array.from({ length: 8 }, () => "mamba"),
  });
  assert.ok(r.ok);
  assert.equal(r.architecture.nAttentionLayers, 0);
});

test("SSM geometry is read across the Mamba spellings, or left null", () => {
  const bare = architectureFromConfig({
    ...LLAMA,
    state_size: 128,
    conv_kernel: 4,
    mamba_expand: 2,
  });
  assert.ok(bare.ok);
  assert.deepEqual(bare.architecture.ssm, {
    stateSize: 128,
    innerSize: 8192, // expand 2 x hidden 4096
    groupCount: 1, // Mamba-1 has no groups
    convKernel: 4,
  });

  const prefixed = architectureFromConfig({
    ...LLAMA,
    mamba_d_state: 128,
    mamba_d_conv: 4,
    mamba_d_inner: 6144,
    mamba_n_groups: 16,
  });
  assert.ok(prefixed.ok);
  assert.deepEqual(prefixed.architecture.ssm, {
    stateSize: 128,
    innerSize: 6144,
    groupCount: 16,
    convKernel: 4,
  });

  // Partial SSM description: null rather than a half-sized state term.
  const partial = architectureFromConfig({ ...LLAMA, mamba_d_state: 128 });
  assert.ok(partial.ok);
  assert.equal(partial.architecture.ssm, null);
});

test("the architecture string is model_type, passed through unvalidated", () => {
  const r = architectureFromConfig({ ...LLAMA, model_type: "not_in_any_allowlist" });
  assert.ok(r.ok);
  assert.equal(r.architecture.architecture, "not_in_any_allowlist");
});

test("a VLM config resolves through text_config", () => {
  const r = architectureFromConfig({ model_type: "gemma3", text_config: LLAMA });
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.architecture.nLayers, 32);
});

test("MoE and quant-method detection still work", () => {
  assert.deepEqual(moeFromConfig({ ...LLAMA, num_local_experts: 8, num_experts_per_tok: 2 }), {
    expertCount: 8,
    expertUsedCount: 2,
  });
  assert.equal(moeFromConfig(LLAMA), null);
  assert.equal(quantMethodFromConfig({ quantization_config: { quant_method: "awq" } }), "awq");
  assert.equal(quantMethodFromConfig({ quantization_config: { quant_method: "gptq" } }), "gptq");
  assert.equal(quantMethodFromConfig(LLAMA), null);
});
