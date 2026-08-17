/**
 * config.json -> ModelArchitecture. FR-DEP-043 path 1.
 * headDim falls back to hidden_size / num_attention_heads when head_dim is
 * absent, which is the common case on older Llama-family configs.
 */

import type { ModelArchitecture } from "../../shared/types.ts";

export interface HfConfigJson {
  model_type?: string;
  torch_dtype?: string;
  num_hidden_layers?: number;
  num_attention_heads?: number;
  num_key_value_heads?: number;
  hidden_size?: number;
  head_dim?: number;
  max_position_embeddings?: number;
  num_local_experts?: number;
  num_experts_per_tok?: number;
  quantization_config?: { quant_method?: string; bits?: number };
  /** VLM configs nest the language model here. */
  text_config?: HfConfigJson;
  [k: string]: unknown;
}

export type ConfigArchitectureResult =
  | { ok: true; architecture: ModelArchitecture }
  | { ok: false; error: string };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

export function architectureFromConfig(cfg: HfConfigJson): ConfigArchitectureResult {
  // A VLM's top level describes the vision tower; the solver wants the LM.
  const c: HfConfigJson =
    cfg.num_hidden_layers === undefined && cfg.text_config ? cfg.text_config : cfg;

  const nLayers = num(c.num_hidden_layers);
  const nAttentionHeads = num(c.num_attention_heads);
  const hiddenSize = num(c.hidden_size);

  const missing: string[] = [];
  if (nLayers === null) missing.push("num_hidden_layers");
  if (nAttentionHeads === null) missing.push("num_attention_heads");
  if (hiddenSize === null) missing.push("hidden_size");
  if (missing.length > 0) {
    return { ok: false, error: `config.json missing required field(s): ${missing.join(", ")}` };
  }

  // Absent num_key_value_heads means plain MHA, not unknown.
  const nKvHeads = num(c.num_key_value_heads) ?? nAttentionHeads!;
  // head_dim is not always hidden_size / num_attention_heads — Qwen3 decouples
  // them. Use the explicit field when present; refuse the fallback when it does
  // not divide evenly rather than emit a head_dim the KV solver would trust.
  const explicitHeadDim = num(c.head_dim);
  let headDim: number;
  if (explicitHeadDim !== null) {
    headDim = explicitHeadDim;
  } else if (hiddenSize! % nAttentionHeads! === 0) {
    headDim = hiddenSize! / nAttentionHeads!;
  } else {
    return {
      ok: false,
      error:
        `cannot derive head_dim: config.json has no head_dim and hidden_size ` +
        `(${hiddenSize}) is not divisible by num_attention_heads (${nAttentionHeads})`,
    };
  }
  if (headDim <= 0) {
    return { ok: false, error: "config.json yielded a non-positive head_dim" };
  }

  return {
    ok: true,
    architecture: {
      nLayers: nLayers!,
      nKvHeads,
      nAttentionHeads: nAttentionHeads!,
      hiddenSize: hiddenSize!,
      headDim,
      maxPositionEmbeddings: num(c.max_position_embeddings),
      source: "config.json",
    },
  };
}

/** FR-DEP-044: MoE expert counts, when present. */
export function moeFromConfig(
  cfg: HfConfigJson,
): { expertCount: number; expertUsedCount: number } | null {
  const c: HfConfigJson =
    cfg.num_local_experts === undefined && cfg.text_config ? cfg.text_config : cfg;
  const total = num(c.num_local_experts);
  const used = num(c.num_experts_per_tok);
  if (total === null || used === null || total <= 1) return null;
  return { expertCount: total, expertUsedCount: used };
}

/** AWQ / GPTQ detection for safetensors repos (FR-DEP-040 / FR-DEP-060). */
export function quantMethodFromConfig(cfg: HfConfigJson): "awq" | "gptq" | null {
  const m = cfg.quantization_config?.quant_method?.toLowerCase();
  if (!m) return null;
  if (m.includes("awq")) return "awq";
  if (m.includes("gptq")) return "gptq";
  return null;
}
