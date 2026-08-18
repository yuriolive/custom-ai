"""
deploy.py — resolve a model spec to a concrete Modal deployment config, and look up the
serving URL for an already-deployed model.

There is deliberately no "provision" step here. On Modal, deploying is a one-time act
that publishes the *app* (`modal deploy app.py`); an individual model is not a resource
that gets created and must later be destroyed — it is a set of class parameters that
selects an autoscaled container pool on first use. So this module only ever:

  1. RESOLVES  a model spec + the GPU tier the solver picks -> the exact runtime config
  2. LOOKS UP  the web URL and query parameters for that model on that tier
  3. PRINTS    all of the above under --dry-run, with no Modal call at all

`--dry-run` imports nothing from `modal` and needs no token, so the config a reviewer
signs off on is verifiable before any credential exists.

SECURITY: no Modal token is read, logged, or persisted by this module.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse

from tiers import (
    GPU_TIERS,
    GIB,
    Infeasible,
    ModelShape,
    MVP_TARGET_SHAPE,
    TIERS_BY_ID,
    select_tier,
)

APP_NAME = "nexus-llamacpp"
SERVER_PORT = 8080
SCALEDOWN_WINDOW_S = 30
MIN_CONTAINERS = 0
MAX_CONTAINERS = 3

# tier id -> the class deployed for it in app.py
TIER_CLASS_NAMES = {
    "t4": "LlamaServerT4",
    "l4": "LlamaServerL4",
    "a10g": "LlamaServerA10",
    "l40s": "LlamaServerL40S",
    "a100_40": "LlamaServerA10040",
    "a100_80": "LlamaServerA10080",
    "h100": "LlamaServerH100",
}


def resolve_config(
    *,
    model_repo: str,
    model_file: str,
    weights_bytes: int,
    context_length: int,
    n_layers: int,
    n_kv_heads: int,
    head_dim: int,
    full_attention_interval: int | None = None,
    ssm_state_size: int | None = None,
    ssm_inner_size: int | None = None,
    target_tokens_per_second: int = 30,
    pin_tier: str | None = None,
    parallel_override: int | None = None,
) -> dict:
    """
    Pure resolution: model spec -> deployment config. No Modal import, no network.
    """
    if not model_file:
        # llama.cpp resolves a FILE; only vLLM resolves a repo. The MVP target repo
        # carries twelve deployable variants spanning a 3x size range, plus a draft model
        # and a vision projector that both match a quant-tag regex. "The repo" does not
        # identify weights, so refusing here is the whole point.
        raise ValueError(
            "model_file is mandatory: llama.cpp must be given the SPECIFIC .gguf file of "
            "the selected variant, not just the repo."
        )
    if not model_file.lower().endswith(".gguf"):
        raise ValueError(f"model_file {model_file!r} is not a .gguf file")

    shape = ModelShape(
        weights_bytes=weights_bytes,
        context_length=context_length,
        n_layers=n_layers,
        n_kv_heads=n_kv_heads,
        head_dim=head_dim,
        full_attention_interval=full_attention_interval,
        ssm_state_size=ssm_state_size,
        ssm_inner_size=ssm_inner_size,
        target_tokens_per_second=target_tokens_per_second,
    )

    if pin_tier:
        if pin_tier not in TIERS_BY_ID:
            raise ValueError(f"unknown tier {pin_tier!r}; known: {', '.join(TIERS_BY_ID)}")
        from tiers import evaluate_tier

        ev = evaluate_tier(TIERS_BY_ID[pin_tier], shape)
        tier = TIERS_BY_ID[pin_tier]
        parallel = parallel_override or max(1, ev.max_concurrent_streams)
        placement_source = "pinned"
        predicted = ev.predicted_tokens_per_second
        cost_floor = ev.cost_floor_micro_per_mtoken
        evaluations = [ev]
        fits = ev.fits
    else:
        placement = select_tier(shape)
        tier = placement.tier
        parallel = parallel_override or placement.max_concurrent_streams
        placement_source = "solver"
        predicted = placement.predicted_tokens_per_second
        cost_floor = placement.cost_floor_micro_per_mtoken
        evaluations = placement.evaluations
        fits = True

    class_name = TIER_CLASS_NAMES.get(tier.id)
    params = {
        "model_repo": model_repo,
        "model_file": model_file,
        "ctx_size": context_length,
        "parallel": parallel,
    }

    return {
        "app_name": APP_NAME,
        "class_name": class_name,
        "gpu": tier.modal_gpu_string,
        "tier_id": tier.id,
        "tier_label": tier.label,
        "placement_source": placement_source,
        "fits": fits,
        "class_parameters": params,
        "scaling": {
            "scaledown_window_s": SCALEDOWN_WINDOW_S,
            "min_containers": MIN_CONTAINERS,
            "max_containers": MAX_CONTAINERS,
        },
        "capacity": {
            "weights_gib": round(weights_bytes / GIB, 2),
            "kv_bytes_per_token": shape.kv_bytes_per_token,
            "attention_layers": shape.n_attention_layers,
            "ssm_layers": shape.n_ssm_layers,
            "kv_gib_per_stream": round(shape.kv_bytes_per_token * context_length / GIB, 3),
            "max_concurrent_streams": parallel,
            "predicted_tokens_per_second": predicted,
            "cost_floor_micro_per_mtoken": cost_floor,
            "usd_per_hour_micro": tier.usd_per_hour_micro,
        },
        # llama.cpp splits --ctx-size across --parallel slots, so the total must be
        # multiplied out to give each stream the context the creator actually asked for.
        "llama_server_total_ctx": context_length * parallel,
        "evaluations": [e.__dict__ for e in evaluations],
    }


def web_url(class_name: str, params: dict, workspace: str | None = None) -> str:
    """
    The serving URL for a parameterized class.

    Modal binds class parameters through the QUERY STRING; the query string is what
    selects the container pool, and the path is forwarded to the container's own server.
    The host form is:

        https://{workspace}--{app-name}-{classname-lowercased}-{method}.modal.run

    Prefer resolve_url_via_sdk() when a token is available — this formula is a
    documented convenience for dry runs, not the authority.
    """
    ws = workspace or "{workspace}"
    host = f"{ws}--{APP_NAME}-{class_name.lower()}-serve.modal.run"
    return f"https://{host}/v1/chat/completions?{urllib.parse.urlencode(params)}"


def resolve_url_via_sdk(class_name: str, params: dict) -> str:
    """Authoritative lookup of a deployed class's web URL. Requires a Modal token."""
    import modal  # imported lazily so --dry-run needs neither modal nor a token

    cls = modal.Cls.from_name(APP_NAME, class_name)
    obj = cls(**params)
    base = obj.serve.get_web_url()
    return f"{base.rstrip('/')}/v1/chat/completions?{urllib.parse.urlencode(params)}"


