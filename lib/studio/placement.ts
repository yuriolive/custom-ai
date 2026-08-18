/**
 * Transcription of `resolve_placement()`'s jsonb envelope into a typed object,
 * and the two RPC calls that produce one.
 *
 * READ THIS BEFORE ADDING ANYTHING TO THIS FILE. There is no arithmetic here
 * and there must never be. FR-DEP-050 and FR-DB-007 make the Postgres solver
 * the single implementation, called by BOTH the Studio preview and the deploy
 * path, so that the number the form promises is the number that gets
 * provisioned. A helper here that derived, adjusted, rounded or "fixed up" any
 * solver output would be that second implementation, and its drift would be a
 * false spec claim on a public model card.
 *
 * What this file does: rename snake_case keys to camelCase and assert the ones
 * the UI depends on are actually numbers. Nothing else.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ConsideredTier,
  Placement,
  StudioArchitecture,
  StudioVariant,
  VariantPlacement,
} from "./types";

/** A jsonb object as it arrives from PostgREST. */
type Json = Record<string, unknown>;

function num(source: Json, key: string): number {
  const raw = source[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(source: Json, key: string, fallback = ""): string {
  const raw = source[key];
  return typeof raw === "string" ? raw : fallback;
}

function considered(source: Json): ConsideredTier[] {
  const raw = source.considered;
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is Json => typeof e === "object" && e !== null).map((e) => ({
    tier: str(e, "tier"),
    accepted: e.accepted === true,
    reason: str(e, "reason"),
    predictedTokensPerSecond: num(e, "predicted_tokens_per_second"),
    requiredBytes: num(e, "required_bytes"),
  }));
}

/**
 * jsonb envelope -> `Placement`.
 *
 * An envelope that is missing, malformed, or not an object becomes an
 * infeasible placement carrying that fact, never a feasible one with zeroes.
 * A capacity plan that reads "0 tok/s, 0 streams, feasible" is worse than one
 * that says it could not be computed.
 */
export function toPlacement(envelope: unknown): Placement {
  if (typeof envelope !== "object" || envelope === null) {
    return {
      feasible: false,
      blockingReason: "The capacity solver returned no result.",
      maxContextAtThisQuality: 0,
      fastestAvailableTokensPerSecond: 0,
      considered: [],
    };
  }

  const e = envelope as Json;

  if (e.feasible !== true) {
    return {
      feasible: false,
      blockingReason: str(
        e,
        "blocking_reason",
        "No configuration satisfies these constraints.",
      ),
      maxContextAtThisQuality: num(e, "max_context_at_this_quality"),
      fastestAvailableTokensPerSecond: num(e, "fastest_available_tokens_per_second"),
      considered: considered(e),
    };
  }

  return {
    feasible: true,
    gpuTierId: str(e, "gpu_tier_id"),
    gpuLabel: str(e, "gpu_label"),
    usdPerHourMicro: num(e, "usd_per_hour_micro"),
    predictedTokensPerSecond: num(e, "predicted_tokens_per_second"),
    maxConcurrentStreams: num(e, "max_concurrent_streams"),
    nLayers: num(e, "n_layers"),
    nAttentionLayers: num(e, "n_attention_layers"),
    kvBytesPerToken: num(e, "kv_bytes_per_token"),
    kvBytesTotal: num(e, "kv_bytes_total"),
    ssmStateBytesPerSeq: num(e, "ssm_state_bytes_per_seq"),
    bytesPerStream: num(e, "bytes_per_stream"),
    weightsBytes: num(e, "weights_bytes"),
    overheadBytes: num(e, "overhead_bytes"),
    usableVramBytes: num(e, "usable_vram_bytes"),
    kvDtypeBytes: num(e, "kv_dtype_bytes"),
    prefixCacheBytes: num(e, "prefix_cache_bytes"),
    needsVolume: e.needs_volume === true,
    volumeGb: num(e, "volume_gb"),
    coldStartBudgetS: num(e, "cold_start_budget_s"),
    costFloorMicroPerMtoken: num(e, "cost_floor_micro_per_mtoken"),
    considered: considered(e),
  };
}

/**
 * One placement per variant, in ONE round trip.
 *
 * `resolve_placement_batch` is a loop in SQL over `resolve_placement` and
 * nothing more (migration 20260818000100, which asserts the two agree). The
 * batching exists because the consequence table needs every row re-solved on
 * every slider movement, and twelve parallel PostgREST calls per movement is
 * the alternative.
 *
 * `EXECUTE` is granted to `authenticated`, so this runs straight from the
 * browser under the caller's own session — no route handler, per CONTRACTS.md
 * §Frontend / auth contract. It discloses nothing but arithmetic over numbers
 * the caller supplied.
 */
export async function resolvePlacements(
  supabase: SupabaseClient,
  args: {
    variants: StudioVariant[];
    architecture: StudioArchitecture;
    contextLength: number;
    targetTokensPerSecond: number;
    kvDtypeBytes?: number;
  },
): Promise<VariantPlacement[]> {
  const deployable = args.variants.filter((v) => v.deployable);
  if (deployable.length === 0) return [];

  const { data, error } = await supabase.rpc("resolve_placement_batch", {
    p_variants: deployable.map((v) => ({
      id: v.id,
      weights_bytes: v.weightsBytes,
      active_weights_bytes: v.activeWeightsBytes,
    })),
    p_n_layers: args.architecture.nLayers,
    p_n_kv_heads: args.architecture.nKvHeads,
    p_head_dim: args.architecture.headDim,
    p_context_length: args.contextLength,
    p_target_tokens_per_second: args.targetTokensPerSecond,
    p_kv_dtype_bytes: args.kvDtypeBytes ?? 2,
    p_n_attention_layers: args.architecture.nAttentionLayers,
    p_ssm_state_bytes_per_seq: args.architecture.ssmStateBytesPerSeq,
    // Lets the solver report each variant's own context ceiling for the
    // consequence table's "Max context" column, instead of this file dividing
    // a KV budget and inventing a second answer.
    p_ceiling_context: args.architecture.maxPositionEmbeddings,
  });

  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];

  return data
    .filter((row): row is Json => typeof row === "object" && row !== null)
    .map((row) => ({
      variantId: str(row, "variant_id"),
      placement: toPlacement(row.placement),
      maxContext:
        typeof row.max_context === "number"
          ? row.max_context
          : typeof row.max_context === "string"
            ? Number(row.max_context)
            : null,
    }));
}

