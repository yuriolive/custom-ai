# tools/modal — llama.cpp serving, capacity solving, and cold-start measurement on Modal

Zero-dependency Python (stdlib + `modal`). Everything except the live deploy runs offline
with no token and no spend.

```
tiers.py          GPU catalog + capacity solver (pure arithmetic, no I/O, no modal import)
app.py            the deployed Modal app: one parameterized llama.cpp class per GPU tier
deploy.py         spec -> deployment config resolver, --dry-run, URL lookup
measure.py        cold/warm measurement + the SSE usage analyzer
test_measure.py   41 offline tests (unittest); end-to-end ones drive tools/mock-upstream
reports/          measurement JSON output (gitignored)
```

## Architecture: why one class per tier, not one app per model

`modal deploy` publishes an **app**. One app per model would mean N deploys, N CI paths,
and N things to reconcile — the RunPod shape, translated badly.

Instead: **GPU is a decorator argument** (it is baked into the container spec and cannot be
a runtime value), and **model identity is a set of `modal.parameter()` fields**. Modal gives
each distinct parameter set its own independently-autoscaled container pool.

```
one deploy  ->  one class per GPU tier  ->  N model pools, each scaling to zero
```

Adding a model to the marketplace is a database row plus a first request. There is no
provisioning mutation, no template id, no endpoint id — and therefore no orphaned resource
to reap. The whole class of bug that needed idempotency and a state file on RunPod does not
exist here.

Scale-to-zero is `scaledown_window=30` + `min_containers=0` on every class. Not knobs.

## Run it

```bash
# 1. Resolve the config offline — no token needed, nothing deployed
python tools/modal/deploy.py --dry-run
python tools/modal/deploy.py --pin-tier l4 --parallel 1

# 2. Tests — no token, no GPU, no spend
cd tools/modal && python -m unittest test_measure -v

# 3. Deploy the app (one time; adding models later needs no redeploy)
cd tools/modal && modal deploy app.py

# 4. Measure a model. Parameters bind through the QUERY STRING.
python tools/modal/measure.py \
  --url https://<workspace>--nexus-llamacpp-llamaserverl4-serve.modal.run \
  --model-repo "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF" \
  --model-file "Qwen3.8-27B-Uncensored-Q4_K_M.gguf" \
  --ctx-size 8192 --parallel 1 \
  --cold-runs 3 --warm-runs 3 --max-tokens 128 \
  --out reports/l4-mvp-target.json

# 5. Tear down when finished — leaves nothing running
modal app stop nexus-llamacpp
modal app list          # confirm
```

On Windows, prefix with `PYTHONIOENCODING=utf-8`: `modal deploy` streams UTF-8 build logs
and the default cp1252 console codec crashes mid-build with a `'charmap' codec` error.

### Credentials

`modal` reads `~/.modal.toml` or `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` from the
environment. Nothing here logs or persists a token. For proxy-authed endpoints, Modal uses
**`Modal-Key` / `Modal-Secret`** headers — *not* `Authorization: Bearer` — which `measure.py
--proxy-auth` sends from `MODAL_KEY`/`MODAL_SECRET`.

## The measurement, and why it exists

`measure.py` forces a scaled-to-zero container, then records time to response headers, time
to first token, decode throughput over ≥64 generated tokens, and total duration — p50/p95
for **cold and warm separately**, because averaging them describes a request nobody makes.

Its most valuable output is the **usage finding**: whether the stream carried a `usage`
object at all, and whether it included `prompt_tokens_details.cached_tokens`. llama.cpp's
emission is build-dependent and nothing errors when it is missing — the stream looks
perfect, the gateway silently falls back to an estimator, and billing drifts with no alarm.
The verdict is deliberately pessimistic: any run without usage downgrades the whole result
to `intermittent`, because an unreliable source is worse than an absent one.

Decode throughput is `(n-1) / (last_token − first_token)` — it excludes TTFT. Not
`tokens/total`, which folds prefill and queueing into a number labelled "tokens per second".

## Gotchas found the hard way

| Gotcha | Consequence |
|---|---|
| `from __future__ import annotations` in `app.py` | Modal reads *runtime* annotations to pick a parameter serializer; PEP 563 stringifies them and decoration dies with `AttributeError: 'str' object has no attribute '__name__'`. Do not add it to `app.py`. |
| `@modal.web_server` readiness | It marks the container ready when the **port accepts connections**. `llama-server` binds immediately and returns `503 {"message":"Loading model"}` for the whole load window, so the first (cold) request fails. `app.py` gates on llama.cpp's `/health` inside `@modal.enter()` instead. |
| `--ctx-size` is **total**, not per-slot | llama.cpp splits it across `--parallel` slots. Passing the per-slot value silently gives each slot `ctx/parallel` tokens and truncates long prompts at runtime. |
| `reasoning_content` | A reasoning model streams its chain-of-thought as `delta.reasoning_content` and only the answer as `delta.content`. Counting only `content` under-counted generated tokens by 89% on the first live run. Both are billed. |
| Hybrid attention/SSM KV | Only `block_count // full_attention_interval` blocks keep a KV cache. Treating all 65 blocks as attention over-counts KV ~4x and picks a GPU two tiers too large. |
| `head_dim` | It is the declared `key_length` (256), **not** `hidden_size / head_count` (213.33). |
| `A10G` | Not a valid Modal GPU string. It is `A10`. |

## The tier list is not a ladder

Bandwidth does not track VRAM, and decode speed is bandwidth-bound:

```
L4         24 GB   300 GB/s   $0.80/hr    same VRAM as the A10, half the speed
A10        24 GB   600 GB/s   $1.10/hr
L40S       48 GB   864 GB/s   $1.95/hr    2x the A10's VRAM, 1.44x its bandwidth
A100-40GB  40 GB  1555 GB/s   $2.10/hr    LESS VRAM than the L40S, 1.8x the bandwidth
```

Selection is `argmin(price)` over tiers satisfying **both** the VRAM fit and the throughput
target. Never index order, never "the bigger card". `test_tier_list_is_not_an_ordered_ladder`
asserts this property actually holds in the data rather than only in this paragraph.
