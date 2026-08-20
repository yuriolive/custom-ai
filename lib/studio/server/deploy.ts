import "server-only";

/**
 * The deployment pipeline — FR-STU-007, FR-STU-008, FR-DEP-050…052.
 *
 * Five stages, each of which writes `custom_models.status` before it starts, so
 * the stepper in the browser is watching real state over Realtime rather than
 * an animation on a timer:
 *
 *   validating     re-probe HF with the token, confirm the variant still exists
 *   provisioning   resolve placement, build the pool reference
 *   smoke_testing  generate real tokens, measure throughput
 *   ready          measured value written; the model is callable
 *   failed         the upstream's own error, verbatim, plus a remediation hint
 *
 * THE PLACEMENT IS RESOLVED AGAIN HERE, server-side, and the row is written
 * from THAT result rather than from anything the browser sent. FR-DEP-050 is
 * the reason: the Studio preview and the deploy path must call one solver, and
 * a placement accepted from a client would be a creator-supplied throughput
 * claim wearing the platform's badge. The preview's numbers are a preview.
 *
 * VISIBILITY IS NOT AN INPUT EITHER, since #29. The row is born `private` and
 * `isPublic` is a REQUEST; the licence gate grants it in the same statement that
 * writes `ready`, or holds it and says which of §5.1's four cases the listing is
 * in. A held listing is a working deployment that is not in the catalog — never
 * a failed one, because "we cannot establish what these weights permit" is not
 * something the creator did wrong.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CommercialHosting } from "@nexus/hf-probe";
import { resolveToolSupport } from "@nexus/hf-probe";
import { resolveBaseModel } from "./base-model";

import { evaluateLicenseGate, type LicenseHold } from "../license";
import { toPlacement } from "../placement";
import type { DeployRequest, Placement, ProbeSuccess, StudioVariant } from "../types";
import { probeForStudio, redact } from "./probe";
import { buildUpstreamRef, readUpstreamConfig, smokeTest } from "./upstream";

/**
 * Which stage broke. Carried explicitly because `status` collapses to `failed`
 * and the stepper cannot otherwise tell a repository that would not validate
 * from a worker that would not generate — and it must not guess, because the
 * two have completely different remedies.
 */
export type DeployStage = "validating" | "provisioning" | "smoke_testing";

/**
 * What the licence gate did with this listing (#29, §5.1).
 *
 * Reported on SUCCESS, not as a failure: a listing the gate holds back is a
 * working, callable, billed deployment — it is simply not in the catalog. The
 * creator asked for two things and got one, and this is the half they did not
 * get, in the shape the form renders.
 */
export interface LicenseGateOutcome {
  hosting: CommercialHosting;
  /** The licence text in force, as `base_models` identifies it. */
  termsVersion: string | null;
  published: boolean;
  /** Null when nothing was held: the creator either got public or never asked. */
  hold: LicenseHold | null;
  message: string | null;
  hint: string | null;
  /** True while the listing sits in the operator review queue. */
  awaitingReview: boolean;
}

export type DeployOutcome =
  | {
      ok: true;
      modelId: string;
      slug: string;
      measuredTokensPerSecond: number;
      visibility: "public" | "private";
      license: LicenseGateOutcome;
    }
  | {
      ok: false;
      code: string;
      message: string;
      hint: string;
      modelId: string | null;
      stage: DeployStage;
    };

/** How long the smoke test may take, including a cold start. */
function smokeTimeoutMs(coldStartBudgetS: number): number {
  return Math.min(300, Math.max(90, coldStartBudgetS)) * 1000 + 60_000;
}

/**
 * Ask the ONE solver. Called twice on this path — once per candidate tier
 * during escalation — and never reimplemented.
 */
