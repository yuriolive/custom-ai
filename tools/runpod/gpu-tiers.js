/**
 * gpu-tiers.js — the GPU capability catalog as data, plus the offline mirror of the
 * capacity solver (PRD §4.3.3.3 / §5.4a `resolve_placement`).
 *
 * Values come verbatim from PRD §5.4 `insert into public.gpu_tiers`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS LIST IS NOT AN ORDERED LADDER.
 *
 *   L40S      48 GB VRAM   864 GB/s bandwidth   $0.86/hr
 *   RTX 4090  24 GB VRAM  1008 GB/s bandwidth   $0.44/hr
 *
 * The L40S has DOUBLE the VRAM of an RTX 4090 and LESS memory bandwidth. Since
 * single-stream decode is memory-bandwidth bound (every generated token reads the
 * active weights once), for any model that fits in 24 GB "upgrading" to the L40S
 * makes it BOTH slower and nearly 2x more expensive. Do not sort this array and
 * call it a quality ladder; do not present it to a creator as a menu; do not
 * assume index+1 is "better". Selection is `argmin(usd_per_hour_micro)` over the
 * tiers that satisfy BOTH the VRAM fit and the throughput target — nothing else.
 * (PRD §4.3.3.3, FR-DEP-055.)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FR-DEP-050 makes `resolve_placement()` in Postgres the single authoritative solver.
 * `selectTier()` below is a deliberate offline MIRROR of that arithmetic, existing only
 * so this CLI can plan and dry-run a deployment with no database reachable. When a
 * placement has already been resolved in the database, pass it through explicitly
 * (`spec.placement`) and this mirror is bypassed entirely — see provision.js.
 */

/** @typedef {"rtx4090"|"l40s"|"a100_80"|"h100_80"} GpuTierId */

export const GPU_TIERS = Object.freeze([
  Object.freeze({
    id: "rtx4090",
    label: "RTX 4090 24GB",
    vram_bytes: 25769803776,
    memory_bandwidth_bytes_s: 1008000000000,
    runpod_gpu_ids: "NVIDIA GeForce RTX 4090",
    usd_per_hour_micro: 440000,
    container_disk_gb: 60,
    supports_vllm: true,
    supports_llamacpp: true,
    is_enabled: true,
    sort_order: 10,
  }),
  Object.freeze({
    // 2x the VRAM of the 4090 and LOWER bandwidth (864 < 1008 GB/s). Slower AND dearer
    // for anything that fits in 24 GB. This row is the reason the list is not a ladder.
    id: "l40s",
    label: "L40S 48GB",
    vram_bytes: 51539607552,
    memory_bandwidth_bytes_s: 864000000000,
    runpod_gpu_ids: "NVIDIA L40S",
    usd_per_hour_micro: 860000,
    container_disk_gb: 80,
    supports_vllm: true,
    supports_llamacpp: true,
    is_enabled: true,
    sort_order: 20,
  }),
  Object.freeze({
    id: "a100_80",
    label: "A100 80GB",
    vram_bytes: 85899345920,
    memory_bandwidth_bytes_s: 1935000000000,
    runpod_gpu_ids: "NVIDIA A100 80GB PCIe",
    usd_per_hour_micro: 1640000,
    container_disk_gb: 120,
    supports_vllm: true,
    supports_llamacpp: true,
    is_enabled: true,
    sort_order: 30,
  }),
  Object.freeze({
    id: "h100_80",
    label: "H100 80GB",
    // Same VRAM as the A100, 1.73x the bandwidth, 1.82x the price. Also not a ladder step:
    // a model that is VRAM-bound gains nothing here, a model that is bandwidth-bound gains a lot.
    vram_bytes: 85899345920,
    memory_bandwidth_bytes_s: 3350000000000,
    runpod_gpu_ids: "NVIDIA H100 80GB HBM3",
    usd_per_hour_micro: 2990000,
    container_disk_gb: 120,
    supports_vllm: true,
    supports_llamacpp: true,
    is_enabled: true,
    sort_order: 40,
  }),
]);

