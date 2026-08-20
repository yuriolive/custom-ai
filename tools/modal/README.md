# tools/modal — llama.cpp serving, capacity solving, and cold-start measurement on Modal

Zero-dependency Python (stdlib + `modal`). Everything except the live deploy runs offline
with no token and no spend.

```
tiers.py          GPU catalog + capacity solver (pure arithmetic, no I/O, no modal import)
sync_rates.py     refresh prices from `modal billing rates --json` (LOCAL: needs a token)
app.py            the deployed Modal app: one parameterized llama.cpp class per GPU tier
supervisor.py     llama-server supervision: poll loop, output tee, failure classifier
deploy.py         spec -> deployment config resolver, --dry-run, URL lookup
measure.py        cold/warm measurement + the SSE usage analyzer
test_measure.py   offline tests (unittest); end-to-end ones drive tools/mock-upstream
test_supervisor.py  offline tests for the supervision above, incl. real subprocesses
test_tier_drift.py  CI-enforced: tiers.py vs the gpu_tiers state the migrations leave
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
cd tools/modal && uv run --locked python -m unittest test_measure test_tier_drift test_supervisor -v

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
gateway calls Modal; the two never meet.

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

## llama-server is supervised, and its death ends the container

A GPU that cannot serve still bills. Until this was fixed, a container whose
`llama-server` died during model load sat in the health-poll loop against a dead port
for the full 600 s window — the handle from `subprocess.Popen(cmd)` was dropped, and
one `except OSError: pass` covered both "still loading" and "exited ten seconds ago".
Observed live: CUDA OOM on a 46 GiB KV allocation, server gone 10 s in, no `HEALTHY`
line and no exception anywhere in the container log.

`supervisor.py` holds the fix, and it is a separate module for a reason: `app.py`
imports `modal`, `modal` is not installed on the path CI runs, so anything in `app.py`
is untestable. Every judgement call lives in `supervisor.py` with a test; `app.py`
stays wiring. The cost of that split is one line — `add_local_python_source`, because
Modal 1.x no longer auto-mounts local Python modules.

| | |
|---|---|
| **Death beats diagnosis** | `proc.poll()` runs before every `/health` probe. A returncode is exact and free; the probe is neither, and each one is GPU-seconds. An exit nine seconds in raises at t≈10s. |
| **600 s is still 600 s** | The ceiling is unchanged and is only ever reached by a process that is *still alive* — a genuinely slow load of a large model. Lowering it was the tempting fix and the wrong one. |
| **Tee, do not capture** | llama.cpp's startup report prints the KV cache size it ACTUALLY allocated — the only ground truth against the solver's `kv_bytes_per_token`. It keeps streaming to the Modal log; a 50-line ring buffer feeds the raised error in parallel. |
| **Three states, not two** | `HEALTHY` / `LOADING` (bound, answering 503) / `UNBOUND` (nothing listening). `HTTPError` and `URLError` are both `OSError`, which is exactly how the two got conflated. The timeout message now says *which* kind of stuck. |
| **Post-ready watchdog** | A daemon thread `wait()`s on the child and `os._exit(70)`s the container when it dies. `sys.exit` would unwind one thread and leave Modal's runner advertising a closed port for the rest of `scaledown_window`. A `@modal.exit` teardown sets a flag so an ordinary scaledown is not mistaken for a crash. |

### Do not pay to fail twice

A load failure is a property of the tuple `(gpu, image, model_repo, model_file,
ctx_size, parallel)` — the same tuple that *is* Modal's container-pool selector. Retrying
it is not optimism, it is a guaranteed repeat charge, multiplied by `max_containers=3`
when requests arrive together.

So a failure is classified, and a **permanent** one (CUDA OOM, KV cache that does not
fit, unreadable GGUF, unsupported architecture) leaves a sentinel JSON file under
`/cache/load-failures/<key>.json` on the weights Volume. `@modal.enter` reads it before
anything else, so the next cold start of that tuple costs container boot instead of
download + load + poll.

Three rules make that safe, and all three are tested:

* **Transient and unclassified failures write nothing.** A download error or an exit we
  could not read is not evidence the model is unloadable, and refusing to serve on that
  basis would cost more than the repeat charge it saves. `SIGKILL` with no message counts
  as unclassified — it is usually the host OOM-killer, not the GPU.
* **A death *after* readiness is never cached.** A server that reached `HEALTHY` has
  proved the tuple loads; the death was about one request. Caching it would take a
  working model out of service.
* **The GPU is part of the key.** All nine tier classes mount the *same* Volume, and a
  CUDA OOM on an L4 says nothing whatsoever about an H100.

`NEXUS_IGNORE_LOAD_FAILURE_CACHE=1` bypasses the sentinel for one cold start; deleting
the file clears it permanently.

Every failure also prints one greppable line —
`[serve] LOAD-FAILURE {"kind":…,"code":…,"hint":…}` — which is the **interim** channel to
the control plane. Nothing in this container holds a credential that could write
`custom_models`, and it should not: creator-supplied weights execute here. Taking the
model row out of `ready` with the reason, and showing that reason in the provisioning
stepper, still needs a channel that does not put a service-role key next to a GGUF.

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
| A dropped `Popen` handle | Nothing notices the server died. The health poll cannot tell "loading" from "long dead", so a container that can never serve bills for the whole 600 s window and does it again next request. See the supervision section above. |
| `sys.exit` from a watchdog thread | Unwinds that thread only. Modal's runner stays up, still advertising a port nothing is listening on, for the rest of `scaledown_window`. `os._exit` is the one that reaps the container. |
| Local imports in `app.py` | Modal 1.x removed automounting. A module imported by `app.py` needs `Image.add_local_python_source(...)` or the container dies at import with `ModuleNotFoundError`. |
| An uncommitted Volume write | Invisible to the next container. A sentinel written and never `commit()`ed is a sentinel that saves nothing, and the watchdog is about to `os._exit`. |
| `requires_proxy_auth` | Goes on `@modal.web_server`, **not** `@app.cls` — `App.cls` has no such kwarg. It defaults to `False`, so an endpoint is PUBLIC unless you say otherwise, and nothing warns you. |

## There are two tier catalogs, and only one of them bills anyone

| | Read by | Authority for |
|---|---|---|
| `tools/modal/tiers.py` | `deploy.py`, `measure.py`, the tests | what the Python tooling provisions |
| `public.gpu_tiers` (SQL) | `public.resolve_placement()` at **request time** | the tier a model actually lands on, and `cost_floor_micro_per_mtoken` |

The SQL table is the one that costs money. `resolve_placement()` walks it
`order by usd_per_hour_micro asc` and derives the cost floor from the row it picks, so a
price that is too low there means the platform sells GPU time under cost — which is
exactly what happened: the table shipped with RunPod hardware and RunPod prices (`l40s`
$0.86 vs Modal's $1.95, `h100` $2.99 vs $3.95) and an `rtx4090` tier Modal does not rent
at all. Migration `20260819000100_gpu_tiers_modal_catalog.sql` brought it onto Modal's
catalog.

Keeping them together:

```bash
# Are the committed prices still Modal's published ones? LOCAL ONLY — needs a Modal token.
cd tools/modal && python sync_rates.py --check

# Same, but rewrite tiers.py and emit a migration with the UPDATEs, for review.
cd tools/modal && python sync_rates.py

# Do the two committed catalogs agree? Offline, no credential — this one runs in CI.
cd tools/modal && python -m unittest test_tier_drift -v
```

The drift check is **enforced**: it runs in the `python` job of `.github/workflows/ci.yml`
and fails the build on any mismatch of id, VRAM, bandwidth, price, provider GPU string, or
a solver constant the two sides share. It reads the migrations directly, so it needs no
Postgres and no network. Set equality on `solver_config` is deliberately *not* required —
`prefix_cache_reserve`, `volume_threshold_bytes` and `download_bytes_per_s` are SQL-path
constants with no Python counterpart — but every shared key must match.

A retired tier is `is_enabled = false`, never deleted: `custom_models.gpu_tier_id` is an
FK onto the table and `gpu_usd_per_hour_micro_snapshot` exists so settled cost math stays
reproducible (FR-DEP-051).

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
