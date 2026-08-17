#!/usr/bin/env node
/**
 * provision.js — create a RunPod serverless endpoint for one model variant.
 *
 * Two mutations, in order (PRD §4.3.4):
 *   1. saveTemplate  — the container and its environment contract
 *   2. saveEndpoint  — the scale-to-zero scaling policy
 *
 * Guarantees this file exists to provide:
 *   FR-DEP-030  Idempotent. A retry after partial failure orphans nothing. Before creating
 *               anything it reconciles the deterministic names against RunPod itself, so
 *               idempotency survives losing the state file entirely.
 *   FR-DEP-031  workersMin = 0, idleTimeout = 30. Not configurable. Hard-asserted below.
 *   FR-DEP-032  workersMax defaults to 3.
 *   FR-DEP-033  Both ids are flushed to the state file the instant RunPod returns them,
 *               BEFORE the smoke test, so a failed smoke test leaves a deletable resource.
 *   FR-DEP-061  MODEL_FILE is MANDATORY for llama.cpp. Refuses to proceed without it.
 *
 * SECURITY: RUNPOD_API_KEY is read from env only, never printed, never persisted, and
 * redacted out of --dry-run output.
 */

import { readFile } from "node:fs/promises";
import {
  GPU_TIERS,
  containerDiskGb,
  getTier,
  selectTier,
  volumeGb,
} from "./gpu-tiers.js";
import {
  RunpodError,
  graphql,
  materializeForReview,
  redact,
  resolveApiKey,
  resolveGraphqlUrl,
} from "./runpod-client.js";
import {
  endpointName,
  getResource,
  resolveStateFile,
  resourceKey,
  templateName,
  upsertResource,
} from "./state.js";

// ── Platform-enforced scaling constants. These are the unit-economics guarantee
//    (FR-DEP-031 / NFR-CS-004), not knobs. Changing them changes the business model.
export const WORKERS_MIN = 0;
export const IDLE_TIMEOUT_S = 30;
export const DEFAULT_WORKERS_MAX = 3;
export const SCALER_TYPE = "QUEUE_DELAY";
export const SCALER_VALUE = 4;
export const LOCATIONS = "US";

export const SAVE_TEMPLATE_MUTATION = `
mutation SaveTemplate($input: SaveTemplateInput!) {
  saveTemplate(input: $input) {
    id
    name
    imageName
    isServerless
    containerDiskInGb
    volumeInGb
  }
}`;

export const SAVE_ENDPOINT_MUTATION = `
mutation SaveEndpoint($input: EndpointInput!) {
  saveEndpoint(input: $input) {
    id
    name
    templateId
    gpuIds
    workersMin
    workersMax
    idleTimeout
    scalerType
    scalerValue
    locations
  }
}`;

