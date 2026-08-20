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
  /**
   * Operator takedown (§5.5). Non-null => this listing is out of the catalog and
   * 404s at the gateway, and the creator cannot clear it — the columns are pinned
   * out of `custom_models_update_own`. Surfaced here because Studio is the only
   * place its target can see it at all.
   */
  suspendedAt: string | null;
  suspensionReason: string | null;
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
