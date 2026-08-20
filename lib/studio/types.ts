/**
 * Plain, serializable shapes for Creator Studio.
 *
 * Everything here crosses either a Server Component -> Client Component
 * boundary or an HTTP boundary, so it holds JSON primitives only: timestamps
 * are ISO strings and money is an integer count of micro-USD (CONTRACTS.md
 * §Money — no floats in a monetary path).
 *
 * NOTHING IN THIS FILE COMPUTES A PLACEMENT. `Placement` is a transcription of
 * the jsonb envelope returned by `resolve_placement()`; every number on it was
 * produced by that function. FR-DEP-050 / FR-DB-007 make a second
 * implementation prohibited, and the reason is on the model card: a TypeScript
 * solver that drifted from the Postgres one would publish a throughput and a
 * context window the provisioned endpoint does not deliver.
 */

// ─── Probe ───────────────────────────────────────────────────────────────────

/** One discovered, deployable variant. Mirrors `ModelVariant` from hf-probe. */
export type StudioVariant = {
  /** `${family ?? "base"}:${quantTag ?? "native"}` */
  id: string;
  /** Raw tag, e.g. `Q4_K_M`. Disclosure only — never a row's primary label. */
  quantTag: string | null;
  /** `noMTP`, `i1`, … `null` is the base family. */
  family: string | null;
  /** Creator-facing, e.g. "Balanced". This is what the row is labelled with. */
  qualityLabel: string;
  bitsPerWeight: number | null;
  weightsBytes: number;
  /** Bytes read per decoded token. Differs from weights only for MoE. */
  activeWeightsBytes: number;
  /** Every shard, for a split GGUF. llama.cpp resolves a FILE (FR-DEP-061). */
  files: string[];
  deployable: boolean;
  /** Set when `deployable` is false — shown in the row, not in a tooltip. */
  excludedReason: string | null;
};

/**
 * Attention geometry, as probed. Feeds the solver and nothing else.
 *
 * `ssmStateBytesPerSeq` is computed by `public.calc_ssm_state_bytes()` — the
 * probe route calls it rather than restating the formula, for the same reason
 * placement is not restated. It is CONSTANT in context length; multiplying it
 * by the context window is the mirror image of the all-layers KV bug and just
 * as wrong (migration 20260817001700).
 */
export type StudioArchitecture = {
  nLayers: number;
  nAttentionLayers: number;
  nKvHeads: number;
  headDim: number;
  maxPositionEmbeddings: number | null;
  ssmStateBytesPerSeq: number;
  architecture: string | null;
  source: "config.json" | "gguf-header";
  /**
   * The two fields below and `fullAttentionInterval` feed NOTHING in the
   * solver — they are the rest of `base_models`' architecture fingerprint (#25
   * signal 3), which needs the whole shape to be worth comparing: `qwen3` alone
   * is shared by a 0.6B and a 32B.
   */
  nAttentionHeads: number;
  hiddenSize: number;
  fullAttentionInterval: number | null;
};

// ─── Base model (#25 — the resolution cascade) ────────────────────────────────

/**
 * An existing catalog model this repo MIGHT be, from signals 3 (architecture
 * fingerprint) and 4 (normalized name). Never applied automatically: a
 * fine-tune matches its parent on every field of both.
 */
export type BaseModelSuggestion = {
  baseModelId: string;
  /** `publisher/name` — `base_models.slug`, not a Hugging Face repo path. */
  slug: string;
  displayName: string;
  /** 0…1, and capped well below certainty. Shown next to the radio button. */
  confidence: number;
  matchedOn: ("fingerprint" | "name")[];
  /** Whether the creator is being offered "this IS it" or "derived from it". */
  relationHint: "quantized" | "finetune";
};

/**
 * The creator's answer to the confirm step. Sent ONLY when the probe returned
 * no declared base model — a repository that declares its own parent is not
 * asked, and the server ignores this field in that case.
 */
export type BaseModelChoice =
  | { kind: "existing"; baseModelId: string }
  | { kind: "child"; parentBaseModelId: string }
  | { kind: "none" };

/**
 * `custom_models.base_model_match` — the audit trail that makes a wrong
 * grouping explainable and lets a re-resolution pass find every row grouped on
 * a weak signal. `unresolved` is a real value: nothing declared a parent and
 * nobody confirmed one.
 */
