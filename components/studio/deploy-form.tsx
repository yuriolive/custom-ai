"use client";

/**
 * The deployment form — FR-STU-001 … FR-STU-007.
 *
 * ── THE ONE THING TO UNDERSTAND ABOUT THIS FORM ────────────────────────────
 *
 * THERE IS NO GPU SELECTOR, AND ITS ABSENCE IS THE DESIGN. The creator states
 * three intents — quality, context window, minimum speed — and the platform
 * resolves hardware. PRD §4.3.3.3 has the argument: the tier list is not a
 * ladder. An L40S has twice a 4090's VRAM and LESS memory bandwidth (864 vs
 * 1008 GB/s), so on the MVP's own target model "upgrading" to it makes the
 * model slower AND twice as expensive. No creator should be expected to know
 * that, and any UI that presents tiers as an ordered list actively misleads.
 *
 * So: intent in, hardware out, and the only place hardware is ever named is the
 * read-only Deployment Plan on the right.
 *
 * ── Where the numbers come from ────────────────────────────────────────────
 *
 * Every capacity figure on this page is `resolve_placement()`'s output, fetched
 * through `resolvePlacements()`. This component contains no capacity
 * arithmetic, and adding some would recreate exactly the drift FR-DEP-050
 * exists to prevent — the form would promise a throughput the provisioned
 * endpoint does not deliver, on a public model card.
 */

import {
  Alert,
  Button,
  ComboBox,
  Description,
  FieldError,
  Form,
  Input,
  InputGroup,
  Label,
  ListBox,
  NumberField,
  Slider,
  Switch,
  TextArea,
  TextField,
  ToggleButton,
} from "@heroui/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { LabelHint } from "@/components/label-hint";

import {
  dollarsPerMtokenToMicro,
  formatContext,
  formatExactTokens,
  formatGiB,
  formatPricePerMtoken,
  microToDollarsPerMtoken,
  microUsdEcho,
  PRICE_FORMAT_OPTIONS,
} from "@/lib/studio/format";
import { remediesFor, resolvePlacements, type Remedy } from "@/lib/studio/placement";
import type {
  ModelStatus,
  Placement,
  ProbeFailure,
  ProbeResponse,
  ProbeSuccess,
  RefsResponse,
  VariantPlacement,
} from "@/lib/studio/types";
import { createClient } from "@/lib/supabase/client";

import { BaseModelStep, decodeBaseModelChoice } from "./base-model-step";
import {
  acknowledgeableTerms,
  LicenseGateOutcomeAlert,
  LicenseGateStep,
} from "./license-gate-step";
import { DeploymentPlan } from "./deployment-plan";
import { SummaryLayout } from "./primitives";
import { ProvisioningStepper } from "./provisioning-stepper";
import { feasibleAlternatives, VariantTable } from "./variant-table";

/** Context slider granularity. 2048 keeps 262,144 to 128 discrete steps. */
const CTX_STEP = 2048;
const CTX_MIN = 2048;
/** Used only until the probe reports the architecture's real ceiling. */
const CTX_FALLBACK_MAX = 32_768;

const SPEED_MIN = 10;
const SPEED_MAX = 200;
const SPEED_STEP = 5;

/** How long to wait after a slider stops moving before re-solving. */
const SOLVE_DEBOUNCE_MS = 220;

type Phase = "editing" | "deploying" | "done";