export const RECONCILE_QUERY = `
query Reconcile {
  myself {
    podTemplates { id name }
    endpoints { id name templateId }
  }
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Spec validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ModelSpec
 * @property {string} hfRepoSlug
 * @property {string} modelFile          the SPECIFIC .gguf file — FR-DEP-061, mandatory
 * @property {number} weightsBytes       exact bytes of that file, from the probe
 * @property {number} contextLength
 * @property {string} [hfRevision]
 * @property {string} [runtime]          'llamacpp' | 'vllm' (derived, never chosen)
 * @property {number} [targetTokensPerSecond]
 * @property {number} [nLayers] @property {number} [nKvHeads] @property {number} [headDim]
 * @property {number} [activeWeightsBytes]
 * @property {string} [creatorHandle] @property {string} [modelSlug]
 * @property {object} [placement]        pre-resolved placement from resolve_placement()
 */

export function normalizeSpec(raw) {
  const spec = { ...raw };
  spec.hfRevision ??= "main";
  spec.targetTokensPerSecond ??= 30;
  spec.activeWeightsBytes ??= spec.weightsBytes;

  const errors = [];
  if (!spec.hfRepoSlug || !/^[\w.-]+\/[\w.-]+$/.test(spec.hfRepoSlug)) {
    errors.push("hfRepoSlug must look like 'owner/repo'");
  }
  if (!spec.weightsBytes || !Number.isInteger(spec.weightsBytes) || spec.weightsBytes <= 0) {
    errors.push("weightsBytes must be a positive integer (exact bytes of the selected variant file)");
  }
  if (!spec.contextLength || !Number.isInteger(spec.contextLength) || spec.contextLength <= 0) {
    errors.push("contextLength must be a positive integer");
  }

  // Runtime is DERIVED from the weights format, never selected (FR-DEP-060).
  if (!spec.runtime) {
    spec.runtime = spec.modelFile?.toLowerCase().endsWith(".gguf") ? "llamacpp" : "vllm";
  }

  // FR-DEP-061 — the single most expensive mistake this tool can prevent. vLLM resolves
  // a repo; llama.cpp resolves a FILE. A llama.cpp worker handed only the repo slug will
  // either fail to start or silently load whichever variant it happens to find first —
  // in a repo like the MVP target, that is one of twelve files with a 3x size spread.
  if (spec.runtime === "llamacpp" && !spec.modelFile) {
    errors.push(
      "MODEL_FILE is mandatory for the llama.cpp runtime (FR-DEP-061): pass the specific .gguf " +
        "file of the selected variant, e.g. --file Qwen3.8-27B-Uncensored-Q4_K_M.gguf. " +
        "Passing only the repo is ambiguous in exactly the repos that carry many variants — i.e. all of them.",
    );
  }
  if (spec.runtime === "llamacpp" && spec.modelFile && !spec.modelFile.toLowerCase().endsWith(".gguf")) {
    errors.push(`MODEL_FILE '${spec.modelFile}' is not a .gguf file, but the resolved runtime is llamacpp`);
  }

  if (errors.length) {
    throw new RunpodError(`Invalid model spec:\n  - ${errors.join("\n  - ")}`, {
      code: "invalid_spec",
      remediation: "Fix the spec and re-run. Nothing was sent to RunPod.",
    });
  }
  return spec;
}

/**
 * Resolve the GPU placement. Order of authority:
 *   1. spec.placement            — output of the Postgres resolve_placement() (FR-DEP-050)
 *   2. an explicit pinned tier   — FR-DEP-056 "pin hardware"
 *   3. the offline solver mirror — requires a KNOWN memory profile
 *
 * Refusing case 3 without architecture is deliberate: PRD §4.3.3.5 says a model whose
 * memory profile is unknown must be rejected at form time, never provisioned on a guess.
 */
export function resolvePlacement(spec, { pinnedTierId, parallel } = {}) {
  if (spec.placement?.gpu_tier_id) {
    const tier = getTier(spec.placement.gpu_tier_id);
    if (!tier) throw new RunpodError(`Unknown gpu_tier_id '${spec.placement.gpu_tier_id}'`, { code: "invalid_spec" });
    return { ...spec.placement, runpod_gpu_ids: tier.runpod_gpu_ids, source: "database" };
  }

  if (pinnedTierId) {
    const tier = getTier(pinnedTierId);
    if (!tier) {
      throw new RunpodError(
        `Unknown GPU tier '${pinnedTierId}'. Known tiers: ${GPU_TIERS.map((t) => t.id).join(", ")}`,
        { code: "invalid_spec" },
      );
    }
    if (!parallel) {
      throw new RunpodError("--gpu-tier pins hardware and therefore requires --parallel (the KV budget is no longer being solved for you).", {
        code: "invalid_spec",
        remediation: "Pass --parallel N, or drop --gpu-tier and supply the architecture flags so the solver can compute it.",
      });
    }
    return {
      gpu_tier_id: tier.id,
      gpu_label: tier.label,
      runpod_gpu_ids: tier.runpod_gpu_ids,
      gpu_usd_per_hour_micro_snapshot: tier.usd_per_hour_micro,
      kv_dtype_bytes: spec.kvDtypeBytes ?? 2,
      max_concurrent_streams: parallel,
      predicted_tokens_per_second: null,
      source: "pinned",
    };
  }

  if (!spec.nLayers || !spec.nKvHeads || !spec.headDim) {
    throw new RunpodError(
      "Cannot resolve a GPU tier: the model's memory profile is unknown (nLayers / nKvHeads / headDim missing).",
      {
        code: "architecture_unknown",
        remediation:
          "Supply --n-layers, --n-kv-heads and --head-dim from the GGUF key-value header (FR-DEP-043), or pass a pre-resolved --placement, or pin with --gpu-tier + --parallel. " +
          "Provisioning a model whose memory profile is unknown is refused by design (PRD §4.3.3.5): the failure mode is an OOM under production load, not at smoke-test time. " +
          "n_kv_heads is the GQA KV head count, NOT n_attention_heads — confusing them over-estimates KV by up to 8x.",
      },
    );
  }

  const result = selectTier(spec);
  if (!result.ok) {
    throw new RunpodError(result.message, {
      code: result.code,
      remediation:
        "Reduce the context window, step down one quality level, or lower the throughput target. Nothing was sent to RunPod.",
    });
  }
  return { ...result.placement, source: "solver", rationale: result.rationale };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload builders — pure functions, so --dry-run and the live path cannot diverge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The llama.cpp env contract (PRD §4.3.3.6). NOT the vLLM contract in §4.3.4 —
 * a GGUF model on the vLLM image does not start.
 */
export function buildTemplateInput(spec, placement, { image, templateId } = {}) {
  const workerImage =
    image ||
    (spec.runtime === "llamacpp"
      ? process.env.LLAMACPP_WORKER_IMAGE
      : process.env.VLLM_WORKER_IMAGE);

  if (!workerImage) {
    throw new RunpodError(
      `No worker image for runtime '${spec.runtime}'.`,
      {
        code: "missing_image",
        remediation:
          spec.runtime === "llamacpp"
            ? "Set LLAMACPP_WORKER_IMAGE (or pass --image). It MUST be pinned to a build verified to emit usage on the OpenAI route (FR-GW-044c) — run measure.js against a candidate image before pinning it."
            : "Set VLLM_WORKER_IMAGE (or pass --image).",
      },
    );
  }

  // q8_0 KV when the solver chose 1-byte KV, f16 otherwise. This is the llama.cpp
  // expression of the solver's kv_dtype_bytes output (FR-DEP-064).
  const cacheType = (placement.kv_dtype_bytes ?? 2) === 1 ? "q8_0" : "f16";

  const env = [
    { key: "MODEL_REPO", value: spec.hfRepoSlug },
    // FR-DEP-061 — the specific file, not the repo.
    { key: "MODEL_FILE", value: spec.modelFile },
    { key: "CTX_SIZE", value: String(spec.contextLength) },
    { key: "PARALLEL", value: String(placement.max_concurrent_streams) },
    // Offload every layer: the solver already proved the whole model fits in VRAM.
    { key: "N_GPU_LAYERS", value: "999" },
    { key: "CACHE_TYPE_K", value: cacheType },
    { key: "CACHE_TYPE_V", value: cacheType },
    { key: "CONT_BATCHING", value: "1" },
    { key: "HF_HOME", value: "/runpod-volume/hf" },
  ];

  if (spec.hfRevision && spec.hfRevision !== "main") {
    env.push({ key: "MODEL_REVISION", value: spec.hfRevision });
  }
  // Companion assets (draft / mmproj) are deliberately NOT passed — FR-DEP-063.

  return {
    // `id` present => RunPod updates that template instead of creating a second one.
    ...(templateId ? { id: templateId } : {}),
    name: templateName(spec),
    imageName: workerImage,
    isServerless: true,
    containerDiskInGb: containerDiskGb(spec.weightsBytes),
    volumeInGb: volumeGb(spec.weightsBytes),
    dockerArgs: "",
    env,
  };
}

export function buildEndpointInput(spec, placement, resolvedTemplateId, { workersMax, endpointId } = {}) {
  const input = {
    ...(endpointId ? { id: endpointId } : {}),
    name: endpointName(spec),
    templateId: resolvedTemplateId,
    gpuIds: placement.runpod_gpu_ids,
    workersMin: WORKERS_MIN,
    workersMax: workersMax ?? DEFAULT_WORKERS_MAX,
    idleTimeout: IDLE_TIMEOUT_S,
    scalerType: SCALER_TYPE,
    scalerValue: SCALER_VALUE,
    locations: LOCATIONS,
    networkVolumeId: null,
  };

  // Belt and braces on the one thing that must never regress. workersMin > 0 means a GPU
  // billed 24/7 per model; idleTimeout != 30 changes the cold-start/cost trade the whole
  // product is built on. Assert rather than trust the constants above.
  if (input.workersMin !== 0) throw new RunpodError("FR-DEP-031 violated: workersMin must be 0", { code: "invariant_violated" });
  if (input.idleTimeout !== 30) throw new RunpodError("FR-DEP-031 violated: idleTimeout must be 30", { code: "invariant_violated" });
  if (!Number.isInteger(input.workersMax) || input.workersMax < 1) {
    throw new RunpodError("workersMax must be a positive integer (FR-DEP-032 bounds blast radius)", { code: "invalid_spec" });
  }
  return input;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation — what makes this idempotent even with no state file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask RunPod which of our deterministic names already exist. This is the difference
 * between "idempotent as long as nothing went wrong" and actually idempotent: a crash
 * between saveTemplate and the state flush, or a state file deleted by hand, would
 * otherwise orphan a live template or endpoint on every retry (FR-DEP-030).
 */
export async function reconcile({ tplName, epName, url, apiKey, fetchImpl }) {
  const data = await graphql({
    url,
    apiKey,
    query: RECONCILE_QUERY,
    operationName: "Reconcile",
    fetchImpl,
  });
  const templates = data?.myself?.podTemplates ?? [];
  const endpoints = data?.myself?.endpoints ?? [];
  return {
    templateId: templates.find((t) => t.name === tplName)?.id ?? null,
    endpointId: endpoints.find((e) => e.name === epName)?.id ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The provisioning routine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ModelSpec} rawSpec
 * @param {{dryRun?:boolean, url?:string, apiKey?:string, stateFile?:string, image?:string,
 *          workersMax?:number, pinnedTierId?:string, parallel?:number, fetchImpl?:typeof fetch,
 *          log?:(s:string)=>void}} opts
 */
export async function provision(rawSpec, opts = {}) {
  const {
    dryRun = false,
    url,
    stateFile,
    image,
    workersMax,
    pinnedTierId,
    parallel,
    fetchImpl,
    log = () => {},
  } = opts;

  const spec = normalizeSpec(rawSpec);
  const placement = resolvePlacement(spec, { pinnedTierId, parallel });
  const key = resourceKey(spec);
  const tplName = templateName(spec);
  const epName = endpointName(spec);
  const graphqlUrl = resolveGraphqlUrl(url);

  // Read the key even in dry-run — but with required:false, so payloads stay reviewable
  // before anyone has a key at all. It is never printed either way.
  const apiKey = opts.apiKey ?? resolveApiKey({ required: !dryRun });

  const templateInputPreview = buildTemplateInput(spec, placement, { image });
  const endpointInputPreview = buildEndpointInput(
    spec,
    placement,
    `{{ template_id_from_step_1 }}`,
    { workersMax },
  );

  if (dryRun) {
    const report = {
      dryRun: true,
      graphqlUrl,
      apiKeyPresent: Boolean(process.env.RUNPOD_API_KEY),
      resourceKey: key,
      templateName: tplName,
      endpointName: epName,
      stateFile: resolveStateFile(stateFile),
      placement,
      mutations: [
        { operationName: "SaveTemplate", query: SAVE_TEMPLATE_MUTATION, variables: { input: templateInputPreview } },
        { operationName: "SaveEndpoint", query: SAVE_ENDPOINT_MUTATION, variables: { input: endpointInputPreview } },
      ],
    };
    log(renderDryRun(report));
    return { ok: true, dryRun: true, report };
  }

  // ── 1. Reconcile against RunPod before creating anything ────────────────────
  const known = (await getResource(key, stateFile)) ?? {};
  let templateId = known.runpod_template_id ?? null;
  let endpointId = known.runpod_endpoint_id ?? null;

  const remote = await reconcile({ tplName, epName, url: graphqlUrl, apiKey, fetchImpl });
  const adopted = [];
  if (!templateId && remote.templateId) { templateId = remote.templateId; adopted.push("template"); }
  if (!endpointId && remote.endpointId) { endpointId = remote.endpointId; adopted.push("endpoint"); }
  if (adopted.length) {
    log(`[reconcile] adopted existing RunPod ${adopted.join(" + ")} by deterministic name — not creating a duplicate`);
    // Flush adoptions immediately: this is the orphan-recovery path.
    await upsertResource(key, {
      runpod_template_id: templateId,
      runpod_endpoint_id: endpointId,
      templateName: tplName,
      endpointName: epName,
      status: "reconciling",
    }, stateFile);
  }

  // ── 2. saveTemplate ────────────────────────────────────────────────────────
  const templateInput = buildTemplateInput(spec, placement, { image, templateId });
  log(`[provision] saveTemplate ${tplName}${templateId ? ` (updating ${templateId})` : " (creating)"}`);

  let tpl;
  try {
    const data = await graphql({
      url: graphqlUrl, apiKey, query: SAVE_TEMPLATE_MUTATION,
      variables: { input: templateInput }, operationName: "SaveTemplate", fetchImpl,
    });
    tpl = data.saveTemplate;
  } catch (err) {
    await upsertResource(key, {
      templateName: tplName, endpointName: epName,
      runpod_template_id: templateId, runpod_endpoint_id: endpointId,
      status: "failed",
      runpod_error: { code: err.code, message: err.message },
      remediation_hint: err.remediation ?? null,
    }, stateFile);
    throw err;
  }

  // FR-DEP-033 — flush the id the INSTANT it exists, before anything else can fail.
  templateId = tpl.id;
  await upsertResource(key, {
    templateName: tplName,
    endpointName: epName,
    runpod_template_id: templateId,
    runpod_endpoint_id: endpointId,
    hfRepoSlug: spec.hfRepoSlug,
    modelFile: spec.modelFile,
    hfRevision: spec.hfRevision,
    contextLength: spec.contextLength,
    runtime: spec.runtime,
    imageName: templateInput.imageName,
    placement,
    status: "provisioning",
    runpod_error: null,
    remediation_hint: null,
  }, stateFile);
  log(`[provision] template_id=${templateId} persisted to state BEFORE any smoke test`);

  // ── 3. saveEndpoint ────────────────────────────────────────────────────────
  const endpointInput = buildEndpointInput(spec, placement, templateId, { workersMax, endpointId });
  log(`[provision] saveEndpoint ${epName}${endpointId ? ` (updating ${endpointId})` : " (creating)"}`);

  let ep;
  try {
    const data = await graphql({
      url: graphqlUrl, apiKey, query: SAVE_ENDPOINT_MUTATION,
      variables: { input: endpointInput }, operationName: "SaveEndpoint", fetchImpl,
    });
    ep = data.saveEndpoint;
  } catch (err) {
    // The template EXISTS and is recorded. This is the partial-failure path: the state
    // file already holds a deletable template id, so `teardown.js` cleans up and a retry
    // reuses it. Nothing is orphaned.
    await upsertResource(key, {
      status: "failed",
      runpod_error: { code: err.code, message: err.message },
      remediation_hint: err.remediation ?? null,
    }, stateFile);
    throw err;
  }

  endpointId = ep.id;
  await upsertResource(key, {
    runpod_endpoint_id: endpointId,
    workersMin: ep.workersMin ?? WORKERS_MIN,
    workersMax: ep.workersMax ?? endpointInput.workersMax,
    idleTimeout: ep.idleTimeout ?? IDLE_TIMEOUT_S,
    status: "provisioned",
    runpod_error: null,
    remediation_hint: null,
  }, stateFile);
  log(`[provision] endpoint_id=${endpointId} persisted to state BEFORE any smoke test`);

  return {
    ok: true,
    dryRun: false,
    resourceKey: key,
    templateName: tplName,
    endpointName: epName,
    runpod_template_id: templateId,
    runpod_endpoint_id: endpointId,
    placement,
    adopted,
    stateFile: resolveStateFile(stateFile),
  };
}

function renderDryRun(report) {
  const lines = [];
  lines.push("─".repeat(78));
  lines.push("DRY RUN — nothing was sent to RunPod, no resource created, no money spent.");
  lines.push("─".repeat(78));
  lines.push(`  GraphQL URL   : ${report.graphqlUrl}`);
  lines.push(`  RUNPOD_API_KEY: ${report.apiKeyPresent ? "present (value redacted — never printed)" : "ABSENT (fine for a dry run)"}`);
  lines.push(`  state file    : ${report.stateFile}`);
  lines.push(`  resource key  : ${report.resourceKey}  (sha256 of repo + revision + file)`);
  lines.push(`  template name : ${report.templateName}`);
  lines.push(`  endpoint name : ${report.endpointName}`);
  lines.push("");
  lines.push(`  placement     : ${report.placement.gpu_label ?? report.placement.gpu_tier_id} via ${report.placement.source}`);
  lines.push(`                  gpuIds "${report.placement.runpod_gpu_ids}"  $${(report.placement.gpu_usd_per_hour_micro_snapshot / 1e6).toFixed(2)}/hr`);
  if (report.placement.predicted_tokens_per_second != null) {
    lines.push(`                  predicted ${report.placement.predicted_tokens_per_second} tok/s, ${report.placement.max_concurrent_streams} concurrent streams`);
    lines.push(`                  cost floor ${report.placement.cost_floor_micro_per_mtoken} micro-USD / 1M tokens ($${(report.placement.cost_floor_micro_per_mtoken / 1e6).toFixed(6)})`);
  }
  for (const m of report.mutations) {
    lines.push("");
    lines.push(`── ${m.operationName} ${"─".repeat(Math.max(0, 74 - m.operationName.length))}`);
    lines.push(materializeForReview(m.query, m.variables));
    lines.push("");
    lines.push("  wire body (exactly what would be POSTed):");
    lines.push(
      redact(JSON.stringify({ query: m.query, variables: m.variables, operationName: m.operationName }, null, 2))
        .split("\n").map((l) => "  " + l).join("\n"),
    );
  }
  lines.push("─".repeat(78));
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [flag, inline] = a.slice(2).split(/=(.*)/s);
    const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) { out[camel] = inline; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[camel] = true; continue; }
    out[camel] = next; i++;
  }
  return out;
}

const num = (v) => (v === undefined ? undefined : Number(v));

const USAGE = `
runpod-provision — create a RunPod serverless endpoint for one model variant

  node tools/runpod/provision.js --repo OWNER/REPO --file VARIANT.gguf \\
      --weights-bytes N --context N [architecture flags] [--dry-run]

