/**
 * Shared contract types for MVP-0. FROZEN — see docs/CONTRACTS.md.
 * Types only: this module must stay dependency-free and runtime-free so both
 * Deno (Edge Functions) and Node (tooling, tests) can import it unchanged.
 */

// ─── Money ───────────────────────────────────────────────────────────────────
// All monetary values are integer micro-USD (1 unit = $0.000001). Never a float.
export type MicroUsd = number;

/** Micro-USD per 1,000,000 tokens. e.g. $0.50/1M tokens => 500_000 */
export type MicroUsdPerMToken = number;

// ─── HF probe & variant discovery (packages/hf-probe) ────────────────────────

export type WeightsFormat = "gguf" | "safetensors" | "awq" | "gptq" | "unknown";

/** Only "model" is deployable. See FR-DEP-041a. */
export type GgufRole = "model" | "draft" | "mmproj" | "lora" | "unknown";

/** Derived from WeightsFormat — never chosen by a user. See FR-DEP-060. */
export type ModelRuntime = "vllm" | "llamacpp";

export interface HfFile {
  path: string;
  sizeBytes: number;
}

export interface ModelVariant {
  /** Stable id: `${family ?? "base"}:${quantTag ?? "native"}` */
  id: string;
  /** e.g. "Q4_K_M", "IQ4_XS", "AWQ". null = repo-native precision. */
  quantTag: string | null;
  /**
   * Family discriminator: the filename residue after stripping base name,
   * quant tag, and role markers. e.g. "noMTP". null = base family.
   * Variants in different families are DIFFERENT MODELS (FR-DEP-041b).
   */
  family: string | null;
  role: GgufRole;
  /** All files for this variant. Split GGUF => every shard (FR-DEP-042). */
  files: string[];
  /** Sum over `files`. Never a single shard's size. */
  weightsBytes: number;
  /** Bytes read per decoded token. Equals weightsBytes for dense models. */
  activeWeightsBytes: number;
  /** Approximate bits-per-weight, for ordering the quality ladder. */
  bitsPerWeight: number | null;
  /** Creator-facing label, e.g. "Balanced". Never the raw quant tag. */
  qualityLabel: string;
  deployable: boolean;
  /** Populated when deployable === false. */
  excludedReason?: string;
}

/**
 * Attention geometry required by the capacity solver.
 *
 * NOTE: `nLayers` is the TOTAL block count and is NOT the right multiplier for KV
 * cache on hybrid attention/SSM models. Use `nAttentionLayers`. The MVP's own target
 * (qwen35, full_attention_interval = 4) has 65 blocks but only ~16 attention layers;
 * multiplying KV across all 65 over-estimates the cache by ~4x and rejects
 * configurations that comfortably fit.
 */
export interface ModelArchitecture {
  nLayers: number;
  /**
   * Blocks that actually hold a growing KV cache. Equals nLayers for a plain
   * transformer. For hybrid models, derived from fullAttentionInterval.
   */
  nAttentionLayers: number;
  /** Present on hybrid models: 1 attention block every N blocks. */
  fullAttentionInterval: number | null;
  nKvHeads: number; // GQA count — NOT nAttentionHeads
  nAttentionHeads: number;
  hiddenSize: number;
  /**
   * From `key_length` (GGUF) or `head_dim` (config.json). The
   * hiddenSize / nAttentionHeads fallback is UNSAFE and must be a hard error when
   * the division is not exact — on the MVP target it yields 213.33 where the true
   * value is 256.
   */
  headDim: number;
  maxPositionEmbeddings: number | null;
  /** Per-sequence SSM state on hybrid models. Constant — does NOT grow with context. */
  ssm: { stateSize: number; innerSize: number; groupCount: number; convKernel: number } | null;
  /** Raw arch string, e.g. "qwen35". Never validate against an allowlist. */
  architecture: string | null;
  /** Where these came from. GGUF-only repos have no config.json at all. */
  source: "config.json" | "gguf-header";
}

export interface HfProbeResult {
  repoSlug: string;
  revision: string;
  exists: boolean;
  isPrivate: boolean;
  isGated: boolean;
  libraryName: string | null;
  weightsFormat: WeightsFormat;
  runtime: ModelRuntime;
  variants: ModelVariant[];
  /** Non-deployable companions, kept for later use (FR-DEP-046). */
  companions: { role: GgufRole; file: string; sizeBytes: number }[];
  architecture: ModelArchitecture | null;
  /** Set when architecture could not be determined — then we REJECT, never guess. */
  architectureError?: string;
}

// ─── Usage extraction (supabase/functions/gateway/usage.ts) ───────────────────

export interface UsageResult {
  promptTokens: number;
  completionTokens: number;
  /** Prefix-cache hit within promptTokens. llama.cpp never reports this => 0. */
  cachedPromptTokens: number;
  /**
   * "upstream"  — authoritative usage object from the worker
   * "estimated" — derived from characters; flags the transaction and alerts Ops.
   *               This is the EXPECTED path for llama.cpp (FR-GW-044b).
   */
  source: "upstream" | "estimated";
}

export interface StreamMeta {
  ttftMs: number | null;
  durationMs: number | null;
  coldStart: boolean;
  clientGone: boolean;
}

// ─── Gateway errors (supabase/functions/gateway/errors.ts) ────────────────────

export type GatewayErrorCode =
  | "invalid_model_format"
  | "unsupported_parameter"
  | "invalid_api_key"
  | "revoked_api_key"
  | "insufficient_balance"
  | "account_suspended"
  | "model_not_found"
  | "rate_limit_exceeded"
  | "internal_error"
  | "not_implemented"
  | "model_unavailable"
  | "cold_start_timeout"
  | "stream_timeout";

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: GatewayErrorCode;
  };
}

// ─── Resolution (supabase/functions/gateway/resolve.ts) ───────────────────────

/**
 * Single-JOIN result: api_key -> profile -> custom_model.
 * NOTE: balance is deliberately absent. Balance is read inside the
 * authorize_request transaction and must never be cached (FR-GW-053).
 */
export interface ResolvedRequest {
  apiKeyId: string;
  userId: string;
  modelId: string;
  creatorId: string;
  /**
   * Opaque, PROVIDER-SHAPED reference to the upstream serving pool.
   * RunPod: a path segment. Modal: a URL query string that SELECTS the container
   * pool — not decoration. The gateway must never parse or interpret this; it
   * only splices it into the provider's URL template.
   * Environment-specific: it must be re-pointed after any redeploy.
   */
  upstreamEndpointRef: string;
  servedModelName: string;
  runtime: ModelRuntime;
  pricePromptMicro: MicroUsdPerMToken;
  priceCompletionMicro: MicroUsdPerMToken;
  platformFeeBps: number;
  contextLength: number;
  coldStartBudgetS: number;
  /**
   * Whether the model's chat template can render tool definitions (FR-TOOL-003).
   *
   * THREE-STATE, and the third state is the important one:
   *   true   the template was read and declares tools     -> forward `tools`
   *   false  the template was read and declares none      -> 400, never a
   *          silent prose answer that a client parses as a successful turn
   *   null   the template could not be read at all        -> forward anyway
   *
   * `null` is absence of evidence, not evidence of absence: every row
   * provisioned before FR-TOOL-003 carries it, and refusing those would break
   * requests that work. `false` is a measurement and is enforced.
   */
  supportsTools: boolean | null;
}