/** Solver constants — PRD §5.4 `solver_config`. */
export const SOLVER_CONFIG = Object.freeze({
  mfu: 0.75,
  vram_utilization: 0.92,
  assumed_utilization: 0.35,
  speed_tolerance: 0.9,
  prefix_cache_reserve: 0.15,
  volume_threshold_bytes: 21474836480,
  download_bytes_per_s: 314572800,
});

const GIB = 1024 * 1024 * 1024;

/** @param {GpuTierId|string} id */
export function getTier(id) {
  return GPU_TIERS.find((t) => t.id === id) ?? null;
}

/**
 * kv_bytes_per_token = 2 x n_layers x n_kv_heads x head_dim x kv_dtype_bytes
 *
 * `n_kv_heads` is the GQA key/value head count, NOT n_attention_heads. Confusing the two
 * over-estimates KV by up to 8x and picks a GPU two tiers too large (PRD §4.3.3.3).
 */
export function kvBytesPerToken({ nLayers, nKvHeads, headDim, kvDtypeBytes }) {
  return 2 * nLayers * nKvHeads * headDim * kvDtypeBytes;
}

/** overhead_bytes = max(2 GiB, 0.10 x weights_bytes) — CUDA graphs, framework, buffers. */
export function overheadBytes(weightsBytes) {
  return Math.max(2 * GIB, Math.floor(0.1 * weightsBytes));
}

/**
 * Evaluate one tier against one model shape. Pure arithmetic, no I/O.
 * @returns {{tier_id:string,label:string,fits:boolean,meets_speed:boolean,usable_vram_bytes:number,
 *            required_vram_bytes:number,max_concurrent_streams:number,predicted_tokens_per_second:number,
 *            cost_floor_micro_per_mtoken:number|null,reject_reason:string|null}}
 */
export function evaluateTier(tier, model) {
  const {
    weightsBytes,
    activeWeightsBytes = weightsBytes,
    contextLength,
    targetTokensPerSecond,
    kvDtypeBytes,
    nLayers,
    nKvHeads,
    headDim,
  } = model;

  const kvPerToken = kvBytesPerToken({ nLayers, nKvHeads, headDim, kvDtypeBytes });
  const overhead = overheadBytes(weightsBytes);
  const usable = Math.floor(tier.vram_bytes * SOLVER_CONFIG.vram_utilization);
  const kvBudget = usable - weightsBytes - overhead;
  const kvPerStream = kvPerToken * contextLength;

  const maxConcurrent = kvBudget > 0 ? Math.floor(kvBudget / kvPerStream) : 0;
  const fits = maxConcurrent >= 1;
  const requiredVram = weightsBytes + overhead + kvPerStream * Math.max(maxConcurrent, 1);

  const predicted = Math.floor(
    (tier.memory_bandwidth_bytes_s * SOLVER_CONFIG.mfu) / activeWeightsBytes,
  );
  const speedFloor = targetTokensPerSecond * SOLVER_CONFIG.speed_tolerance;
  const meetsSpeed = predicted >= speedFloor;

  let costFloor = null;
  if (fits && predicted > 0) {
    // gpu_micro_per_sec x seconds_per_mtoken, CEILed once at the end (money is integer micro-USD).
    const gpuMicroPerSec = tier.usd_per_hour_micro / 3600;
    const secondsPerMtoken =
      1e6 / (predicted * maxConcurrent * SOLVER_CONFIG.assumed_utilization);
    costFloor = Math.ceil(gpuMicroPerSec * secondsPerMtoken);
  }

  let rejectReason = null;
  if (!fits) {
    rejectReason =
      kvBudget <= 0
        ? `weights (${weightsBytes} B) + overhead (${overhead} B) exceed usable VRAM (${usable} B)`
        : `${contextLength} context needs ${kvPerStream} B of KV per stream; only ${kvBudget} B remain after weights and overhead`;
  } else if (!meetsSpeed) {
    rejectReason = `predicted ${predicted} tok/s is below the ${speedFloor.toFixed(1)} tok/s floor (${targetTokensPerSecond} x ${SOLVER_CONFIG.speed_tolerance})`;
  }

  return {
    tier_id: tier.id,
    label: tier.label,
    fits,
    meets_speed: meetsSpeed,
    usable_vram_bytes: usable,
    required_vram_bytes: requiredVram,
    kv_bytes_per_token: kvPerToken,
    overhead_bytes: overhead,
    max_concurrent_streams: maxConcurrent,
    predicted_tokens_per_second: predicted,
    usd_per_hour_micro: tier.usd_per_hour_micro,
    cost_floor_micro_per_mtoken: costFloor,
    reject_reason: rejectReason,
  };
}