Required
  --repo SLUG            Hugging Face repo, owner/name
  --file NAME.gguf       the SPECIFIC variant file (FR-DEP-061 — mandatory for llama.cpp)
  --weights-bytes N      exact bytes of that file, from the probe
  --context N            context window (CTX_SIZE)

Architecture (needed by the solver; from the GGUF KV header — FR-DEP-043)
  --n-layers N  --n-kv-heads N  --head-dim N
      n-kv-heads is the GQA KV head count, NOT n_attention_heads.
      Omit these only if you also pass --gpu-tier and --parallel.

Optional
  --revision REF         default main
  --target-tps N         throughput target, default 30
  --creator HANDLE       endpoint name is nexus-{creator}-{slug}; defaults from the repo
  --slug SLUG
  --gpu-tier ID          pin hardware (FR-DEP-056): ${GPU_TIERS.map((t) => t.id).join(" | ")}
  --parallel N           required with --gpu-tier
  --workers-max N        default ${DEFAULT_WORKERS_MAX}
  --image REF            worker image; defaults to $LLAMACPP_WORKER_IMAGE / $VLLM_WORKER_IMAGE
  --spec FILE.json       read the whole spec from JSON (flags override it)
  --state FILE           state file; default $RUNPOD_STATE_FILE or tools/runpod/.state/runpod-state.json
  --url URL              GraphQL base; default $RUNPOD_GRAPHQL_URL or https://api.runpod.io/graphql
  --dry-run              print the exact payloads and exit. Sends nothing.
  --json                 machine-readable result on stdout