export function DeployForm() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const tokenFieldId = useId();

  // ── Source ───────────────────────────────────────────────────────────────
  const [repoSlug, setRepoSlug] = useState("");
  const [revision, setRevision] = useState("main");
  /**
   * Branches and tags for the current repo, once listed. Empty is the normal
   * pre-blur state AND the failure state — both fall back to a free-text field,
   * because a repository that will not list its refs must still be deployable.
   */
  const [refs, setRefs] = useState<{ branches: string[]; tags: string[] } | null>(null);
  /**
   * True once the creator has typed into Revision themselves. After that the
   * repository's default branch never overwrites their value — pinning a commit
   * SHA is the whole reason this field allows a custom value.
   */
  const [revisionTouched, setRevisionTouched] = useState(false);
  const [hfToken, setHfToken] = useState("");
  const [revealToken, setRevealToken] = useState(false);

  const [probe, setProbe] = useState<ProbeSuccess | null>(null);
  const [probeError, setProbeError] = useState<ProbeFailure | null>(null);
  const [isProbing, setProbing] = useState(false);
  /** True once the probe has said this repo needs a credential (FR-STU-003). */
  const [needsToken, setNeedsToken] = useState(false);

  // ── Identity ─────────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");

  // ── Intent. These three are the ONLY capacity inputs a human supplies. ────
  const [contextLength, setContextLength] = useState(8192);
  const [targetTokS, setTargetTokS] = useState(30);
  const [variantId, setVariantId] = useState<string | null>(null);

  // ── Distribution ─────────────────────────────────────────────────────────
  const [pricePrompt, setPricePrompt] = useState(0.5);
  const [priceCompletion, setPriceCompletion] = useState(1.5);
  /** Set the first time a price is edited. Nothing auto-fills a price after. */
  const [pricesTouched, setPricesTouched] = useState(false);
  const [isPublic, setPublic] = useState(true);
  // The creator's acceptance of a conditional licence's terms (#29). False is
  // the only safe initial value, and it is not "unanswered": a deployment with
  // it unchecked is a deliberate private one, which the alert says out loud.
  const [licenseAcknowledged, setLicenseAcknowledged] = useState(false);

  // Which base model the creator says this is (#25). Null until they answer, and
  // an answer is never required — see `BaseModelStep`.
  const [baseModelChoice, setBaseModelChoice] = useState<string | null>(null);

  // ── Solver output ────────────────────────────────────────────────────────
  const [placements, setPlacements] = useState<VariantPlacement[]>([]);
  const [isSolving, setSolving] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);

  // ── Submission ───────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("editing");
  const [modelId, setModelId] = useState<string | null>(null);
  const [deployStatus, setDeployStatus] = useState<ModelStatus | null>(null);
  const [deployError, setDeployError] = useState<{ message: string; hint: string } | null>(null);
  /** What the licence gate did. Null until the pipeline answers, and on failure. */
  const [licenseHold, setLicenseHold] = useState<{
    message: string | null;
    hint: string | null;
  } | null>(null);
  /** Which stage the server says broke, so the marker lands on the right one. */
  const [failedStage, setFailedStage] = useState<ModelStatus | null>(null);
  const [deployedSlug, setDeployedSlug] = useState<string | null>(null);

  const ctxMax = probe?.architecture?.maxPositionEmbeddings ?? CTX_FALLBACK_MAX;

  // ── Probe (FR-STU-002) ───────────────────────────────────────────────────
  //
  // On blur of the repo field, and again when a token is entered. Sequenced by
  // a request id so a slow probe of an old value cannot overwrite a fast probe
  // of the current one — the classic stale-response bug, and here it would show
  // one repository's variants under another repository's name.
  const probeSeq = useRef(0);

  const runProbe = useCallback(
    async (slug: string, rev: string, token: string) => {
      const trimmed = slug.trim();
      if (trimmed.length === 0) return;

      const seq = ++probeSeq.current;
      setProbing(true);
      setSolveError(null);
      // Clear the PREVIOUS verdict before asking again. Without this, a repo
      // that failed once keeps its red Alert on screen while the next probe is
      // in flight, so the form simultaneously reads "cannot be deployed" and
      // "reading the repository…" — observed, not hypothetical.
      setProbeError(null);

      try {
        const response = await fetch("/api/studio/probe", {
          body: JSON.stringify({
            repoSlug: trimmed,
            revision: rev.trim() || "main",
            ...(token ? { hfToken: token } : {}),
          }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const body = (await response.json()) as ProbeResponse;
        if (seq !== probeSeq.current) return;

        if (body.ok) {
          setProbe(body);
          setProbeError(null);
          setNeedsToken(body.requiresAuth);
          setVariantId(body.recommendedVariantId);
          // A different repository's candidates are a different question, so an
          // answer to the previous one is dropped rather than carried across.
          setBaseModelChoice(null);
          // And a different repository is a different LICENCE. Carrying an
          // acceptance across would record the creator accepting a document they
          // were never shown, which is the one thing an acknowledgement must
          // never be (#29).
          setLicenseAcknowledged(false);
          // FR-DEP-005: the architecture's ceiling caps the slider, and a value
          // already above it is pulled down rather than left invalid.
          const ceiling = body.architecture?.maxPositionEmbeddings ?? CTX_FALLBACK_MAX;
          setContextLength((current) => Math.min(current, ceiling));
          if (displayName.trim().length === 0) {
            setDisplayName(trimmed.split("/")[1] ?? trimmed);
          }
          // Prefill from the model card, but ONLY into an empty field: a probe
          // re-run after a token is entered must never overwrite prose the
          // creator has already written.
          if (body.suggestedDescription) {
            setDescription((current) =>
              current.trim().length === 0 ? body.suggestedDescription! : current,
            );
          }
        } else {
          setProbe(null);
          setPlacements([]);
          setProbeError(body);
          // The field appears because the probe SAID so, and the Alert above it
          // says why. A credential field that materialises unexplained reads as
          // a bug (docs/DESIGN.md §3.11).
          if (body.requiresAuth) setNeedsToken(true);
        }
      } catch {
        if (seq !== probeSeq.current) return;
        setProbe(null);
        setProbeError({
          ok: false,
          code: "upstream_error",
          message: "Could not reach the probe. Check your connection and try again.",
          requiresAuth: false,
          isPrivate: false,
          isGated: false,
        });
      } finally {
        if (seq === probeSeq.current) setProbing(false);
      }
    },
    [displayName],
  );

  // ── Refs, then probe (docs/UI-REDESIGN-PLAN.md §7.1) ─────────────────────
  //
  // ORDER IS THE POINT. The Revision field used to free-text to the literal
  // string "main", so a repository whose default branch is `master` — or
  // anything else — was probed at a ref that does not exist, and failed
  // quietly. So: list the refs FIRST, preselect the repository's real default
  // branch, and only then run the weight probe against the revision that was
  // actually chosen.
  //
  // Refs are an affordance and never a gate. Any failure leaves `refs` null,
  // the field degrades to the free-text box it has always been, and the probe
  // runs exactly as it did before.
  const refsSeq = useRef(0);

  const loadRefsThenProbe = useCallback(
    async (slug: string, rev: string, token: string) => {
      const trimmed = slug.trim();
      if (trimmed.length === 0) return;

      const seq = ++refsSeq.current;
      let effectiveRevision = rev;

      try {
        const response = await fetch("/api/studio/refs", {
          body: JSON.stringify({ repoSlug: trimmed, ...(token ? { hfToken: token } : {}) }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const body = (await response.json()) as RefsResponse;
        if (seq !== refsSeq.current) return;

        if (body.ok) {
          setRefs({ branches: body.branches, tags: body.tags });
          if (!revisionTouched) {
            effectiveRevision = body.defaultBranch;
            setRevision(body.defaultBranch);
          }
        } else {
          setRefs(null);
        }
      } catch {
        if (seq !== refsSeq.current) return;
        setRefs(null);
      }

      await runProbe(trimmed, effectiveRevision, token);
    },
    [revisionTouched, runProbe],
  );

  // ── Solve (FR-STU-004b: live, on every input change) ─────────────────────
  //
  // Debounced, because a Slider fires continuously while dragged and each
  // change is a round trip. One batched RPC per settled value, not per pixel.
  useEffect(() => {
    if (!probe?.architecture) {
      setPlacements([]);
      return;
    }
    const architecture = probe.architecture;
    const variants = probe.variants;

    let cancelled = false;
    setSolving(true);

    const timer = setTimeout(() => {
      resolvePlacements(supabase, {
        variants,
        architecture,
        contextLength,
        targetTokensPerSecond: targetTokS,
      })
        .then((result) => {
          if (cancelled) return;
          setPlacements(result);
          setSolveError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setPlacements([]);
          setSolveError(
            cause instanceof Error ? cause.message : "The capacity solver did not respond.",
          );
        })
        .finally(() => {
          if (!cancelled) setSolving(false);
        });
    }, SOLVE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contextLength, probe, supabase, targetTokS]);

  const placementById = useMemo(() => {
    const map = new Map<string, VariantPlacement>();
    for (const entry of placements) map.set(entry.variantId, entry);
    return map;
  }, [placements]);

  const selectedPlacement: Placement | null = variantId
    ? (placementById.get(variantId)?.placement ?? null)
    : null;
  const selectedVariant = probe?.variants.find((v) => v.id === variantId) ?? null;
  /** The licence document the acknowledgement below would name. */
  const acknowledgedTerms = acknowledgeableTerms(probe?.baseModel.license ?? null);

  const remedies = useMemo(() => {
    if (!selectedPlacement || selectedPlacement.feasible) return [];
    return remediesFor(
      selectedPlacement,
      { contextLength, targetTokensPerSecond: targetTokS },
      feasibleAlternatives(probe?.variants ?? [], placements, variantId),
    );
  }, [contextLength, placements, probe, selectedPlacement, targetTokS, variantId]);

  const applyRemedy = useCallback((remedy: Remedy) => {
    // Both sliders are stepped, and a remedy is an ACHIEVABLE value — so it is
    // snapped DOWN to the step rather than to the nearest one. Rounding up
    // would hand back a target the solver just said was out of reach: "accept
    // 149 tok/s" landing on 150 re-asks for more than the hardware delivers,
    // and only the solver's 10% tolerance would be hiding it.
    if (remedy.kind === "context") {
      setContextLength(Math.max(CTX_MIN, Math.floor(remedy.value / CTX_STEP) * CTX_STEP));
    } else if (remedy.kind === "speed") {
      setTargetTokS(Math.max(SPEED_MIN, Math.floor(remedy.value / SPEED_STEP) * SPEED_STEP));
    } else {
      setVariantId(remedy.value);
    }
  }, []);

  // ── Pricing (FR-STU-005) ─────────────────────────────────────────────────
  const costFloor = selectedPlacement?.feasible ? selectedPlacement.costFloorMicroPerMtoken : null;
  const promptMicro = dollarsPerMtokenToMicro(pricePrompt);
  const completionMicro = dollarsPerMtokenToMicro(priceCompletion);
  // A price below the floor WARNS and does not block. Creators may subsidise
  // deliberately, and blocking would be the platform overruling a business
  // decision that is theirs.
  const belowFloor = costFloor !== null && (promptMicro < costFloor || completionMicro < costFloor);

  /**
   * A private model's default price is the COST FLOOR, not 0.5/1.5 (§7.1).
   *
   * Private does not mean unbilled: `resolve.ts` 404s a non-owner and lets the
   * owner straight through, after which authorize/deduct run exactly as they do
   * for a public model. So a private price is what the creator's own calls cost
   * the creator, and with no market to reason about, the only defensible
   * default is break-even.
   *
   * Guarded by `pricesTouched`: a number the creator typed is never overwritten,
   * which is also why this cannot be written as a plain derived value.
   */
  useEffect(() => {
    if (isPublic || pricesTouched || costFloor === null) return;
    const floorDollars = microToDollarsPerMtoken(costFloor);
    setPricePrompt(floorDollars);
    setPriceCompletion(floorDollars);
  }, [costFloor, isPublic, pricesTouched]);

  // ── Submit gate ──────────────────────────────────────────────────────────
  // Submit is blocked ONLY when no variant is feasible (FR-STU-004d).
  const blockingReason = (() => {
    if (!probe) return "Enter a Hugging Face repository.";
    if (displayName.trim().length === 0) return "A display name is required.";
    if (!variantId) return "Choose a quality variant.";
    if (needsToken && hfToken.trim().length === 0) {
      return "This repository needs a Hugging Face token.";
    }
    if (isSolving) return "Solving capacity…";
    if (!selectedPlacement) return "Waiting for the capacity solver.";
    if (!selectedPlacement.feasible) return "This configuration does not fit anywhere.";
    return null;
  })();

  const canSubmit = blockingReason === null && phase === "editing";

  const submit = useCallback(async () => {
    if (!canSubmit || !probe || !variantId) return;
    setPhase("deploying");
    setDeployError(null);
    setFailedStage(null);
    setDeployStatus("validating");

    try {
      const response = await fetch("/api/studio/models", {
        body: JSON.stringify({
          hfRepoSlug: probe.repoSlug,
          hfRevision: revision.trim() || "main",
          displayName: displayName.trim(),
          description: description.trim(),
          ...(hfToken.trim() ? { hfToken: hfToken.trim() } : {}),
          variantId,
          contextLength,
          targetTokensPerSecond: targetTokS,
          pricePromptMicro: promptMicro,
          priceCompletionMicro: completionMicro,
          isPublic,
          // Sent only when the repository declared nothing — the server ignores
          // it otherwise, and the form does not ask in that case.
          ...(probe.baseModel.declared === null && baseModelChoice
            ? { baseModelChoice: decodeBaseModelChoice(baseModelChoice) }
            : {}),
          // The licence text the creator accepted, named rather than asserted as
          // a boolean: the server publishes only if this is the document
          // actually in force for the resolved weights, so an acknowledgement of
          // the wrong licence reads as one and is refused (#29).
          ...(isPublic && licenseAcknowledged && acknowledgedTerms
            ? { licenseAckVersion: acknowledgedTerms }
            : {}),
        }),
        cache: "no-store",
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      const body = (await response.json()) as
        | {
            ok: true;
            modelId: string;
            slug: string;
            measuredTokensPerSecond: number;
            visibility: "public" | "private";
            license: { published: boolean; message: string | null; hint: string | null };
          }
        | {
            ok: false;
            code: string;
            message: string;
            hint: string;
            modelId: string | null;
            stage: ModelStatus;
          };

      if (body.ok) {
        // The token is dropped the moment it is no longer needed. It lives in
        // Vault now; there is no reason for a copy to sit in component state.
        setHfToken("");
        setModelId(body.modelId);
        setDeployedSlug(body.slug);
        // A listing the licence gate held back is a SUCCESS with one thing
        // missing, and the creator asked for that thing — so it is reported,
        // next to the stepper that says the model is live.
        setLicenseHold(
          body.license.published
            ? null
            : { message: body.license.message, hint: body.license.hint },
        );
        setDeployStatus("ready");
        setPhase("done");
        router.refresh();
        return;
      }

      setModelId(body.modelId);
      setFailedStage(body.stage);
      setDeployStatus(body.code === "token_rejected" ? "auth_failed" : "failed");
      setDeployError({ message: body.message, hint: body.hint });
      // A failure that created no row is recoverable in place: put the form
      // back rather than stranding the creator on a dead stepper.
      setPhase(body.modelId === null ? "editing" : "done");
    } catch {
      setDeployStatus("failed");
      setFailedStage(null);
      setDeployError({
        message: "The deployment request did not complete.",
        hint: "The connection dropped. Check the My Models list before retrying — the deployment may have continued server-side.",
      });
      setPhase("editing");
    }
  }, [
    baseModelChoice,
    canSubmit,
    completionMicro,
    contextLength,
    description,
    displayName,
    acknowledgedTerms,
    hfToken,
    isPublic,
    licenseAcknowledged,
    probe,
    promptMicro,
    revision,
    router,
    targetTokS,
    variantId,
  ]);

  // ── Provisioning view ────────────────────────────────────────────────────
  if (phase !== "editing") {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="border-border bg-surface flex flex-col gap-5 rounded-lg border p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold tracking-tight">
              {deployStatus === "ready" ? `${displayName} is live` : `Deploying ${displayName}`}
            </h2>
            <p className="text-muted text-sm">{probe?.repoSlug}</p>
          </div>

          <ProvisioningStepper
            error={deployError}
            failedStage={failedStage}
            modelId={modelId}
            onStatusChange={setDeployStatus}
            status={deployStatus}
          />
        </div>

        {deployStatus === "ready" && licenseHold ? (
          <LicenseGateOutcomeAlert hint={licenseHold.hint} message={licenseHold.message} />
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button onPress={() => router.push("/studio")} variant="primary">
            {deployStatus === "ready" ? "View my models" : "Back to my models"}
          </Button>
          {deployStatus === "ready" && deployedSlug ? (
            <Button onPress={() => router.push("/studio")} variant="tertiary">
              Deployed as {deployedSlug}
            </Button>
          ) : null}
          {deployStatus === "failed" || deployStatus === "auth_failed" ? (
            <Button onPress={() => setPhase("editing")} variant="tertiary">
              Edit and retry
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // ── The form ─────────────────────────────────────────────────────────────
  return (
    <SummaryLayout
      summary={
        <>
          <DeploymentPlan
            contextLength={contextLength}
            isSolving={isProbing || isSolving}
            onApplyRemedy={applyRemedy}
            placement={selectedPlacement}
            qualityLabel={selectedVariant?.qualityLabel ?? null}
            remedies={remedies}
          />

          <div className="border-separator flex flex-col gap-2 border-t pt-4">
            <Button fullWidth isDisabled={!canSubmit} onPress={submit} variant="primary">
              Deploy model
            </Button>
            {/* A disabled CTA is only honest if the reason is visible, and the
                reason sits next to the control that cannot be pressed. When the
                block is an infeasible plan, the Alert above IS the reason and
                this line stays quiet rather than repeating it. */}
            {blockingReason && selectedPlacement?.feasible !== false ? (
              <p className="text-muted text-xs">{blockingReason}</p>
            ) : null}
          </div>
        </>
      }
    >
      <Form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* ── Source ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              className="sm:col-span-2"
              isRequired
              onBlur={() => void loadRefsThenProbe(repoSlug, revision, hfToken)}
              onChange={setRepoSlug}
              value={repoSlug}
            >
              <Label>
                Hugging Face repository{" "}
                <LabelHint>
                  The repository holding the weights. GGUF runs on llama.cpp, safetensors on vLLM —
                  the runtime is derived, never chosen.
                </LabelHint>
              </Label>
              <Input className="font-mono" placeholder="organization/model" />
              <Description>
                {isProbing
                  ? "Reading the repository…"
                  : "owner/repo — GGUF or safetensors weights."}
              </Description>
              <FieldError />
            </TextField>

            <RevisionField
              onChange={(next) => {
                setRevision(next);
                setRevisionTouched(true);
              }}
              refs={refs}
              value={revision}
            />
          </div>

          {/* FR-STU-002: an inline Alert, never a Toast. A Toast for a form
              validation result is gone before the creator has read it, and
              cannot be re-read while fixing the field it describes. */}
          {probeError ? (
            <Alert status={probeError.requiresAuth ? "warning" : "danger"}>
              <Alert.Content>
                <Alert.Title>
                  {probeError.requiresAuth
                    ? "This repository needs a token"
                    : "This repository cannot be deployed"}
                </Alert.Title>
                <Alert.Description>{probeError.message}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {probe ? (
            <Alert status="success">
              <Alert.Content>
                <Alert.Title>
                  {probe.variants.filter((v) => v.deployable).length} deployable
                  {probe.variants.filter((v) => v.deployable).length === 1
                    ? " variant"
                    : " variants"}{" "}
                  found
                </Alert.Title>
                <Alert.Description>
                  {probe.weightsFormat.toUpperCase()} weights
                  {probe.architecture
                    ? `, ${probe.architecture.nLayers} blocks, geometry read from ${probe.architecture.source}`
                    : ""}
                  {probe.companions.length > 0
                    ? `. ${probe.companions.length} companion file${probe.companions.length === 1 ? "" : "s"} (draft or projector weights) were found and are not deployable.`
                    : "."}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {/* ── The conditional token field (FR-STU-003) ─────────────────── */}
          {/* Present in the DOM only once needed, and arriving with a designed
              0fr -> 1fr height transition rather than a 76px layout jump. This
              is the one documented exception to the no-layout-animation rule
              (docs/DESIGN.md §1.5, §3.11), and it is inert under
              prefers-reduced-motion. */}
          <div className="field-reveal" data-revealed={needsToken}>
            <div>
              {needsToken ? (
                <TextField
                  id={tokenFieldId}
                  isRequired
                  onChange={setHfToken}
                  type={revealToken ? "text" : "password"}
                  value={hfToken}
                >
                  <Label>
                    Hugging Face read token{" "}
                    <LabelHint>
                      Encrypted at rest in Supabase Vault. Used only to read the repository and to
                      pull weights at cold start. It is never returned by any API, including to you.
                    </LabelHint>
                  </Label>
                  <InputGroup>
                    <InputGroup.Input className="font-mono" placeholder="hf_..." />
                    <InputGroup.Suffix>
                      <ToggleButton
                        aria-label={revealToken ? "Hide token" : "Reveal token"}
                        isSelected={revealToken}
                        onChange={setRevealToken}
                        size="sm"
                        variant="ghost"
                      >
                        {revealToken ? "Hide" : "Show"}
                      </ToggleButton>
                    </InputGroup.Suffix>
                  </InputGroup>
                  <Description>
                    Checked against the repository before anything is deployed, so a token without
                    access fails here rather than at first use.
                  </Description>
                </TextField>
              ) : null}
              {needsToken ? (
                <div className="pt-3">
                  <Button
                    isDisabled={hfToken.trim().length === 0 || isProbing}
                    onPress={() => void runProbe(repoSlug, revision, hfToken)}
                    size="sm"
                    variant="secondary"
                  >
                    {isProbing ? "Checking…" : "Check access"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {/* ── Identity ───────────────────────────────────────────────────── */}
        <section className="grid gap-5 sm:grid-cols-2">
          <TextField isRequired onChange={setDisplayName} value={displayName}>
            <Label>Display name</Label>
            <Input placeholder="Qwen3.8 27B Uncensored" />
            <Description>Shown in the catalog. Its URL is derived from it.</Description>
          </TextField>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="model-description">Description</Label>
            <TextArea
              id="model-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this model is good at, and what it is not."
              rows={3}
              value={description}
            />
            <p className="text-muted text-xs">
              Optional. Up to 2,000 characters.
              {probe?.suggestedDescription && description === probe.suggestedDescription
                ? " Taken from the repository's model card — edit it freely."
                : ""}
            </p>
          </div>
        </section>

        {/* ── Which model is this? (#25 — the resolution cascade) ────────── */}
        {probe ? (
          <BaseModelStep
            baseModel={probe.baseModel}
            onChange={setBaseModelChoice}
            value={baseModelChoice}
          />
        ) : null}

        {/* ── Intent. No hardware input exists in this section. ──────────── */}
        {probe ? (
          <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold tracking-tight">What your model should do</h2>
              <p className="text-muted text-sm">
                Three decisions, all of them about your model rather than about infrastructure. The
                hardware that satisfies them is solved, not chosen — bigger cards are not always
                faster ones.
              </p>
            </div>

            <Slider
              maxValue={ctxMax}
              minValue={CTX_MIN}
              onChange={(value) =>
                setContextLength(typeof value === "number" ? value : (value[0] ?? CTX_MIN))
              }
              step={CTX_STEP}
              value={contextLength}
            >
              <Label>
                Context window{" "}
                <LabelHint>
                  Past roughly 32k this, not model size, is what drives cost: KV cache grows with
                  every token and collapses how many requests one GPU can serve at once.
                </LabelHint>
              </Label>
              <Slider.Output className="font-mono text-xs tabular-nums">
                {formatExactTokens(contextLength)} tokens
              </Slider.Output>
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
              <Description>
                {selectedPlacement?.feasible
                  ? `KV cache at this window: ${formatGiB(selectedPlacement.kvBytesTotal)} per stream. Maximum for this model: ${formatContext(ctxMax)}.`
                  : `Maximum for this model: ${formatExactTokens(ctxMax)} tokens.`}
              </Description>
            </Slider>

            <Slider
              maxValue={SPEED_MAX}
              minValue={SPEED_MIN}
              onChange={(value) =>
                setTargetTokS(typeof value === "number" ? value : (value[0] ?? SPEED_MIN))
              }
              step={SPEED_STEP}
              value={targetTokS}
            >
              <Label>
                Minimum speed{" "}
                <LabelHint>
                  Tokens per second for a single stream. Raising it narrows the hardware that
                  qualifies, which raises the cost floor.
                </LabelHint>
              </Label>
              <Slider.Output className="font-mono text-xs tabular-nums">
                {targetTokS} tokens/sec per stream
              </Slider.Output>
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
              <Description>
                Measured against a real generation after deployment. A model that misses its target
                is published at its real speed, not its target.
              </Description>
            </Slider>

            <div className="flex flex-col gap-2">
              <Label>Quality</Label>
              <VariantTable
                contextLength={contextLength}
                isLoading={isSolving}
                onSelect={setVariantId}
                placements={placementById}
                selectedId={variantId}
                variants={probe.variants}
              />
            </div>

            {solveError ? (
              <Alert status="danger">
                <Alert.Content>
                  <Alert.Title>The capacity solver did not respond</Alert.Title>
                  <Alert.Description>{solveError}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
          </section>
        ) : null}

        {/* ── Pricing (FR-STU-005) ───────────────────────────────────────── */}
        <section className="flex flex-col gap-5">
          {/* THE PRICE IS REQUIRED IN BOTH STATES and the framing is what
              changes, not the requirement (§7.1). A private model is unlisted
              and access-controlled, never free — the gateway meters and bills it
              identically. What differs is who pays: for a private model that is
              the creator, so the copy stops describing a market and starts
              describing their own bill. */}
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold tracking-tight">Pricing</h2>
            <p className="text-muted text-sm">
              {isPublic
                ? "What a caller pays per 1M tokens. The platform keeps its fee, and the cost floor is what the hardware costs us to run."
                : "Private models are still metered and still billed. This is what your own calls cost you — the platform keeps its fee, and the cost floor is what the hardware costs us. These default to break-even until you change them."}
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            {/* `formatOptions` is load-bearing, not cosmetic — see
                PRICE_FORMAT_OPTIONS. The echo below it states the exact integer
                that will be stored, so a locale that reads "3.25" as 325 is
                visible before submit rather than at somebody's first bill. */}
            <NumberField
              formatOptions={PRICE_FORMAT_OPTIONS}
              minValue={0}
              onChange={(next) => {
                setPricePrompt(next);
                setPricesTouched(true);
              }}
              step={0.01}
              value={pricePrompt}
            >
              <Label>Prompt price · per 1M tokens</Label>
              <Input className="tabular-nums" />
              <Description>
                <span className="block tabular-nums">{microUsdEcho(promptMicro)}</span>
                {costFloor === null
                  ? "Cost floor appears once a plan resolves."
                  : `Cost floor ${formatPricePerMtoken(costFloor)}/M`}
              </Description>
            </NumberField>

            <NumberField
              formatOptions={PRICE_FORMAT_OPTIONS}
              minValue={0}
              onChange={(next) => {
                setPriceCompletion(next);
                setPricesTouched(true);
              }}
              step={0.01}
              value={priceCompletion}
            >
              <Label>Completion price · per 1M tokens</Label>
              <Input className="tabular-nums" />
              <Description>
                <span className="block tabular-nums">{microUsdEcho(completionMicro)}</span>
                {costFloor === null
                  ? "Cost floor appears once a plan resolves."
                  : `Cost floor ${formatPricePerMtoken(costFloor)}/M`}
              </Description>
            </NumberField>
          </div>

          {/* Warns, never blocks. Subsidising is a business decision that
              belongs to the creator (FR-STU-005). */}
          {belowFloor && costFloor !== null ? (
            <Alert status="warning">
              <Alert.Content>
                <Alert.Title>Priced below the cost floor</Alert.Title>
                <Alert.Description>
                  Serving this configuration costs about {formatPricePerMtoken(costFloor)} per 1M
                  tokens. You can deploy anyway — you would be subsidising each request.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          {/* COMPOSITION IS LOAD-BEARING, and the obvious reading of it is wrong.
              `Switch.Content` is not a content slot — it is React Aria's
              `SwitchButton`, the element that renders the hidden <input> and owns
              every press target. The track and thumb must live INSIDE it, or the
              toggle paints correctly (the root carries `data-selected`, so the
              thumb still slides) while only the label text responds to a click.
              That is the exact failure this had: a switch that looked stuck.

              `Description` stays a SIBLING of `Switch.Content`, per the note in
              `@heroui/styles`' own source. Inside, it is a <p> nested in a
              <label>, so clicking three lines of explanatory prose silently flips
              the model's visibility. */}
          <Switch isSelected={isPublic} onChange={setPublic}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>Public</Label>
            </Switch.Content>
            <Description>
              Listed in the marketplace catalog and callable by any developer with a funded wallet.
              Private models are callable only with your own API keys — they are still metered and
              still billed at the prices below.
            </Description>
          </Switch>

          {/* Only ever about being LISTED, which is why it lives here and not in
              its own section: the switch above is the control it qualifies. */}
          {probe ? (
            <LicenseGateStep
              acknowledged={licenseAcknowledged}
              isPublic={isPublic}
              license={probe.baseModel.license}
              onAcknowledgedChange={setLicenseAcknowledged}
            />
          ) : null}
        </section>

        {/* Enter submits; the visible CTA lives in the sticky panel. */}
        <button className="hidden" disabled={!canSubmit} type="submit">
          Deploy
        </button>
      </Form>
    </SummaryLayout>
  );
}

/**
 * The Revision field — a ComboBox with `allowsCustomValue`, never a Select.
 *
 * Branches and tags are enumerable; a COMMIT SHA IS NOT, and pinning one is the
 * whole point of a revision field for anyone who cares about reproducibility. A
 * closed `Select` would remove that capability, so the field stays a text input
 * that happens to know the answers (docs/UI-REDESIGN-PLAN.md §7.1).
 *
 * With no refs listed — not fetched yet, rate-limited, private without a token,
 * or a repo that simply has none — this is the plain `TextField` it has always
 * been. The dropdown is an addition, not a dependency.
 */
function RevisionField({
  onChange,
  refs,
  value,
}: Readonly<{
  onChange: (value: string) => void;
  refs: { branches: string[]; tags: string[] } | null;
  value: string;
}>) {
  const options = useMemo(() => {
    if (!refs) return [];
    return [
      ...refs.branches.map((name) => ({ kind: "branch" as const, name })),
      ...refs.tags.map((name) => ({ kind: "tag" as const, name })),
    ];
  }, [refs]);

  if (options.length === 0) {
    return (
      <TextField onChange={onChange} value={value}>
        <Label>Revision</Label>
        <Input className="font-mono" placeholder="main" />
        <Description>Branch, tag or commit.</Description>
      </TextField>
    );
  }

  return (
    <ComboBox allowsCustomValue inputValue={value} menuTrigger="focus" onInputChange={onChange}>
      <Label>Revision</Label>
      <ComboBox.InputGroup>
        <Input className="font-mono" placeholder="main" />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover>
        <ListBox
          renderEmptyState={() => (
            <p className="text-muted p-2 text-xs">
              No branch or tag matches. It will be used as-is — a commit SHA is valid here.
            </p>
          )}
        >
          {options.map((option) => (
            <ListBox.Item
              id={option.name}
              key={`${option.kind}:${option.name}`}
              textValue={option.name}
            >
              <span className="font-mono">{option.name}</span>
              {option.kind === "tag" ? <span className="text-muted ml-2 text-xs">tag</span> : null}
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
      <Description>Branch, tag or commit SHA. A SHA can be typed in full.</Description>
    </ComboBox>
  );
}