export type BaseModelMatch = {
  signal: "card_data" | "gguf_header" | "fingerprint" | "name" | "manual" | "unresolved";
  relation: "quantized" | "finetune" | "merge" | "adapter" | null;
  confidence: number;
  /** The creator's user id, on a manual confirmation only. */
  confirmedBy: string | null;
  at: string;
  reason: string;
  /** The Hub repo or model slug the parent came from. */
  sourceRepo: string | null;
  candidates: {
    baseModelId: string;
    slug: string;
    confidence: number;
    matchedOn: ("fingerprint" | "name")[];
    relationHint: "quantized" | "finetune";
  }[];
};

/** What the probe learned about which model this is, and under what terms. */
export type ProbeBaseModel = {
  /**
   * The parent the REPOSITORY declares — card data or GGUF header. When this is
   * set the grouping is decided and the form asks nothing.
   *
   * ONE parent, even for a merge that names several: `base_models.parent_id` is
   * single-valued, and a merge is attributed to its first-named ingredient.
   */
  declared: {
    repoSlug: string;
    relation: "quantized" | "finetune" | "merge" | "adapter" | null;
    source: "card_data" | "gguf_header";
  } | null;
  /** Populated only when `declared` is null. */
  suggestions: BaseModelSuggestion[];
  /**
   * The licence THIS repo carries. A community re-quantization routinely says
   * `other` or nothing, and a permissive string on a quant repo does not
   * relicense the weights underneath it — so this is what the repo claims, and
   * the weights' terms are the resolved base model's.
   */
  license: {
    id: string | null;
    name: string | null;
    url: string | null;
    commercialHosting: "allowed" | "conditional" | "prohibited" | "unknown";
  } | null;
};

export type ProbeSuccess = {
  ok: true;
  repoSlug: string;
  revision: string;
  /** True when the repo needs a token the caller has not proven works yet. */
  requiresAuth: boolean;
  isPrivate: boolean;
  isGated: boolean;
  /** True once a supplied token has been re-probed successfully (FR-DEP-006). */
  tokenVerified: boolean;
  weightsFormat: "gguf" | "safetensors" | "awq" | "gptq" | "unknown";
  runtime: "vllm" | "llamacpp";
  libraryName: string | null;
  variants: StudioVariant[];
  /** Families present, base first. One family is picked before quality. */
  families: (string | null)[];
  companions: { role: string; file: string; sizeBytes: number }[];
  architecture: StudioArchitecture | null;
  /** Why architecture is null. The form rejects rather than guessing. */
  architectureError: string | null;
  /** Recommended variant id — Q4_K_M-class, else the only one (FR-STU-004a). */
  recommendedVariantId: string | null;
  /**
   * Opening paragraph of the repository's model card, as a starting point for
   * the description field. Advisory: null whenever the card is missing or
   * unparseable, and always overwritable by the creator.
   */
  suggestedDescription: string | null;
  /** Which model these weights are, and under what licence (#25). */
  baseModel: ProbeBaseModel;
};

export type ProbeFailureCode =
  | "invalid_slug"
  | "not_found"
  | "requires_auth"
  | "gated"
  | "token_rejected"
  | "no_deployable_variant"
  | "unknown_architecture"
  | "upstream_error";

export type ProbeFailure = {
  ok: false;
  code: ProbeFailureCode;
  message: string;
  /** Set on `requires_auth` / `gated`: the form reveals the token field. */
  requiresAuth: boolean;
  isPrivate: boolean;
  isGated: boolean;
};

export type ProbeResponse = ProbeSuccess | ProbeFailure;

// ─── Placement (transcribed from resolve_placement's jsonb) ──────────────────

export type ConsideredTier = {
  tier: string;
  accepted: boolean;
  reason: string;
  predictedTokensPerSecond: number;
  requiredBytes: number;
};