/**
 * The remedies a creator can actually press (FR-STU-004d, §4.3.3.5).
 *
 * Every one carries the VALUE it would apply, because "reduce the context
 * window" is advice and "reduce it to 47,104 tokens" is a remedy. Each is
 * derived from the solver's own infeasibility envelope — `max_context_at_this_
 * quality` and `fastest_available_tokens_per_second` are computed by the
 * solver precisely so the UI does not have to search for them.
 */
export type Remedy =
  | { kind: "context"; label: string; value: number }
  | { kind: "speed"; label: string; value: number }
  | { kind: "variant"; label: string; value: string };

export function remediesFor(
  placement: Placement,
  requested: { contextLength: number; targetTokensPerSecond: number },
  /** Variants that ARE feasible right now, cheapest-quality first. */
  feasibleAlternatives: { id: string; qualityLabel: string }[],
): Remedy[] {
  if (placement.feasible) return [];
  const out: Remedy[] = [];

  if (
    placement.maxContextAtThisQuality > 0 &&
    placement.maxContextAtThisQuality < requested.contextLength
  ) {
    out.push({
      kind: "context",
      label: `Reduce context to ${placement.maxContextAtThisQuality.toLocaleString("en-US")}`,
      value: placement.maxContextAtThisQuality,
    });
  }

  if (
    placement.fastestAvailableTokensPerSecond > 0 &&
    placement.fastestAvailableTokensPerSecond < requested.targetTokensPerSecond
  ) {
    out.push({
      kind: "speed",
      label: `Accept ${Math.round(placement.fastestAvailableTokensPerSecond)} tok/s`,
      value: Math.round(placement.fastestAvailableTokensPerSecond),
    });
  }

  for (const alt of feasibleAlternatives.slice(0, 2)) {
    out.push({
      kind: "variant",
      label: `Use ${alt.qualityLabel} instead`,
      value: alt.id,
    });
  }

  return out;
}