workersMin=0 and idleTimeout=30 are platform-enforced and have no flags (FR-DEP-031).
RUNPOD_API_KEY is read from the environment only — there is no flag, by design.
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) { process.stdout.write(USAGE); return 0; }

  let spec = {};
  if (args.spec) spec = JSON.parse(await readFile(String(args.spec), "utf8"));

  if (args.repo) spec.hfRepoSlug = String(args.repo);
  if (args.file) spec.modelFile = String(args.file);
  if (args.revision) spec.hfRevision = String(args.revision);
  if (args.weightsBytes !== undefined) spec.weightsBytes = num(args.weightsBytes);
  if (args.context !== undefined) spec.contextLength = num(args.context);
  if (args.targetTps !== undefined) spec.targetTokensPerSecond = num(args.targetTps);
  if (args.nLayers !== undefined) spec.nLayers = num(args.nLayers);
  if (args.nKvHeads !== undefined) spec.nKvHeads = num(args.nKvHeads);
  if (args.headDim !== undefined) spec.headDim = num(args.headDim);
  if (args.activeWeightsBytes !== undefined) spec.activeWeightsBytes = num(args.activeWeightsBytes);
  if (args.creator) spec.creatorHandle = String(args.creator);
  if (args.slug) spec.modelSlug = String(args.slug);

  try {
    const result = await provision(spec, {
      dryRun: Boolean(args.dryRun),
      url: args.url ? String(args.url) : undefined,
      stateFile: args.state ? String(args.state) : undefined,
      image: args.image ? String(args.image) : undefined,
      workersMax: args.workersMax !== undefined ? num(args.workersMax) : undefined,
      pinnedTierId: args.gpuTier ? String(args.gpuTier) : undefined,
      parallel: args.parallel !== undefined ? num(args.parallel) : undefined,
      log: (s) => process.stdout.write(s + "\n"),
    });
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (!result.dryRun) {
      process.stdout.write(
        `\nProvisioned.\n  template ${result.runpod_template_id}\n  endpoint ${result.runpod_endpoint_id}\n` +
          `  state    ${result.stateFile}\n\nNext: measure the cold start —\n` +
          `  RUNPOD_ENDPOINT_ID=${result.runpod_endpoint_id} node tools/runpod/measure.js --runs 3\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`\n[FAILED] ${err.code ?? "error"}: ${redact(err.message)}\n`);
    if (err.remediation) process.stderr.write(`\n  ${redact(err.remediation)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("provision.js")) {
  main().then((c) => { process.exitCode = c; });
}