def render(cfg: dict) -> str:
    L = ["=" * 78, "Modal deployment config (DRY RUN — nothing deployed, nothing spent)", "=" * 78]
    L.append(f"  app                    {cfg['app_name']}")
    L.append(f"  class                  {cfg['class_name']}   (@app.cls(gpu=\"{cfg['gpu']}\"))")
    L.append(f"  tier                   {cfg['tier_label']}  [{cfg['tier_id']}]  via {cfg['placement_source']}")
    L.append("")
    L.append("  class parameters (bound as URL query params -> one container pool each)")
    for k, v in cfg["class_parameters"].items():
        L.append(f"    {k:<16} {v}")
    L.append("")
    s = cfg["scaling"]
    L.append("  scaling (platform-enforced, not creator-configurable)")
    L.append(f"    scaledown_window   {s['scaledown_window_s']}s")
    L.append(f"    min_containers     {s['min_containers']}")
    L.append(f"    max_containers     {s['max_containers']}")
    L.append("")
    c = cfg["capacity"]
    L.append("  capacity")
    L.append(f"    weights            {c['weights_gib']} GiB")
    L.append(f"    attention layers   {c['attention_layers']} of {c['attention_layers'] + c['ssm_layers']} (rest are SSM, no KV cache)")
    L.append(f"    kv per token       {c['kv_bytes_per_token']} B ({c['kv_bytes_per_token'] / 1024:.0f} KiB)")
    L.append(f"    kv per stream      {c['kv_gib_per_stream']} GiB at {cfg['class_parameters']['ctx_size']} ctx")
    L.append(f"    max concurrent     {c['max_concurrent_streams']} streams")
    L.append(f"    predicted speed    {c['predicted_tokens_per_second']} tok/s")
    L.append(f"    GPU price          ${c['usd_per_hour_micro'] / 1e6:.2f}/hr")
    if c["cost_floor_micro_per_mtoken"]:
        L.append(f"    cost floor         {c['cost_floor_micro_per_mtoken']} micro-USD / 1M tokens")
    L.append("")
    L.append(f"  llama-server --ctx-size {cfg['llama_server_total_ctx']} --parallel {cfg['class_parameters']['parallel']}")
    L.append(f"    (total ctx = per-slot ctx x parallel — llama.cpp splits it across slots)")
    L.append("")
    L.append("  serving URL")
    L.append(f"    {web_url(cfg['class_name'], cfg['class_parameters'])}")
    L.append("")
    L.append("  tiers considered")
    for e in cfg["evaluations"]:
        mark = "->" if e["tier_id"] == cfg["tier_id"] else "  "
        L.append(
            f"   {mark} {e['tier_id']:<9} fits={str(e['fits']):<5} speed={str(e['meets_speed']):<5} "
            f"par={e['max_concurrent_streams']:>3} tps={e['predicted_tokens_per_second']:>4} "
            f"${e['usd_per_hour_micro'] / 1e6:.2f}/hr  {e['reject_reason'] or ''}"
        )
    L.append("=" * 78)
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Resolve a Modal deployment config for a GGUF model.")
    ap.add_argument("--model-repo", default="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF")
    ap.add_argument("--model-file", default="Qwen3.8-27B-Uncensored-Q4_K_M.gguf")
    ap.add_argument("--weights-bytes", type=int, default=MVP_TARGET_SHAPE["weights_bytes"])
    ap.add_argument("--context", type=int, default=8192)
    ap.add_argument("--n-layers", type=int, default=MVP_TARGET_SHAPE["n_layers"])
    ap.add_argument("--n-kv-heads", type=int, default=MVP_TARGET_SHAPE["n_kv_heads"])
    ap.add_argument("--head-dim", type=int, default=MVP_TARGET_SHAPE["head_dim"])
    ap.add_argument("--full-attention-interval", type=int, default=MVP_TARGET_SHAPE["full_attention_interval"])
    ap.add_argument("--ssm-state-size", type=int, default=MVP_TARGET_SHAPE["ssm_state_size"])
    ap.add_argument("--ssm-inner-size", type=int, default=MVP_TARGET_SHAPE["ssm_inner_size"])
    ap.add_argument("--target-tps", type=int, default=30)
    ap.add_argument("--pin-tier", default=None, help=f"pin a tier: {', '.join(TIERS_BY_ID)}")
    ap.add_argument("--parallel", type=int, default=None, help="override solved concurrency")
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--url-only", action="store_true", help="resolve the live URL via the Modal SDK (needs a token)")
    args = ap.parse_args(argv)

    try:
        cfg = resolve_config(
            model_repo=args.model_repo,
            model_file=args.model_file,
            weights_bytes=args.weights_bytes,
            context_length=args.context,
            n_layers=args.n_layers,
            n_kv_heads=args.n_kv_heads,
            head_dim=args.head_dim,
            full_attention_interval=args.full_attention_interval,
            ssm_state_size=args.ssm_state_size,
            ssm_inner_size=args.ssm_inner_size,
            target_tokens_per_second=args.target_tps,
            pin_tier=args.pin_tier,
            parallel_override=args.parallel,
        )
    except (ValueError, Infeasible) as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1

    if args.url_only:
        print(resolve_url_via_sdk(cfg["class_name"], cfg["class_parameters"]))
        return 0
    print(json.dumps(cfg, indent=2) if args.json else render(cfg))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
