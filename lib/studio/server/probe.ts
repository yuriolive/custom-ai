import "server-only";

/**
 * Server-side Hugging Face probe.
 *
 * WHY THIS IS A SERVER ROUTE and not a browser fetch, which is the question
 * CONTRACTS.md §Frontend / auth contract makes you ask of every call:
 *
 *   1. huggingface.co sends no CORS headers for the model API, so the browser
 *      cannot read the response at all.
 *   2. The GGUF header read is an HTTP Range request over a redirect chain to a
 *      CDN — again, not readable cross-origin.
 *   3. An HF token is a bearer credential over the creator's ENTIRE private
 *      namespace (FR-DEP-032's framing). It must reach exactly one place, and a
 *      browser that holds it in component state has already put it in a devtools
 *      network tab.
 *
 * The probe itself is `@nexus/hf-probe`, unmodified — 65 tests, the committed
 * adversarial fixture, and the variant/family/role rules that keep a 3 GB draft
 * model from being offered as a servable 27B. Nothing here reclassifies
 * anything; this module maps the result onto a serializable shape and asks
 * Postgres for the one derived number it needs.
 */

import { probeRepo, type HfProbeResult, type ModelVariant } from "@nexus/hf-probe";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ProbeFailure,
  ProbeResponse,
  StudioArchitecture,
  StudioVariant,
} from "../types";
import { fetchCardDescription } from "./model-card";

/** FR-DEP-001, character for character. */
export const HF_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** FR-DEP-013's redaction pattern. Applied to every message that leaves here. */
const HF_TOKEN_RE = /hf_[A-Za-z0-9]{20,}/g;

/**
 * Nothing from this module reaches a client without passing through here.
 *
 * The probe's own error strings can quote a URL, and a token supplied as a
 * query parameter by a future change would ride along inside it. Redacting at
 * the boundary costs one regex and does not depend on every upstream message
 * staying clean.
 */
export function redact(message: string): string {
  return message.replace(HF_TOKEN_RE, "hf_***");
}

function fail(
  code: ProbeFailure["code"],
  message: string,
  flags: { requiresAuth?: boolean; isPrivate?: boolean; isGated?: boolean } = {},
): ProbeFailure {
  return {
    ok: false,
    code,
    message: redact(message),
    requiresAuth: flags.requiresAuth ?? false,
    isPrivate: flags.isPrivate ?? false,
    isGated: flags.isGated ?? false,
  };
}

function toStudioVariant(v: ModelVariant): StudioVariant {
  return {
    id: v.id,
    quantTag: v.quantTag,
    family: v.family,
    qualityLabel: v.qualityLabel,
    bitsPerWeight: v.bitsPerWeight,
    weightsBytes: v.weightsBytes,
    activeWeightsBytes: v.activeWeightsBytes,
    files: v.files,
    deployable: v.deployable,
    excludedReason: v.excludedReason ? redact(v.excludedReason) : null,
  };
}

/**
 * The default selection (FR-STU-004a): Q4_K_M-class, else the repo's only
 * variant, else the one nearest 4.8 bits-per-weight.
 *
 * Restricted to the BASE family. Families are different models (FR-DEP-041b)
 * and the probe reads its architecture from the base family, so defaulting
 * into another family would pair one model's geometry with another's weights.
 */
function recommend(variants: StudioVariant[]): string | null {
  const base = variants.filter((v) => v.deployable && v.family === null);
  const pool = base.length > 0 ? base : variants.filter((v) => v.deployable);
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0]!.id;

  const exact = pool.find((v) => v.quantTag?.toUpperCase() === "Q4_K_M");
  if (exact) return exact.id;

  const rated = pool.filter((v) => v.bitsPerWeight !== null);
  if (rated.length === 0) return pool[0]!.id;

  return rated.reduce((best, v) =>
    Math.abs((v.bitsPerWeight ?? 0) - 4.8) < Math.abs((best.bitsPerWeight ?? 0) - 4.8)
      ? v
      : best,
  ).id;
}

/**
 * Per-sequence SSM state, from `public.calc_ssm_state_bytes()`.
 *
 * The formula is NOT restated here. It lives in migration 20260817001700
 * alongside the solver that consumes it, and this asks that function for the
 * answer. A model with no SSM blocks gets 0 from the same call — the function
 * returns 0 for null geometry, so there is no branch to get wrong.
 */
