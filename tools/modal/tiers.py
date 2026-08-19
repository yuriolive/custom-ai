"""
tiers.py — Modal GPU tiers as data, plus the capacity solver.

Two things live here and nothing else: the hardware catalog, and the pure arithmetic
that turns a model's probed shape into a resolved tier. No I/O, no Modal imports — so
`deploy.py --dry-run`, the tests, and (later) the Studio preview can all import it with
no token, no network and no GPU.

═══════════════════════════════════════════════════════════════════════════════
THIS LIST IS NOT AN ORDERED LADDER.

Memory bandwidth is what sets single-stream decode speed (every generated token reads
the active weights once), and bandwidth does NOT track VRAM:

    L4        24 GB VRAM    300 GB/s     <-- same VRAM as the A10, HALF the bandwidth
    A10       24 GB VRAM    600 GB/s
    L40S      48 GB VRAM    864 GB/s     <-- 2x the VRAM of the A10, only 1.44x bandwidth
    A100-40GB 40 GB VRAM   1555 GB/s     <-- LESS VRAM than the L40S, 1.8x the bandwidth

So "the 48 GB card" is slower per stream than "the 40 GB card", and the two 24 GB cards
differ by 2x in speed at nearly the same price. Do not sort this list and call it a
quality ladder; do not present it to a creator as a menu; do not assume the next entry
is better. Selection is argmin(price) over the tiers that satisfy BOTH the VRAM fit and
the throughput target — nothing else.
═══════════════════════════════════════════════════════════════════════════════

Pricing is Modal's published per-second GPU rate (modal.com/pricing), carried here as
integer micro-USD per hour so no float ever enters a monetary path (CONTRACTS.md).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

GIB = 1024**3


@dataclass(frozen=True)
class GpuTier:
    id: str
    label: str
    modal_gpu_string: str  # the exact value passed to @app.cls(gpu=...)
    vram_bytes: int
    memory_bandwidth_bytes_s: int
    # Both derive from ONE published number, Modal's hourly rate: the hourly value is
    # that rate in micro-USD exactly, the per-second value is it divided by 3600 and
    # rounded. Deriving the hour from the rounded second (as two entries here once did)
    # invents up to $0.0004/hr that Modal never charged. tools/modal/sync_rates.py is
    # the only thing that should edit these two fields.
    usd_per_hour_micro: int  # integer micro-USD/hour, exactly Modal's published rate
    usd_per_second_micro: int  # round(usd_per_hour_micro / 3600)
    sort_order: int = 0
    is_enabled: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


# Modal's published GPU catalog. `modal_gpu_string` values are the literals Modal accepts
# in `gpu=`; note "A100-40GB"/"A100-80GB" are explicit, bare "A100" resolves to the 40GB
# part, and "H100" is the 80GB SXM part.
GPU_TIERS: tuple[GpuTier, ...] = (
    GpuTier(
        id="t4",
        label="T4 16GB",
        modal_gpu_string="T4",
        vram_bytes=16 * GIB,
        memory_bandwidth_bytes_s=320_000_000_000,
        usd_per_hour_micro=590_000,
        usd_per_second_micro=164,
        sort_order=10,
    ),
    GpuTier(
        # Same VRAM as the A10 below, HALF its bandwidth, ~70% of its price.
        # Cheapest card that holds a ~16 GB model — and the slowest one that does.
        id="l4",
        label="L4 24GB",
        modal_gpu_string="L4",
        vram_bytes=24 * GIB,
        memory_bandwidth_bytes_s=300_000_000_000,
        usd_per_hour_micro=800_000,
        usd_per_second_micro=222,
        sort_order=20,
    ),
    GpuTier(
        id="a10g",
        label="A10 24GB",
        modal_gpu_string="A10",
        vram_bytes=24 * GIB,
        memory_bandwidth_bytes_s=600_000_000_000,
        usd_per_hour_micro=1_100_000,
        usd_per_second_micro=306,
        sort_order=30,
    ),
    GpuTier(
        # 2x the VRAM of an A10 but only 1.44x the bandwidth: buying it for SPEED is
        # a bad trade, buying it for CAPACITY is a good one. Two different decisions.
        id="l40s",
        label="L40S 48GB",
        modal_gpu_string="L40S",
        vram_bytes=48 * GIB,
        memory_bandwidth_bytes_s=864_000_000_000,
        usd_per_hour_micro=1_950_000,
        usd_per_second_micro=542,
        sort_order=40,
    ),
    GpuTier(
        # LESS VRAM than the L40S, 1.8x the bandwidth. The clearest proof the list
        # is not a ladder: tier order by VRAM and tier order by speed disagree here.
        id="a100_40",
        label="A100 40GB",
        modal_gpu_string="A100-40GB",
        vram_bytes=40 * GIB,
        memory_bandwidth_bytes_s=1_555_000_000_000,
        usd_per_hour_micro=2_100_000,
        usd_per_second_micro=583,
        sort_order=50,
    ),
    GpuTier(
        id="a100_80",
        label="A100 80GB",
        modal_gpu_string="A100-80GB",
        vram_bytes=80 * GIB,
        memory_bandwidth_bytes_s=1_935_000_000_000,
        usd_per_hour_micro=2_500_000,
        usd_per_second_micro=694,
        sort_order=60,
    ),
    GpuTier(
        id="h100",
        label="H100 80GB",
        modal_gpu_string="H100",
        vram_bytes=80 * GIB,
        memory_bandwidth_bytes_s=3_350_000_000_000,
        usd_per_hour_micro=3_950_000,
        usd_per_second_micro=1097,
        sort_order=70,
    ),
    GpuTier(
        id="h200",
        label="H200 141GB",
        modal_gpu_string="H200",
        vram_bytes=141 * GIB,
        memory_bandwidth_bytes_s=4_800_000_000_000,
        usd_per_hour_micro=4_540_000,
        usd_per_second_micro=1261,
        sort_order=80,
    ),
    GpuTier(
        id="b200",
        label="B200 180GB",
        modal_gpu_string="B200",
        vram_bytes=180 * GIB,
        memory_bandwidth_bytes_s=8_000_000_000_000,
        usd_per_hour_micro=6_250_000,
        usd_per_second_micro=1736,
        sort_order=90,
    ),
)

TIERS_BY_ID = {t.id: t for t in GPU_TIERS}


# Solver constants. Config, not code — recalibrate from measured production data.
SOLVER_CONFIG = {
    "mfu": 0.75,  # achieved fraction of theoretical memory bandwidth
    "vram_utilization": 0.92,
    "assumed_utilization": 0.35,  # endpoints are not saturated; used for the cost floor
    "speed_tolerance": 0.90,  # fraction of target tok/s accepted as meeting target
}


@dataclass
class ModelShape:
    """
    A model's probed memory profile. Every field comes from the GGUF key-value header —
    nothing here is guessed, because a model whose memory profile is unknown must be
    rejected rather than provisioned on an assumption.
    """

    weights_bytes: int
    context_length: int
    n_layers: int
    n_kv_heads: int
    head_dim: int
    kv_dtype_bytes: int = 2
    target_tokens_per_second: int = 30
    active_weights_bytes: int | None = None

    # ── Hybrid attention/SSM support ──────────────────────────────────────────
    # Qwen3.5 and friends interleave full-attention blocks with SSM (Mamba-style)
    # blocks. Only the full-attention blocks hold a per-token KV cache; the SSM blocks
    # hold a fixed-size recurrent state that does NOT grow with context. Treating all
    # 65 blocks as attention over-estimates KV by ~4x and picks a GPU two tiers too big.
    full_attention_interval: int | None = None  # e.g. 4 => 1 block in 4 is attention
    ssm_state_size: int | None = None
    ssm_inner_size: int | None = None

    def __post_init__(self):
        if self.active_weights_bytes is None:
            self.active_weights_bytes = self.weights_bytes

    @property
    def n_attention_layers(self) -> int:
        """Blocks that actually keep a KV cache."""
        if not self.full_attention_interval or self.full_attention_interval <= 1:
            return self.n_layers
        return self.n_layers // self.full_attention_interval

    @property
    def n_ssm_layers(self) -> int:
        return self.n_layers - self.n_attention_layers

    @property
    def kv_bytes_per_token(self) -> int:
        """
        kv_bytes_per_token = 2 (K and V) x n_attention_layers x n_kv_heads x head_dim x dtype

        n_kv_heads is the GQA KV head count, NOT n_attention_heads. head_dim is the
        model's declared key_length, NOT hidden_size / head_count — for the MVP target
        those are 256 and 213.33 respectively, and only one of them is right.
        """
        return 2 * self.n_attention_layers * self.n_kv_heads * self.head_dim * self.kv_dtype_bytes

    @property
    def ssm_state_bytes_per_sequence(self) -> int:
        """
        SSM recurrent state: fixed per sequence, independent of context length. Small
        next to KV, but it is per-stream and so it does bound concurrency slightly.
        """
        if not self.ssm_state_size or not self.ssm_inner_size:
            return 0
        return 2 * self.n_ssm_layers * self.ssm_inner_size * self.ssm_state_size

    @property
    def overhead_bytes(self) -> int:
        """CUDA context, compute buffers, framework. max(2 GiB, 10% of weights)."""
        return max(2 * GIB, int(0.10 * self.weights_bytes))


@dataclass
class TierEvaluation:
    tier_id: str
    label: str
    fits: bool
    meets_speed: bool
    usable_vram_bytes: int
    max_concurrent_streams: int
    predicted_tokens_per_second: int
    kv_bytes_per_token: int
    bytes_per_stream: int
    usd_per_hour_micro: int
    cost_floor_micro_per_mtoken: int | None
    reject_reason: str | None


def evaluate_tier(tier: GpuTier, shape: ModelShape) -> TierEvaluation:
    """Pure arithmetic. No I/O."""
    usable = int(tier.vram_bytes * SOLVER_CONFIG["vram_utilization"])
    per_stream = (
        shape.kv_bytes_per_token * shape.context_length + shape.ssm_state_bytes_per_sequence
    )
    budget = usable - shape.weights_bytes - shape.overhead_bytes

    max_concurrent = budget // per_stream if budget > 0 and per_stream > 0 else 0
    fits = max_concurrent >= 1

    predicted = int(
        (tier.memory_bandwidth_bytes_s * SOLVER_CONFIG["mfu"]) / shape.active_weights_bytes
    )
    speed_floor = shape.target_tokens_per_second * SOLVER_CONFIG["speed_tolerance"]
    meets_speed = predicted >= speed_floor

    cost_floor = None
    if fits and predicted > 0:
        gpu_micro_per_sec = tier.usd_per_hour_micro / 3600
        seconds_per_mtoken = 1e6 / (
            predicted * max_concurrent * SOLVER_CONFIG["assumed_utilization"]
        )
        cost_floor = math.ceil(gpu_micro_per_sec * seconds_per_mtoken)

    reason = None
    if not fits:
        if budget <= 0:
            reason = (
                f"weights ({shape.weights_bytes / GIB:.2f} GiB) + overhead "
                f"({shape.overhead_bytes / GIB:.2f} GiB) exceed usable VRAM ({usable / GIB:.2f} GiB)"
            )
        else:
            reason = (
                f"{shape.context_length} context needs {per_stream / GIB:.2f} GiB per stream; "
                f"only {budget / GIB:.2f} GiB remain after weights and overhead"
            )
    elif not meets_speed:
        reason = (
            f"predicted {predicted} tok/s is below the {speed_floor:.1f} tok/s floor "
            f"({shape.target_tokens_per_second} x {SOLVER_CONFIG['speed_tolerance']})"
        )

    return TierEvaluation(
        tier_id=tier.id,
        label=tier.label,
        fits=fits,
        meets_speed=meets_speed,
        usable_vram_bytes=usable,
        max_concurrent_streams=int(max_concurrent),
        predicted_tokens_per_second=predicted,
        kv_bytes_per_token=shape.kv_bytes_per_token,
        bytes_per_stream=per_stream,
        usd_per_hour_micro=tier.usd_per_hour_micro,
        cost_floor_micro_per_mtoken=cost_floor,
        reject_reason=reason,
    )


@dataclass
class Placement:
    tier: GpuTier
    max_concurrent_streams: int
    predicted_tokens_per_second: int
    kv_bytes_per_token: int
    kv_dtype_bytes: int
    cost_floor_micro_per_mtoken: int | None
    evaluations: list[TierEvaluation] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "tier": self.tier.to_dict(),
            "max_concurrent_streams": self.max_concurrent_streams,
            "predicted_tokens_per_second": self.predicted_tokens_per_second,
            "kv_bytes_per_token": self.kv_bytes_per_token,
            "kv_dtype_bytes": self.kv_dtype_bytes,
            "cost_floor_micro_per_mtoken": self.cost_floor_micro_per_mtoken,
            "evaluations": [asdict(e) for e in self.evaluations],
        }


class Infeasible(Exception):
    def __init__(self, code: str, message: str, evaluations: list[TierEvaluation]):
        super().__init__(message)
        self.code = code
        self.evaluations = evaluations


def select_tier(shape: ModelShape, allowed_ids: list[str] | None = None) -> Placement:
    """
    Cheapest tier satisfying BOTH constraints. Tries fp16 KV first and falls back to
    8-bit KV only if fp16 fits nowhere — halving KV to save money is worth a small
    quality cost, halving it when it was never the binding constraint is not.
    """
    attempts: list[TierEvaluation] = []
    candidates_pool = [
        t for t in GPU_TIERS if t.is_enabled and (allowed_ids is None or t.id in allowed_ids)
    ]

    for kv_dtype in (2, 1):
        shape.kv_dtype_bytes = kv_dtype
        evals = [evaluate_tier(t, shape) for t in candidates_pool]
        attempts = evals
        ok = [e for e in evals if e.fits and e.meets_speed]
        if not ok:
            continue
        # argmin(price). NOT argmin(index) — see the header note.
        ok.sort(key=lambda e: (e.usd_per_hour_micro, TIERS_BY_ID[e.tier_id].sort_order))
        winner = ok[0]
        return Placement(
            tier=TIERS_BY_ID[winner.tier_id],
            max_concurrent_streams=winner.max_concurrent_streams,
            predicted_tokens_per_second=winner.predicted_tokens_per_second,
            kv_bytes_per_token=winner.kv_bytes_per_token,
            kv_dtype_bytes=kv_dtype,
            cost_floor_micro_per_mtoken=winner.cost_floor_micro_per_mtoken,
            evaluations=evals,
        )

    shape.kv_dtype_bytes = 2
    any_fits = any(e.fits for e in attempts)
    if any_fits:
        best = max(e.predicted_tokens_per_second for e in attempts)
        raise Infeasible(
            "infeasible_too_slow",
            f"No tier reaches {shape.target_tokens_per_second} tok/s for "
            f"{shape.active_weights_bytes / GIB:.2f} GiB of active weights. Best available: {best} tok/s.",
            attempts,
        )
    raise Infeasible(
        "infeasible_no_fit",
        "Model does not fit on any enabled tier, even with 8-bit KV. "
        + "; ".join(f"{e.label}: {e.reject_reason}" for e in attempts),
        attempts,
    )


# ── The MVP acceptance target, from the live GGUF key-value header ───────────────
# architecture=qwen35  block_count=65  head_count=24  head_count_kv=4  key_length=256
# context_length=262144  full_attention_interval=4  nextn_predict_layers=1
# ssm.state_size=128  ssm.inner_size=6144  ssm.group_count=16
#
# HYBRID attention/SSM: only 65//4 = 16 of the 65 blocks keep a KV cache, so KV is ~4x
# smaller than an all-layers calculation gives. head_dim is the declared key_length 256,
# NOT hidden_size/head_count (= 213.33) — using the latter under-counts KV by 17%.
MVP_TARGET_SHAPE = {
    "weights_bytes": 16_810_714_528,
    "context_length": 8192,
    "n_layers": 65,
    "n_kv_heads": 4,
    "head_dim": 256,
    "full_attention_interval": 4,
    "ssm_state_size": 128,
    "ssm_inner_size": 6144,
    "target_tokens_per_second": 30,
}
