"""
app.py — llama.cpp serving on Modal, as ONE parameterized class per GPU tier.

═══════════════════════════════════════════════════════════════════════════════
WHY THIS SHAPE

A marketplace serves many models. The obvious translation of the old RunPod design —
one deployed unit per model — is wrong on Modal: `modal deploy` publishes an *app*, and
one app per model means N deploys, N CI paths, and N things to reconcile.

Modal's parameterized classes remove that layer entirely. GPU is a *decorator* argument
(it is baked into the container spec, so it cannot be a runtime value), while the model
identity is a set of `modal.parameter()` fields. Modal then gives EACH DISTINCT PARAMETER
SET its own independently-autoscaled container pool. So:

    one deploy  ->  one class per GPU tier  ->  N model pools, each scaling to zero

Adding a model to the marketplace becomes a database row plus a first request. There is
no provisioning mutation, no template id, no endpoint id, and therefore no orphaned
resource to reap — the entire class of bug the RunPod design needed idempotency and a
state file to defend against simply does not exist here.

The scale-to-zero contract is `scaledown_window=30` + `min_containers=0`, set on every
class below and not exposed as a parameter: they are the unit economics, not a knob.
═══════════════════════════════════════════════════════════════════════════════

Serving is llama.cpp's own `llama-server` behind `@modal.web_server`, which proxies the
container port directly. That gives us llama.cpp's OpenAI-compatible route — including
SSE streaming — with no shim of ours in the path. A shim would be a second place for the
`usage` object to get lost, which is precisely the fact we are trying to measure.
"""

import os
import subprocess
import time

import modal

# NOTE: do NOT add `from __future__ import annotations` to this module. Modal inspects
# the *runtime* annotations of `modal.parameter()` fields to pick a serializer, and PEP
# 563 turns them into strings, which fails with a confusing
# `AttributeError: 'str' object has no attribute '__name__'` at decoration time.

# ── Naming ───────────────────────────────────────────────────────────────────
APP_NAME = "nexus-llamacpp"

# Pinned llama.cpp server image. The tag is part of the billing contract: whether the
# OpenAI route emits a `usage` object is BUILD-dependent, so this string must not float.
# measure.py exists to qualify a candidate tag before it is pinned here.
LLAMACPP_IMAGE = "ghcr.io/ggml-org/llama.cpp:server-cuda"

SERVER_PORT = 8080
HF_CACHE_DIR = "/cache/hf"

# ── Weight cache ─────────────────────────────────────────────────────────────
# A Modal Volume holding the Hugging Face cache. The first cold start on a given model
# pays the full download (~15.7 GiB for the MVP target); every later cold start reads
# from the volume and pays only load time. This is the single biggest lever on cold
# start, and measuring the difference between those two cases is the point of measure.py.
weights_volume = modal.Volume.from_name("nexus-llamacpp-weights", create_if_missing=True)

llamacpp_image = (
    modal.Image.from_registry(LLAMACPP_IMAGE, add_python="3.12")
    # The upstream image's ENTRYPOINT is llama-server itself; Modal needs to run its own
    # container agent as PID 1, so the entrypoint must be cleared.
    .entrypoint([])
    .pip_install("huggingface_hub[hf_transfer]==0.35.3")
    .env(
        {
            "HF_HOME": HF_CACHE_DIR,
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            # Fail loudly instead of silently serving a truncated file.
            "HF_HUB_DISABLE_TELEMETRY": "1",
        }
    )
)

app = modal.App(APP_NAME)


# ═════════════════════════════════════════════════════════════════════════════
# Shared serving logic. Kept as module-level functions so the nine tier classes
# below are pure configuration — the only thing that differs between them is
# `gpu=`, which is exactly the only thing that SHOULD differ.
# ═════════════════════════════════════════════════════════════════════════════


def _download_weights(model_repo: str, model_file: str) -> tuple[str, float, bool]:
    """
    Resolve the specific GGUF file, downloading it into the volume if absent.

    Returns (local_path, seconds_spent, was_cached). The timings are printed to the
    Modal log so a cold start can be decomposed into download vs load — two numbers
    with completely different fixes (a volume vs a smaller quant).
    """
    from huggingface_hub import hf_hub_download

    t0 = time.monotonic()
    # A llama.cpp worker must be given the SPECIFIC FILE, not just the repo. The MVP
    # target repo carries twelve deployable variants spanning a 3x size range plus a
    # draft model and a vision projector; "the repo" does not identify weights.
    path = hf_hub_download(
        repo_id=model_repo,
        filename=model_file,
        cache_dir=HF_CACHE_DIR,
    )
    elapsed = time.monotonic() - t0
    # Under ~2 s means it resolved from the volume rather than the network.
    was_cached = elapsed < 2.0
    size_gib = os.path.getsize(path) / 1024**3
    print(
        f"[weights] {'CACHED' if was_cached else 'DOWNLOADED'} {model_file} "
        f"({size_gib:.2f} GiB) in {elapsed:.1f}s -> {path}",
        flush=True,
    )
    return path, elapsed, was_cached


