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

## Endpoint authentication — the endpoints are NOT public

Every `@modal.web_server` in `app.py` carries `requires_proxy_auth=True`. Without it a
`*.modal.run` URL is world-reachable, and the URL is the *only* thing between the open
internet and a GPU: anyone who learns or guesses one could run inference on this account's
credits. Metering, balance checks, and the revenue split all live in the gateway, so a
caller who reaches `llama-server` directly bypasses the entire billing layer. Proxy auth is
what makes the gateway the only door.

Modal enforces this at its edge — a rejected request never reaches a container, so it
cannot cold-start a GPU and costs nothing. Verified live:

```
$ curl -i https://<workspace>--nexus-llamacpp-llamaserverl4-serve.modal.run/health?...
HTTP/1.1 401 Unauthorized
modal-http: missing credentials for proxy authorization
```

Same 401 on `/`, `/health`, `/metrics`, `/props`, and `/v1/chat/completions` — the flag is
on the proxied port, so it covers every route llama-server exposes, not just the OpenAI one.
Wrong-but-well-formed credentials get `invalid credentials for proxy authorization`.

### Two credential classes — do not confuse them

| | Prefix | What it is | Who holds it |
|---|---|---|---|
| **API token** | `ak-` / `as-` | deploys and manages the workspace | CI + developer laptops, via `~/.modal.toml` or `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` |
| **Proxy token** | `wk-` / `ws-` | calls a deployed endpoint, nothing else | the gateway only |

They are not interchangeable. The gateway must **never** hold an API token: a proxy token
can only invoke endpoints, while an API token can redeploy or delete the app.

```bash
modal workspace proxy-tokens create      # prints the id and the secret ONCE
modal workspace proxy-tokens list
modal workspace proxy-tokens delete wk-...
```

### The gateway's credential flow

The gateway (`supabase/functions/gateway/`) calls upstream with two environment variables:

```
MODAL_KEY      # the proxy token id     (wk-...)   secret — server-side only
MODAL_SECRET   # the proxy token secret (ws-...)   secret — server-side only
```

Both are **server-side only**, read exclusively inside the Edge Function. They must never
appear in a `NEXT_PUBLIC_*` variable, in any client bundle, in a browser-visible response,
or in a log line — per `docs/CONTRACTS.md` §Environment. A proxy token in a client bundle is
strictly worse than no auth at all: it is a published, permanent key to the GPU that also
looks like it was secured. If a browser needs inference, it calls the gateway and the
gateway calls Modal; the two never meet. (`docs/CONTRACTS.md` §Environment does not yet list
these two names — its owner should add them.)

Sent as either form; both verified live against Modal 1.5.4:

```
Modal-Key: wk-...            Modal-Secret: ws-...
Authorization: Bearer wk-....ws-...      # OpenAI-SDK-compatible single-header form
```

`measure.py --proxy-auth` sends the header-pair form from those same two variables, and
records only the header *names* in its report — never the values. Nothing in this directory
logs or persists a token.

### Verified end to end through the gateway (2026-08-18, modal 1.5.4)

The authenticated path is no longer theoretical. With `requires_proxy_auth=True` live on
`LlamaServerL4`, a fresh proxy token in the gateway's `MODAL_KEY`/`MODAL_SECRET`, and
`UPSTREAM_PROVIDER=modal` + `UPSTREAM_BASE_URL=https://<workspace>--nexus-llamacpp-llamaserverl4-serve.modal.run`:

* unauthenticated `GET /health` and `POST /v1/chat/completions` -> `401 modal-http: missing
  credentials for proxy authorization`, and `modal container list` stayed empty, so the
  rejection really is at the edge and starts no GPU;
* the same endpoint, called by the gateway with the header pair, cold-started in 24.9 s to
  first token (weights `CACHED` from the volume in 0.1 s; `llama-server HEALTHY after 11.0 s`)
  and streamed;
* the stream carried an authoritative `usage` object — `prompt_tokens=53`,
  `completion_tokens=47`, `prompt_tokens_details.cached_tokens=0` — so the gateway settled
  with `usage_estimated = false`. The character estimator did not fire.

`upstream_endpoint_ref` in `custom_models` carries ONLY the query string; the host comes from
`UPSTREAM_BASE_URL`. Re-pointing after a redeploy therefore usually means changing the env
var, not the row — the row only changes when a model's `(repo, file, ctx, parallel)` tuple
changes, because that tuple *is* the container-pool selector.

**Rotation is unresolved.** Modal proxy tokens have no expiry and no built-in rotation, and
`create` is the only way to mint one. Rotating means: create a second token, update
`MODAL_KEY`/`MODAL_SECRET`, redeploy the gateway, then delete the old token — both are valid
during the overlap, so it can be done without downtime. Nothing automates or reminds about
this today, and there is no revocation signal if a token leaks other than noticing. Deciding
an actual rotation cadence and owner is open work, not something this change settles.

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
| `requires_proxy_auth` | Goes on `@modal.web_server`, **not** `@app.cls` — `App.cls` has no such kwarg. It defaults to `False`, so an endpoint is PUBLIC unless you say otherwise, and nothing warns you. |

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