export type FeasiblePlacement = {
  feasible: true;
  gpuTierId: string;
  /** The ONE place a GPU name is allowed to appear (DESIGN.md §4 item 8). */
  gpuLabel: string;
  usdPerHourMicro: number;
  predictedTokensPerSecond: number;
  maxConcurrentStreams: number;
  nLayers: number;
  nAttentionLayers: number;
  kvBytesPerToken: number;
  kvBytesTotal: number;
  ssmStateBytesPerSeq: number;
  bytesPerStream: number;
  weightsBytes: number;
  overheadBytes: number;
  usableVramBytes: number;
  kvDtypeBytes: number;
  prefixCacheBytes: number;
  needsVolume: boolean;
  volumeGb: number;
  coldStartBudgetS: number;
  costFloorMicroPerMtoken: number;
  considered: ConsideredTier[];
};

export type InfeasiblePlacement = {
  feasible: false;
  /** Names the blocking quantity WITH its value (FR-STU-004d). */
  blockingReason: string;
  maxContextAtThisQuality: number;
  fastestAvailableTokensPerSecond: number;
  considered: ConsideredTier[];
};

export type Placement = FeasiblePlacement | InfeasiblePlacement;

/** One row of the variant consequence table: a variant and its placement. */
export type VariantPlacement = {
  variantId: string;
  placement: Placement;
  /**
   * The largest context window this variant can actually serve, as reported by
   * the solver probed at the architecture's ceiling. Null when the ceiling is
   * unknown. Not derived here — see `resolve_placement_batch`.
   */
  maxContext: number | null;
};

// ─── Deployment ──────────────────────────────────────────────────────────────

export type DeployRequest = {
  hfRepoSlug: string;
  hfRevision: string;
  displayName: string;
  description: string;
  /** Only sent when the probe said the repo needs one. Never persisted here. */
  hfToken?: string;
  variantId: string;
  contextLength: number;
  targetTokensPerSecond: number;
  /** micro-USD per 1M tokens. Integer. */
  pricePromptMicro: number;
  priceCompletionMicro: number;
  isPublic: boolean;
  /**
   * Only meaningful when the probe found no declared base model. A repository
   * that declares its own parent is authoritative about it, so this is ignored
   * there rather than trusted over the repo's own metadata.
   */
  baseModelChoice?: BaseModelChoice;
};

export type ModelStatus =
  | "draft"
  | "validating"
  | "provisioning"
  | "smoke_testing"
  | "ready"
  | "paused"
  | "failed"
  | "auth_failed"
  | "deleting"
  | "deleted";

/** One row of the "My Models" table (FR-STU-009). */
export type MyModelRow = {
  id: string;
  slug: string;
  displayName: string;
  status: ModelStatus;
  visibility: "public" | "private";
  contextLength: number;
  /** MEASURED, never predicted, wherever it is displayed (FR-DEP-053). */
  measuredTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
  costFloorMicroPerMtoken: number | null;
  pricePromptMicro: number;
  priceCompletionMicro: number;
  /** Bumped on every pricing edit (FR-STU-013). */
  pricingVersion: number;
  totalRequests: number;
  /** Tokens over the trailing 30 days. */
  tokens30d: number;
  /** Creator's share over the trailing 30 days, micro-USD. */
  earnings30dMicro: number;
  remediationHint: string | null;
  provisioningError: string | null;
  createdAt: string;
  readyAt: string | null;
};

/** The provisioning stepper's stages, in order (FR-STU-007). */
export const DEPLOY_STEPS = ["validating", "provisioning", "smoke_testing", "ready"] as const;

export type DeployStep = (typeof DEPLOY_STEPS)[number];

// ─── Refs (FR-STU-002's companion — the Revision ComboBox's options) ─────────

/**
 * The branches and tags of a Hugging Face repository.
 *
 * Exists because the Revision field used to free-text to the literal string
 * `"main"`, so a repository whose default branch is anything else probed a ref
 * that does not exist — and failed quietly, which is this codebase's recurring
 * failure mode rather than a new one.
 *
 * `defaultBranch` is a CHOICE, not a field the Hub reports: see `fetchRepoRefs`
 * in `lib/studio/server/probe.ts` for how it is picked. `ok: false` is a
 * non-event — the ComboBox keeps `allowsCustomValue` and the form behaves
 * exactly as it did before.
 */
export type RefsResponse =
  | {
      ok: true;
      branches: string[];
      tags: string[];
      defaultBranch: string;
    }
  | {
      ok: false;
      code: "invalid_slug" | "not_found" | "requires_auth" | "upstream_error";
      message: string;
    };