async function resolve(
  admin: SupabaseClient,
  args: {
    variant: StudioVariant;
    probe: ProbeSuccess;
    contextLength: number;
    targetTokensPerSecond: number;
    pinTierId?: string | null;
  },
): Promise<Placement> {
  const arch = args.probe.architecture!;
  const { data, error } = await admin.rpc("resolve_placement", {
    p_weights_bytes: args.variant.weightsBytes,
    p_active_weights_bytes: args.variant.activeWeightsBytes,
    p_n_layers: arch.nLayers,
    p_n_kv_heads: arch.nKvHeads,
    p_head_dim: arch.headDim,
    p_context_length: args.contextLength,
    p_target_tokens_per_second: args.targetTokensPerSecond,
    p_kv_dtype_bytes: 2,
    p_pin_tier_id: args.pinTierId ?? null,
    p_n_attention_layers: arch.nAttentionLayers,
    p_ssm_state_bytes_per_seq: arch.ssmStateBytesPerSeq,
  });
  if (error) throw new Error(`resolve_placement: ${error.message}`);
  return toPlacement(data);
}

async function setStatus(
  admin: SupabaseClient,
  modelId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("custom_models").update(patch).eq("id", modelId);
  if (error) throw new Error(`status update failed: ${error.message}`);
}

/**
 * Terminal failure. The row is left in `failed` carrying BOTH the upstream's
 * own message and a plain-language remediation hint (FR-STU-008) — the two are
 * separate columns because they are separate things, and collapsing them loses
 * the verbatim text that is the only thing an operator can search for.
 *
 * `auth_failed` rather than `failed` when the credential is what broke, because
 * FR-DEP-016 gives that state its own meaning and its own recovery.
 */
async function failModel(
  admin: SupabaseClient,
  modelId: string,
  code: string,
  message: string,
  hint: string,
  stage: DeployStage,
  opts: { authFailure?: boolean } = {},
): Promise<DeployOutcome> {
  const safeMessage = redact(message);
  // The status write can itself be what failed, so this must not throw on top
  // of the failure it is recording — that would replace a specific, actionable
  // message with a generic one at the route boundary.
  try {
    await setStatus(admin, modelId, {
      status: opts.authFailure ? "auth_failed" : "failed",
      provisioning_error: {
        code,
        stage,
        message: safeMessage,
        at: new Date().toISOString(),
      },
      remediation_hint: redact(hint),
      last_error_at: new Date().toISOString(),
    });
  } catch (cause) {
    console.error(
      `[studio] model ${modelId} failed at ${stage} and the failure could not be recorded:`,
      cause instanceof Error ? cause.message : cause,
    );
  }
  return { ok: false, code, message: safeMessage, hint: redact(hint), modelId, stage };
}

/**
 * Run the whole pipeline.
 *
 * `userId` comes from a verified session cookie in the route handler and never
 * from the request body — `admin` bypasses RLS, so this argument is the only
 * thing standing between a creator and somebody else's namespace.
 */
