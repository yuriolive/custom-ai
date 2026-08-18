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
  // ── hybrid attention/SSM ──────────────────────────────────────────────────
  /** Qwen3-Next style: 1 full-attention block every N blocks. */
  full_attention_interval?: number;
  /** Granite / Bamba / Qwen3-Next style: explicit per-block kind. Authoritative. */
  layer_types?: string[];
  /** MTP / speculative heads appended after the transformer stack. */
  num_nextn_predict_layers?: number;
  // Mamba spellings, in both the bare and the `mamba_`-prefixed hybrid form.
  state_size?: number;
  conv_kernel?: number;
  n_groups?: number;
  mamba_d_state?: number;
  mamba_d_conv?: number;
  mamba_n_groups?: number;
  mamba_expand?: number;
  mamba_d_inner?: number;
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
  } else if ((hiddenSize! % nAttentionHeads!) === 0) {
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

  const fullAttentionInterval = num(c.full_attention_interval);

  return {
    ok: true,
    architecture: {
      nLayers: nLayers!,
      nAttentionLayers: attentionLayersFromConfig(c, nLayers!, fullAttentionInterval),
      fullAttentionInterval,
      nKvHeads,
      nAttentionHeads: nAttentionHeads!,
      hiddenSize: hiddenSize!,
      headDim,
      maxPositionEmbeddings: num(c.max_position_embeddings),
      ssm: ssmFromConfig(c, hiddenSize!),
      // Raw `model_type`, never checked against an allowlist.
      architecture: typeof c.model_type === "string" ? c.model_type : null,
      source: "config.json",
    },
  };
}

/**
 * Blocks that hold a GROWING KV cache — see `deriveAttentionLayers` in gguf.ts
 * for the full rationale; this path only differs in where the inputs come from.
 *
 * `layer_types` is preferred when present because it is an explicit per-block
 * list rather than a rule to be re-derived: we simply count the blocks the
 * config itself calls full attention. Otherwise we apply the same
 * floor(non-MTP blocks / interval) rule as the GGUF path.
 */
function attentionLayersFromConfig(
  c: HfConfigJson,
  nLayers: number,
  fullAttentionInterval: number | null,
): number {
  if (Array.isArray(c.layer_types) && c.layer_types.length > 0) {
    const attn = c.layer_types.filter((t) => typeof t === "string" && t.includes("full_attention"));
    if (attn.length > 0) return attn.length;
    // A layer_types array with no full-attention entry means a pure recurrent
    // model: no growing KV at all. Report 0 rather than inventing layers.
    return 0;
  }
  return deriveAttentionLayers(nLayers, fullAttentionInterval, num(c.num_nextn_predict_layers) ?? 0);
}

/**
 * SSM state geometry from config.json. Best effort across the Mamba spellings;
 * the GGUF path is the authoritative one for the MVP's GGUF-only target.
 * Returns null unless state size, conv kernel and inner size are all readable —
 * a partial SSM description would mis-size the constant state term.
 */
function ssmFromConfig(c: HfConfigJson, hiddenSize: number): ModelArchitecture["ssm"] {
  const stateSize = num(c.mamba_d_state) ?? num(c.state_size);
  const convKernel = num(c.mamba_d_conv) ?? num(c.conv_kernel);
  const expand = num(c.mamba_expand);
  const innerSize = num(c.mamba_d_inner) ?? (expand !== null ? expand * hiddenSize : null);
  if (stateSize === null || convKernel === null || innerSize === null) return null;
  return {
    stateSize,
    innerSize,
    // Mamba-1 has no groups and is single-group by construction.
    groupCount: num(c.mamba_n_groups) ?? num(c.n_groups) ?? 1,
    convKernel,
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
