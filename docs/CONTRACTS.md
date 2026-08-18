# Frozen Contracts — MVP-0

**Status: FROZEN.** Agents build against this. Do not redefine these shapes locally. If something here is wrong or insufficient, say so in your report — do not silently diverge, because another agent is building against the same text.

MVP-0 objective, and the only acceptance test that matters:

```python
client = OpenAI(base_url="<gateway>/v1", api_key="sk-plat-...")
stream = client.chat.completions.create(
    model="JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
    messages=[{"role": "user", "content": "hi"}],
    stream=True, timeout=180,
)
```
→ tokens stream from a scale-to-zero llama.cpp worker, and exactly one `usage_transactions` row settles with a correct 80/20 split and no negative balance.

Everything not required by that sentence is out of scope for MVP-0.

## Directory layout & file ownership

One owner per path. Never edit a path you do not own; if you need a change there, report it.

```
packages/shared/          types only, no runtime deps   [contract — owned by lead]
packages/hf-probe/        HF probe + variant classifier + GGUF header   [A3]
tools/mock-upstream/      fake RunPod SSE server         [A4]
supabase/migrations/      schema, RLS, RPCs              [A1]
supabase/tests/           pgTAP billing invariants       [A2]
supabase/functions/gateway/
    index.ts  auth.ts  resolve.ts  errors.ts             [A5]
    stream.ts usage.ts                                   [A6]
app/ + root configs       Next.js 15 + Tailwind v4 + HeroUI v3   [A7]
tests/fixtures/           shared fixtures                [contract — read-only]
```

## Environment

```
SUPABASE_URL, SUPABASE_ANON_KEY            # client-safe
SUPABASE_SERVICE_ROLE_KEY                  # secret, Edge Functions only
RUNPOD_API_KEY                             # secret
RUNPOD_ENDPOINT_ID                         # MVP-0: one manually provisioned endpoint
LLAMACPP_WORKER_IMAGE                      # pinned, usage-emitting build
UPSTREAM_BASE_URL                          # override → point at mock-upstream in tests
```

Never read a secret from a `NEXT_PUBLIC_*` variable. Never log an API key, an HF token, or a bearer header.

## Money

All money is `BIGINT` micro-USD (1 unit = $0.000001). **No floats anywhere in a monetary path** — not in SQL, not in TS, not in JSON. Prices are micro-USD per 1,000,000 tokens.

```
cost_micro = GREATEST(1,  CEIL(prompt_tokens     * price_prompt_micro     / 1e6)
                        + CEIL(completion_tokens * price_completion_micro / 1e6))
platform_micro = CEIL(cost_micro * fee_bps / 10000)   -- remainder to platform
creator_micro  = cost_micro - platform_micro          -- sum is exact
```

The `GREATEST(1, …)` minimum billable unit (FR-BIL-004) is deliberate: without it, any
request whose token counts round to zero micro-USD engages a GPU for free, which is a
trivially exploitable free-inference path on cheaply-priced models. A settlement that
delivered **zero** tokens is voided rather than charged the floor, so the floor only ever
applies when real work was done.

**Reasoning models:** `completion_tokens` from the worker covers BOTH `delta.content` and
`delta.reasoning_content`. Any local estimator must count both — the MVP's own target model
streams chain-of-thought as `reasoning_content`, and counting only `content` under-counts
billed output by up to 89%.

## Gateway wire contract

`POST /v1/chat/completions` — OpenAI Chat Completions, byte-compatible. `model` is `creator/model-slug`.

Errors always use the OpenAI envelope:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": "insufficient_balance" } }
```

| HTTP | code | when |
|---|---|---|
| 400 | `invalid_model_format` | `model` has no `/` |
| 401 | `invalid_api_key` / `revoked_api_key` | bad or revoked key |
| 402 | `insufficient_balance` | available balance below hold |
| 404 | `model_not_found` | unknown, **or private and caller is not owner** |
| 503 | `model_unavailable` | not `ready` |
| 504 | `cold_start_timeout` / `stream_timeout` | budget exceeded |

Non-negotiable behaviors:

1. Response headers flush **before** the upstream fetch is issued.
2. While upstream is silent, emit `: keepalive\n\n` every 5 s. Stops on first upstream byte, never resumes.
3. Upstream bytes forwarded **verbatim**. Tee for usage; never parse-and-reserialize.
4. Gateway always requests `stream: true` upstream, even for non-streaming clients (buffer and assemble), **and always injects `stream_options: { include_usage: true }`**. vLLM emits no usage without that flag — forgetting it silently drops every request onto the estimator with no error raised anywhere. llama.cpp ignores the flag, so send it unconditionally rather than branching on runtime.
5. Settlement runs **outside** the client-write path — a client disconnect must not cause unbilled GPU work.
6. **Never cache** API key validity, wallet balance, or suspension state.

## Upstream contract (RunPod / mock)

```
POST {UPSTREAM_BASE_URL}/v2/{endpoint_id}/openai/v1/chat/completions
Authorization: Bearer {RUNPOD_API_KEY}
```
Standard OpenAI SSE: `data: {chunk}\n\n` … `data: [DONE]\n\n`.

**The MVP target is llama.cpp, so usage on the final chunk is NOT guaranteed.** Consumers must handle both. See `UsageResult.source`.

## RPC contract

```
authorize_request(p_txn_id uuid, p_user_id uuid, p_api_key_id uuid, p_model_id uuid,
                  p_est_prompt_tokens int, p_max_tokens int, p_was_streaming bool)
  -> {ok, txn_id, hold_micro_usd, balance_micro_usd} | {ok:false, code}

deduct_token_cost(p_txn_id uuid, p_prompt_tokens int, p_completion_tokens int,
                  p_ttft_ms int, p_duration_ms int, p_cold_start bool,
                  p_usage_estimated bool, p_client_disconnected bool)
  -> {ok, cost_micro_usd, creator_micro_usd, platform_micro_usd, balance_micro_usd}

void_reservation(p_txn_id uuid, p_error_code text, p_error_message text)
credit_wallet(p_user_id uuid, p_amount_micro_usd bigint, p_kind ledger_kind,
              p_stripe_event_id text, p_stripe_session_id text, p_memo text)
```

All are `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `EXECUTE` revoked from `anon`/`authenticated`, granted to `service_role` only.

**Invariants that must hold under concurrency** (A2 asserts these adversarially):

- **I1** `profiles.balance_micro_usd` never goes negative
- **I2** a transaction settles at most once (retry returns the original result)
- **I3** `creator_micro + platform_micro == cost_micro`, exactly
- **I4** every balance mutation has exactly one `wallet_ledger` row
- **I5** concurrent requests on one wallet cannot collectively overdraw

Lock order is always `usage_transactions` → `profiles(payer)` → `profiles(creator)`.

## Definition of done

Your work is done when it builds clean, its tests pass, and someone else can use it from the contract alone. Report honestly: if a test fails or you skipped something, say so plainly with the output. A green report that hides a failure costs more than the failure.