/**
 * Offline mirror of resolve_placement(). Cheapest tier satisfying BOTH constraints.
 * Tries fp16 KV first, falls back to q8_0 KV (FR-DEP-054) only if fp16 finds no tier.
 *
 * @returns {{ok:true,placement:object,rationale:object} | {ok:false,code:string,message:string,rationale:object}}
 */
export function selectTier(model) {
  const runtime = model.runtime ?? "llamacpp";
  const attempts = [];

  for (const kvDtypeBytes of [2, 1]) {
    const candidateModel = { ...model, kvDtypeBytes };
    const evaluations = GPU_TIERS.filter(
      (t) =>
        t.is_enabled && (runtime === "llamacpp" ? t.supports_llamacpp : t.supports_vllm),
    ).map((t) => evaluateTier(t, candidateModel));

    attempts.push({ kv_dtype_bytes: kvDtypeBytes, evaluations });

    const candidates = evaluations.filter((e) => e.fits && e.meets_speed);
    if (candidates.length === 0) continue;

    // argmin(usd_per_hour_micro). NOT argmin(index) — see the header note.
    candidates.sort(
      (a, b) =>
        a.usd_per_hour_micro - b.usd_per_hour_micro ||
        getTier(a.tier_id).sort_order - getTier(b.tier_id).sort_order,
    );
    const winner = candidates[0];
    const tier = getTier(winner.tier_id);

    return {
      ok: true,
      placement: {
        gpu_tier_id: tier.id,
        gpu_label: tier.label,
        runpod_gpu_ids: tier.runpod_gpu_ids,
        gpu_usd_per_hour_micro_snapshot: tier.usd_per_hour_micro,
        kv_dtype_bytes: kvDtypeBytes,
        kv_bytes_per_token: winner.kv_bytes_per_token,
        max_concurrent_streams: winner.max_concurrent_streams,
        predicted_tokens_per_second: winner.predicted_tokens_per_second,
        cost_floor_micro_per_mtoken: winner.cost_floor_micro_per_mtoken,
        needs_network_volume: model.weightsBytes > SOLVER_CONFIG.volume_threshold_bytes,
      },
      rationale: {
        solver: "offline-mirror-of-resolve_placement",
        solver_config: SOLVER_CONFIG,
        inputs: candidateModel,
        attempts,
        selected: winner,
        selection_rule: "argmin(usd_per_hour_micro) over tiers where fits AND predicted >= 0.9 x target",
      },
    };
  }

  const fp16 = attempts[0].evaluations;
  const anyFits = fp16.some((e) => e.fits);
  return {
    ok: false,
    code: anyFits ? "infeasible_too_slow" : "infeasible_no_fit",
    message: anyFits
      ? `No tier reaches ${model.targetTokensPerSecond} tok/s for ${model.activeWeightsBytes ?? model.weightsBytes} B of active weights. Best available: ${Math.max(...fp16.map((e) => e.predicted_tokens_per_second))} tok/s.`
      : `Model does not fit on any tier even with q8_0 KV. ${fp16.map((e) => `${e.label}: ${e.reject_reason}`).join("; ")}`,
    rationale: { solver_config: SOLVER_CONFIG, attempts },
  };
}

/**
 * containerDiskInGb, sized from the SELECTED VARIANT's bytes — not the repo's (PRD §4.3.4).
 * 1.5x the weight bytes covers the HF download plus its transient copy; +16 GB covers the
 * container image and runtime scratch. For the MVP target (16 810 714 528 B) this is 40 GB.
 */
export function containerDiskGb(weightsBytes) {
  return Math.ceil((weightsBytes / GIB) * 1.5) + 16;
}

/** volumeInGb — a network volume only above the threshold (NFR-CACHE-011). */
export function volumeGb(weightsBytes) {
  if (weightsBytes <= SOLVER_CONFIG.volume_threshold_bytes) return 0;
  return Math.ceil((weightsBytes / GIB) * 1.5) + 16;
}