async function ssmStateBytes(
  supabase: SupabaseClient,
  arch: HfProbeResult["architecture"],
): Promise<number> {
  if (!arch?.ssm) return 0;
  const nSsmLayers = arch.nLayers - arch.nAttentionLayers;
  if (nSsmLayers <= 0) return 0;

  const { data, error } = await supabase.rpc("calc_ssm_state_bytes", {
    p_n_ssm_layers: nSsmLayers,
    p_state_size: arch.ssm.stateSize,
    p_inner_size: arch.ssm.innerSize,
    p_group_count: arch.ssm.groupCount,
    p_conv_kernel: arch.ssm.convKernel,
    p_dtype_bytes: 2,
  });

  if (error) throw new Error(`calc_ssm_state_bytes: ${error.message}`);
  const n = typeof data === "string" ? Number(data) : data;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Probe a repo and return something a client component can render.
 *
 * `supabase` is used for exactly one derived number (above). It is the caller's
 * session client, not the service role — this function reads no table.
 *
 * When `hfToken` is supplied the probe runs WITH it, which is FR-DEP-006: a
 * token that does not actually grant read access must fail here, at form time,
 * rather than 100 seconds into a cold start.
 */
export async function probeForStudio(
  supabase: SupabaseClient,
  slug: string,
  opts: { revision?: string; hfToken?: string; signal?: AbortSignal } = {},
): Promise<ProbeResponse> {
  const trimmed = slug.trim();
  if (!HF_SLUG_RE.test(trimmed)) {
    return fail(
      "invalid_slug",
      "Enter a repository as owner/name — for example JonathanColetti/Qwen3.8-27B-Uncensored-GGUF.",
    );
  }

  const hadToken = Boolean(opts.hfToken);
  let result: HfProbeResult;
  try {
    result = await probeRepo(trimmed, {
      revision: opts.revision?.trim() || "main",
      ...(opts.hfToken ? { hfToken: opts.hfToken } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (cause) {
    return fail(
      "upstream_error",
      cause instanceof Error ? cause.message : "The Hugging Face probe failed.",
    );
  }

  // ── Reachability ────────────────────────────────────────────────────────
  // The Hub returns 404 for a private repo as well as a missing one, so with a
  // token already supplied a 404 means the token does not grant access — a
  // different remedy from "check the spelling", and the creator has to be told
  // which one applies.
  if (!result.exists) {
    if (hadToken) {
      return fail(
        "token_rejected",
        "That token does not grant access to this repository. Check that it is a read token on an account with access.",
        { requiresAuth: true, isPrivate: true },
      );
    }
    return fail(
      "not_found",
      `${trimmed} was not found. If it is private or gated, add a Hugging Face token below.`,
      { requiresAuth: true },
    );
  }

  if (result.isGated && !hadToken) {
    return fail(
      "gated",
      "This repository is gated. A token from an account that has been granted access is required.",
      { requiresAuth: true, isGated: true },
    );
  }

  if (result.isPrivate && !hadToken) {
    return fail(
      "requires_auth",
      "This repository is private. A read token with access to it is required.",
      { requiresAuth: true, isPrivate: true },
    );
  }

  // ── Deployable weights (FR-DEP-045) ─────────────────────────────────────
  const variants = result.variants.map(toStudioVariant);
  if (!variants.some((v) => v.deployable)) {
    return fail(
      "no_deployable_variant",
      result.architectureError ??
        "This repository has no deployable weights. GGUF or safetensors files are required.",
      { isPrivate: result.isPrivate, isGated: result.isGated },
    );
  }

  // ── Architecture (FR-DEP-043 path 3: reject, never guess) ───────────────
  if (!result.architecture) {
    return fail(
      "unknown_architecture",
      result.architectureError ??
        "The model's memory profile could not be read from config.json or the GGUF header, so its capacity cannot be planned.",
      { isPrivate: result.isPrivate, isGated: result.isGated },
    );
  }

  // The card read and the SSM figure are independent, so they run together
  // rather than one after the other. The card is advisory and cannot fail the
  // probe — `fetchCardDescription` resolves to null instead of throwing.
  const [ssmBytes, suggestedDescription] = await Promise.all([
    ssmStateBytes(supabase, result.architecture),
    fetchCardDescription(trimmed, result.revision, {
      ...(opts.hfToken ? { hfToken: opts.hfToken } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  ]);

  const arch = result.architecture;
  const architecture: StudioArchitecture = {
    nLayers: arch.nLayers,
    nAttentionLayers: arch.nAttentionLayers,
    nKvHeads: arch.nKvHeads,
    headDim: arch.headDim,
    maxPositionEmbeddings: arch.maxPositionEmbeddings,
    ssmStateBytesPerSeq: ssmBytes,
    architecture: arch.architecture,
    source: arch.source,
  };

  // Base family first — it is the one whose geometry was read.
  const families = [
    ...new Set(variants.filter((v) => v.deployable).map((v) => v.family)),
  ].toSorted((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));

  return {
    ok: true,
    repoSlug: trimmed,
    revision: result.revision,
    requiresAuth: result.isPrivate || result.isGated,
    isPrivate: result.isPrivate,
    isGated: result.isGated,
    tokenVerified: hadToken,
    weightsFormat: result.weightsFormat,
    runtime: result.runtime,
    libraryName: result.libraryName,
    variants,
    families,
    companions: result.companions.map((c) => ({
      role: c.role,
      file: c.file,
      sizeBytes: c.sizeBytes,
    })),
    architecture,
    architectureError: null,
    recommendedVariantId: recommend(variants),
    suggestedDescription,
  };
}