export async function runDeployment(
  admin: SupabaseClient,
  session: SupabaseClient,
  userId: string,
  request: DeployRequest,
): Promise<DeployOutcome> {
  const config = readUpstreamConfig();

  // ── Stage 0: probe before anything is written ────────────────────────────
  // Nothing exists yet, so a bad repo produces no row to clean up. This is also
  // FR-DEP-006: a token that does not actually grant read access fails here,
  // at form time, rather than 100 seconds into the first cold start.
  const probe = await probeForStudio(session, request.hfRepoSlug, {
    revision: request.hfRevision,
    ...(request.hfToken ? { hfToken: request.hfToken } : {}),
  });

  if (!probe.ok) {
    return {
      ok: false,
      code: probe.code,
      message: probe.message,
      hint: "Correct the repository or the token and try again. Nothing was created.",
      modelId: null,
      stage: "validating",
    };
  }

  const variant = probe.variants.find((v) => v.id === request.variantId);
  if (!variant?.deployable) {
    return {
      ok: false,
      code: "variant_not_found",
      message: `The selected quality variant is no longer present in ${probe.repoSlug}.`,
      hint: "The repository changed since the form was filled in. Re-probe it and pick a variant again.",
      modelId: null,
      stage: "validating",
    };
  }

  const arch = probe.architecture!;
  const ceiling = arch.maxPositionEmbeddings;
  if (ceiling !== null && request.contextLength > ceiling) {
    // Also a schema CHECK (custom_models_context_within_arch). Caught here so
    // the creator gets a sentence instead of a constraint-violation string.
    return {
      ok: false,
      code: "context_above_architecture",
      message: `This model supports at most ${ceiling.toLocaleString("en-US")} tokens of context; ${request.contextLength.toLocaleString("en-US")} was requested.`,
      hint: `Lower the context window to ${ceiling.toLocaleString("en-US")} or less.`,
      modelId: null,
      stage: "validating",
    };
  }

  // ── Stage 0b: placement, from the one solver ─────────────────────────────
  const placement = await resolve(admin, {
    variant,
    probe,
    contextLength: request.contextLength,
    targetTokensPerSecond: request.targetTokensPerSecond,
  });

  if (!placement.feasible) {
    return {
      ok: false,
      code: "infeasible",
      message: placement.blockingReason,
      hint: "Adjust the context window, the minimum speed, or the quality variant until the Deployment Plan resolves.",
      modelId: null,
      stage: "provisioning",
    };
  }

  // ── Stage 0c: slug, allocated under the caller's own namespace ───────────
  const { data: slugData, error: slugError } = await session.rpc("next_available_slug", {
    p_base: request.displayName,
  });
  if (slugError || typeof slugData !== "string") {
    return {
      ok: false,
      code: "slug_allocation_failed",
      message: slugError?.message ?? "Could not derive a URL slug from that name.",
      hint: "Try a different display name.",
      modelId: null,
      stage: "validating",
    };
  }
  const slug = slugData;

  // ── Stage 0d: the token goes into Vault, never into a column ────────────
  let hfTokenSecretId: string | null = null;
  if (request.hfToken) {
    const { data, error } = await admin.rpc("studio_store_hf_token", {
      p_token: request.hfToken,
      p_label: `hf read token for ${probe.repoSlug}`,
    });
    if (error || typeof data !== "string") {
      return {
        ok: false,
        code: "vault_unavailable",
        message: error?.message ?? "The credential store did not return a secret id.",
        hint: "supabase_vault must be installed for private or gated repositories. A public repository needs no token.",
        modelId: null,
        stage: "validating",
      };
    }
    hfTokenSecretId = data;
  }

  // ── Stage 0e: does this model's chat template do tools? (FR-TOOL-003) ────
  // Measured, once, here — the gateway reads the column on every request and
  // must never make a network call to answer it. `supported: null` (no readable
  // template) is written as NULL and means UNKNOWN: the gateway forwards tools
  // on it and refuses only a measured false. Never fatal: a repository that will
  // not yield a template is still deployable, just not known to do tools.
  const toolSupport = await resolveToolSupport(probe.repoSlug, {
    revision: probe.revision,
    ...(request.hfToken ? { hfToken: request.hfToken } : {}),
    // The GGUF key is the only source for a llama.cpp-native repo, which ships
    // no tokenizer_config.json at all. Read the variant actually being served.
    ggufFile: probe.weightsFormat === "gguf" ? (variant.files[0] ?? null) : null,
  });

  // ── Stage 0f: WHICH MODEL is this, and under whose licence? (#25) ────────
  // Resolved before the insert so the pointer and its audit trail land in the
  // same row write rather than as a second update the stepper would see flicker
  // through. Never fatal: `resolveBaseModel` degrades to a null pointer with a
  // recorded reason, because the gateway does not read this column and an
  // ungrouped listing still resolves, streams and bills.
  const baseModel = await resolveBaseModel(admin, {
    // Candidates are read as the creator (RLS), written as the platform.
    reader: session,
    repoSlug: probe.repoSlug,
    architecture: arch,
    license: probe.baseModel.license,
    // The probe's own reading of the repo's declarations — this is not taken
    // from the request, so a creator cannot claim somebody else's weights.
    declared: probe.baseModel.declared ? [probe.baseModel.declared] : [],
    userId,
    // A repository that declares its own parent is authoritative about it, so a
    // creator's answer is only consulted when nothing was declared.
    choice: probe.baseModel.declared ? null : (request.baseModelChoice ?? null),
    ...(request.hfToken ? { hfToken: request.hfToken } : {}),
  });

  // ── Stage 1: the row exists, in `validating` ─────────────────────────────
  const { data: inserted, error: insertError } = await admin
    .from("custom_models")
    .insert({
      user_id: userId,
      slug,
      display_name: request.displayName,
      description: request.description || null,
      hf_repo_slug: probe.repoSlug,
      hf_revision: probe.revision,
      // llama.cpp resolves a FILE and vLLM resolves a repo (FR-DEP-061). The
      // served name follows the runtime rather than being guessed once.
      served_model_name: probe.repoSlug,
      weights_format: probe.weightsFormat,
      runtime: probe.runtime,
      variant_quant_tag: variant.quantTag,
      variant_family: variant.family,
      variant_files: variant.files,
      companion_assets: Object.fromEntries(probe.companions.map((c) => [c.role, c.file])),
      weights_bytes: variant.weightsBytes,
      active_weights_bytes: variant.activeWeightsBytes,
      n_layers: arch.nLayers,
      n_attention_layers: arch.nAttentionLayers,
      n_kv_heads: arch.nKvHeads,
      head_dim: arch.headDim,
      kv_dtype_bytes: 2,
      max_position_embeddings: arch.maxPositionEmbeddings,
      ssm_state_bytes_per_seq: arch.ssmStateBytesPerSeq,
      context_length: request.contextLength,
      // The ceiling was READ, not defaulted (FR-DEP-005).
      context_verified: arch.maxPositionEmbeddings !== null,
      target_tokens_per_second: request.targetTokensPerSecond,
      hf_token_secret_id: hfTokenSecretId,
      requires_hf_auth: hfTokenSecretId !== null,
      price_prompt_micro_usd_per_mtoken: request.pricePromptMicro,
      price_completion_micro_usd_per_mtoken: request.priceCompletionMicro,
      // Three-state on purpose. NULL is "template unreadable", not "no tools".
      supports_tools: toolSupport.supported,
      // Catalog grouping only (#24's columns, #25's writer). Null means the
      // listing is its own card until somebody resolves it.
      base_model_id: baseModel.baseModelId,
      base_model_match: baseModel.match,
      // PRIVATE AT BIRTH, whatever was asked for (#29). Two reasons, and the
      // second is the load-bearing one:
      //
      //   1. Nothing should be in the catalog while it is still validating.
      //   2. Whether it may be public at all is not knowable until the row
      //      exists: `license_hosting` is written by a trigger from the base
      //      model resolved above, so the verdict is read BACK off the insert
      //      rather than computed a second time here. Inserting `public`
      //      optimistically would fail the whole deployment on a constraint
      //      violation for something that is not an error — a listing whose
      //      licence needs a human is still a working listing.
      visibility: "private",
      // The request the gate may have to hold. `license_review_queue` is
      // exactly this column plus an unknown verdict, which is what keeps the
      // queue to creators who are actually waiting on us.
      license_public_requested_at: request.isPublic ? new Date().toISOString() : null,
      status: "validating",
    })
    .select("id, license_hosting, license_terms_version")
    .single();

  if (insertError || !inserted) {
    // The Vault secret was created before the row that would own it. Nothing
    // else references it, so it is destroyed rather than left orphaned holding
    // a live credential.
    if (hfTokenSecretId) {
      await admin.rpc("studio_destroy_hf_token", { p_secret_id: hfTokenSecretId });
    }
    const duplicate = insertError?.code === "23505";
    return {
      ok: false,
      code: duplicate ? "slug_taken" : "insert_failed",
      message: insertError?.message ?? "The model row could not be created.",
      hint: duplicate
        ? "You already have a model at that URL. Choose a different display name."
        : "Nothing was created. This is usually a schema constraint — the message above names it.",
      modelId: null,
      stage: "validating",
    };
  }

  const modelId = inserted.id as string;

  // The verdict, as the DATABASE computed it — the strictest reading over the
  // resolved base model and its ancestors, which no amount of reading the
  // repository's own card would tell us. `license_governing` is the only
  // definition of it and this is the same value the CHECK will be applied to.
  const licenseGate = evaluateLicenseGate({
    hosting: (inserted.license_hosting ?? "unknown") as CommercialHosting,
    termsVersion: (inserted.license_terms_version ?? null) as string | null,
    wantsPublic: request.isPublic,
    acknowledgedVersion: request.licenseAckVersion ?? null,
  });

  // Where an unexpected throw happened, for the stepper's marker.
  let stage: DeployStage = "validating";

  try {
    // ── Stage 2: provisioning — snapshot the placement, name the pool ──────
    stage = "provisioning";
    await setStatus(admin, modelId, { status: "provisioning" });

    const ref = buildUpstreamRef(config, {
      hfRepoSlug: probe.repoSlug,
      variantFile: variant.files[0] ?? "",
      contextLength: request.contextLength,
      // The worker's slot count IS the solver's concurrency ceiling. Asking for
      // more slots than the KV budget allows makes llama.cpp allocate a cache
      // it cannot fit and fail at load, well after the form said "ready".
      parallel: Math.max(1, placement.maxConcurrentStreams),
    });

    if (!ref.ok) {
      return await failModel(admin, modelId, "no_upstream", ref.message, ref.hint, "provisioning");
    }

    await setStatus(admin, modelId, applyPlacement(placement, ref.ref));

    // ── Stage 3: smoke test — MEASURE, do not predict (FR-DEP-052) ────────
    stage = "smoke_testing";
    await setStatus(admin, modelId, { status: "smoke_testing" });

    let smoke = await smokeTest(config, ref.ref, probe.repoSlug, {
      timeoutMs: smokeTimeoutMs(placement.coldStartBudgetS),
    });

    if (!smoke.ok) {
      return await failModel(
        admin,
        modelId,
        "smoke_test_failed",
        smoke.message,
        smoke.hint,
        "smoke_testing",
        // A 401/403 from the upstream on a gated repo is a credential problem,
        // and FR-DEP-016 gives that its own status and its own recovery.
        { authFailure: /401|403/.test(smoke.message) && Boolean(hfTokenSecretId) },
      );
    }

    // ── Stage 3b: escalation, once (FR-DEP-052) ──────────────────────────
    // measured >= 0.90 x target -> ready. Below it, escalate to the next tier
    // the solver predicts will meet target and retry ONCE. Either way the value
    // written is the MEASURED one; there is no branch that stores a prediction.
    const target = request.targetTokensPerSecond * 0.9;
    if (smoke.tokensPerSecond < target) {
      const escalation = await escalate(admin, {
        variant,
        probe,
        contextLength: request.contextLength,
        targetTokensPerSecond: request.targetTokensPerSecond,
        current: placement,
      });

      if (escalation) {
        const retryRef = buildUpstreamRef(config, {
          hfRepoSlug: probe.repoSlug,
          variantFile: variant.files[0] ?? "",
          contextLength: request.contextLength,
          parallel: Math.max(1, escalation.maxConcurrentStreams),
        });
        if (retryRef.ok) {
          await setStatus(admin, modelId, applyPlacement(escalation, retryRef.ref));
          const retry = await smokeTest(config, retryRef.ref, probe.repoSlug, {
            timeoutMs: smokeTimeoutMs(escalation.coldStartBudgetS),
          });
          // A failed retry is not a failed deployment: the first measurement
          // was real and the model serves. Keep the original placement.
          if (retry.ok && retry.tokensPerSecond > smoke.tokensPerSecond) {
            // The escalated placement is ALREADY on the row — it was written by
            // the setStatus above. There is deliberately no local assignment
            // here: nothing downstream reads `placement` again, and a variable
            // that looks live but is not is worse than no variable.
            smoke = retry;
          } else {
            await setStatus(admin, modelId, applyPlacement(placement, ref.ref));
          }
        }
      }
    }

    // ── Stage 4: ready, with the number that was actually measured ────────
    const measured = Math.max(1, Math.round(smoke.tokensPerSecond));
    const missedTarget = measured < request.targetTokensPerSecond * 0.9;

    // Publication happens HERE and nowhere earlier: in the same statement that
    // makes the model callable, so a listing is never in the catalog without a
    // measured speed, and never public without the acknowledgement the CHECK
    // will look for on the same row version.
    const publishPatch = licenseGate.publish
      ? {
          visibility: "public",
          license_public_requested_at: null,
          ...(licenseGate.ackVersion
            ? {
                license_ack_at: new Date().toISOString(),
                // The version the PLATFORM established, never the string the
                // client sent — `evaluateLicenseGate` only returns one when the
                // two already agree.
                license_ack_version: licenseGate.ackVersion,
              }
            : {}),
        }
      : {};

    await setStatus(admin, modelId, {
      ...publishPatch,
      status: "ready",
      measured_tokens_per_second: measured,
      ready_at: new Date().toISOString(),
      provisioning_error: null,
      // Not an error, so it is not a `failed` state — but the creator asked for
      // a speed the hardware did not deliver and is entitled to be told, rather
      // than discovering it from their own model card (FR-DEP-052).
      remediation_hint: missedTarget
        ? `Measured ${measured} tok/s against a target of ${request.targetTokensPerSecond}. ` +
          `No faster tier both fits this model and meets the target, so it is deployed at its ` +
          `real speed. Lowering the context window or stepping down a quality level is what buys speed here.`
        : null,
    });

    return {
      ok: true,
      modelId,
      slug,
      measuredTokensPerSecond: measured,
      visibility: licenseGate.publish ? "public" : "private",
      license: {
        hosting: (inserted.license_hosting ?? "unknown") as CommercialHosting,
        termsVersion: (inserted.license_terms_version ?? null) as string | null,
        published: licenseGate.publish,
        hold: licenseGate.hold,
        message: licenseGate.message,
        hint: licenseGate.hint,
        // The queue holds requests the OPERATOR can resolve. A conditional
        // licence waiting on the creator's acknowledgement is not one of them.
        awaitingReview: licenseGate.hold === "terms_unknown",
      },
    };
  } catch (cause) {
    return await failModel(
      admin,
      modelId,
      "internal_error",
      cause instanceof Error ? cause.message : "The deployment failed.",
      "This is a platform-side failure rather than something wrong with the repository. The model was not made callable.",
      stage,
    );
  }
}