def _launch_llama_server(model_path: str, ctx_size: int, parallel: int, alias: str) -> None:
    """
    Start llama-server on SERVER_PORT. Modal's web_server proxy waits for the port.

    NOTE on --ctx-size: llama.cpp treats it as the TOTAL context split across `--parallel`
    slots, not the per-slot window. To give every concurrent stream the context the
    creator asked for, the total must be ctx_size * parallel. Passing the per-slot value
    here silently gives each slot ctx_size/parallel tokens — the model appears to work and
    then truncates long prompts, which is the worst possible way to find out.
    """
    total_ctx = ctx_size * parallel
    cmd = [
        "/app/llama-server",
        "--host",
        "0.0.0.0",
        "--port",
        str(SERVER_PORT),
        "--model",
        model_path,
        "--ctx-size",
        str(total_ctx),
        "--parallel",
        str(parallel),
        # Offload every layer; the solver already proved the whole model fits in VRAM.
        "--n-gpu-layers",
        "999",
        "--cont-batching",
        "--flash-attn",
        "on",
        "--metrics",
        "--alias",
        alias,
        "--jinja",
    ]
    print(
        f"[serve] ctx_size(per slot)={ctx_size} parallel={parallel} total_ctx={total_ctx}",
        flush=True,
    )
    print(f"[serve] $ {' '.join(cmd)}", flush=True)
    # Inherit stdout/stderr so llama.cpp's own startup report — including the KV cache
    # size it actually allocates — lands in the Modal log. That number is ground truth
    # against the solver's kv_bytes_per_token arithmetic.
    subprocess.Popen(cmd)


def _wait_until_ready(timeout_s: int = 600) -> float:
    """
    Block until llama-server reports itself HEALTHY, not merely until the port is open.

    This gate is load-bearing and was found the hard way. `@modal.web_server` marks a
    container ready as soon as the port ACCEPTS CONNECTIONS — but llama-server binds the
    port immediately and answers every request with

        HTTP 503  {"error":{"message":"Loading model","code":503}}

    for the whole model-load window. Without this wait, Modal considers the container up,
    routes the very first (cold) request to it, and the caller gets a 503 instead of a
    stream. That is precisely the cold-start path the product depends on, so the failure
    would land on real users and on nobody's test.

    Waiting here instead means the container is only marked ready when it can actually
    serve, and the cold-start cost shows up honestly as latency rather than as an error.
    """
    import urllib.error
    import urllib.request

    t0 = time.monotonic()
    attempt = 0
    while time.monotonic() - t0 < timeout_s:
        attempt += 1
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{SERVER_PORT}/health", timeout=5) as r:
                if r.status == 200:
                    elapsed = time.monotonic() - t0
                    print(
                        f"[serve] llama-server HEALTHY after {elapsed:.1f}s ({attempt} polls)",
                        flush=True,
                    )
                    return elapsed
        except (urllib.error.HTTPError, urllib.error.URLError, OSError):
            pass  # 503 while loading, or connection refused before the bind
        time.sleep(1.0)

    raise RuntimeError(f"llama-server did not become healthy within {timeout_s}s")


# ── Common decorator settings for every tier ─────────────────────────────────
# Modal resolves `modal.parameter()` fields and lifecycle decorators on the concrete
# decorated class, so each tier below restates the same few lines rather than inheriting
# them. The duplication is deliberate: `gpu=` is the only thing that differs, and that is
# the only thing that should differ.
# scaledown_window=30 : seconds of inactivity before the container is torn down.
#                       This IS the scale-to-zero contract. Not creator-configurable.
# min_containers=0    : never hold a GPU warm. Same.
# max_containers=3    : blast-radius bound on what one viral model can spend.
# timeout=900         : max duration of a single proxied request (a long stream).
# startup_timeout=900 : container start budget, which for a cold model includes the
#                       weight download. The default is far too small for 15.7 GiB.
_CLS_KWARGS = dict(
    image=llamacpp_image,
    volumes={"/cache": weights_volume},
    scaledown_window=30,
    min_containers=0,
    max_containers=3,
    timeout=900,
    startup_timeout=900,
)

# web_server startup_timeout covers llama-server binding the port after the weights are
# on local disk — i.e. model load, not download.
_WEB_SERVER_STARTUP_TIMEOUT = 900


@app.cls(gpu="T4", **_CLS_KWARGS)
class LlamaServerT4:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


@app.cls(gpu="L4", **_CLS_KWARGS)
class LlamaServerL4:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


@app.cls(gpu="A10", **_CLS_KWARGS)
class LlamaServerA10:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


@app.cls(gpu="L40S", **_CLS_KWARGS)
class LlamaServerL40S:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


@app.cls(gpu="A100-40GB", **_CLS_KWARGS)
class LlamaServerA10040:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


@app.cls(gpu="A100-80GB", **_CLS_KWARGS)
class LlamaServerA10080:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


@app.cls(gpu="H100", **_CLS_KWARGS)
class LlamaServerH100:
    model_repo: str = modal.parameter()
    model_file: str = modal.parameter()
    ctx_size: int = modal.parameter(default=8192)
    parallel: int = modal.parameter(default=1)

    @modal.enter()
    def prepare(self):
        # Download, launch, AND wait for health — all before Modal marks this container
        # ready. See _wait_until_ready() for why the health gate is not optional.
        self.model_path, _, _ = _download_weights(self.model_repo, self.model_file)
        _launch_llama_server(self.model_path, self.ctx_size, self.parallel, self.model_repo)
        _wait_until_ready()

    @modal.web_server(port=SERVER_PORT, startup_timeout=_WEB_SERVER_STARTUP_TIMEOUT)
    def serve(self):
        # Intentionally empty. llama-server is already running and healthy by the time
        # @enter returns; this method exists only to declare the proxied port.
        pass


# tier id (tiers.py) -> the class deployed for it
TIER_CLASS_NAMES: dict[str, str] = {
    "t4": "LlamaServerT4",
    "l4": "LlamaServerL4",
    "a10g": "LlamaServerA10",
    "l40s": "LlamaServerL40S",
    "a100_40": "LlamaServerA10040",
    "a100_80": "LlamaServerA10080",
    "h100": "LlamaServerH100",
}