/** Solver output -> the columns that snapshot it (FR-DEP-051). */
function applyPlacement(
  placement: Extract<Placement, { feasible: true }>,
  ref: string,
): Record<string, unknown> {
  return {
    upstream_endpoint_ref: ref,
    gpu_tier_id: placement.gpuTierId,
    gpu_usd_per_hour_micro_snapshot: placement.usdPerHourMicro,
    predicted_tokens_per_second: placement.predictedTokensPerSecond,
    max_concurrent_streams: placement.maxConcurrentStreams,
    kv_bytes_per_token: placement.kvBytesPerToken,
    cost_floor_micro_per_mtoken: placement.costFloorMicroPerMtoken,
    cold_start_budget_s: placement.coldStartBudgetS,
    volume_gb: placement.volumeGb,
    // The FULL solver envelope, so "why this GPU?" stays answerable after a
    // later tier-config change (FR-DEP-051).
    placement_rationale: placement,
  };
}

/**
 * The next tier the solver predicts WILL meet target, pinned.
 *
 * The candidate list comes from the solver's own `considered` array rather than
 * from a hard-coded tier order, because the tier list is not a ladder: an L40S
 * has twice a 4090's VRAM and LESS bandwidth, so "the next tier up" by size can
 * be slower. Only tiers that both fit and predict above target are candidates,
 * and the cheapest of those wins — which is `resolve_placement`'s own rule,
 * applied to a filtered set rather than restated.
 */
async function escalate(
  admin: SupabaseClient,
  args: {
    variant: StudioVariant;
    probe: ProbeSuccess;
    contextLength: number;
    targetTokensPerSecond: number;
    current: Extract<Placement, { feasible: true }>;
  },
): Promise<Extract<Placement, { feasible: true }> | null> {
  const candidates = args.current.considered
    .filter(
      (t) =>
        t.requiredBytes > 0 &&
        t.tier !== args.current.gpuTierId &&
        t.predictedTokensPerSecond > args.current.predictedTokensPerSecond &&
        t.predictedTokensPerSecond >= args.targetTokensPerSecond,
    )
    .toSorted((a, b) => a.predictedTokensPerSecond - b.predictedTokensPerSecond);

  for (const candidate of candidates) {
    const pinned = await resolve(admin, {
      variant: args.variant,
      probe: args.probe,
      contextLength: args.contextLength,
      targetTokensPerSecond: args.targetTokensPerSecond,
      pinTierId: candidate.tier,
    });
    if (pinned.feasible) return pinned;
  }
  return null;
}
