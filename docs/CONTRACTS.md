# Frozen Contracts — MVP-0

**Status: FROZEN.** Agents build against this. Do not redefine these shapes locally. If something here is wrong or insufficient, say so in your report — do not silently diverge, because another agent is building against the same text.

MVP-0 objective, and the only acceptance test that matters:

```python
client = OpenAI(base_url="<gateway>/v1", api_key="sk-plat-...")
stream = client.chat.completions.create(
    model="jonathancoletti/qwen3.8-27b-uncensored-gguf",
    messages=[{"role": "user", "content": "hi"}],
    stream=True, timeout=180,
)
```

> **The platform model id is `creator-handle/model-slug`, not the Hugging Face repo
> path — but CASE does not matter.** Two earlier revisions of this contract were both
> wrong and both were repeated to agents, so the measured behaviour is stated here:
>
> `resolve.ts` lowercases **both halves** of `model` before lookup, so ids are
> case-insensitive. `JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` therefore **resolves
> and streams today (verified, HTTP 200)** — not because HF paths are supported, but
> because this seed's handle and slug happen to equal that path lowercased. It breaks
> the moment they diverge, which is the normal case: the handle is a *platform*
> identity that need not match the HF account, and the slug is chosen at registration.
>
> So: **case is forgiving, names are not.** Do not describe the HF path as an alias,
> and do not describe it as a 404. Whether to add a real HF-path alias is open
> (§8.4 Q14).
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
    anthropic.ts   Anthropic Messages API glue (§4.6)    [A5]
    stream.ts usage.ts                                   [A6]
app/ + root configs       Next.js 15 + Tailwind v4 + HeroUI v3   [A7]
tests/fixtures/           shared fixtures                [contract — read-only]
.beans/                   issue tracker files            [shared — every agent writes]
```

## Environment

```
SUPABASE_URL, SUPABASE_ANON_KEY            # client-safe
NEXT_PUBLIC_SUPABASE_URL                   # browser mirror of SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY              # browser mirror; publishable, powerless without RLS
NEXT_PUBLIC_DEFAULT_MODEL                  # optional — lib/public-env.ts defaults it
NEXT_PUBLIC_COLD_START_ESTIMATE_SECONDS    # optional — defaults to 100
SUPABASE_SERVICE_ROLE_KEY                  # secret, Edge Functions only
PLATFORM_API_KEY                           # secret — the platform's own gateway key
RUNPOD_API_KEY                             # secret
MODAL_KEY                                  # secret — proxy token id  (wk-...)
MODAL_SECRET                               # secret — proxy token     (ws-...)
STRIPE_SECRET_KEY                          # secret
STRIPE_WEBHOOK_SECRET                      # secret — HMAC key for Stripe-Signature
RUNPOD_ENDPOINT_ID                         # MVP-0: one manually provisioned endpoint
LLAMACPP_WORKER_IMAGE                      # pinned, usage-emitting build
UPSTREAM_PROVIDER                          # modal (default) | runpod | mock
UPSTREAM_BASE_URL                          # override → point at mock-upstream in tests
ANTHROPIC_MODEL_MAP                        # Edge Function only — JSON {claude-name: "creator/slug"}
ANTHROPIC_DEFAULT_MODEL                    # Edge Function only — used when no mapping matches
GATEWAY_BASE_URL                           # the playground route POSTs to ${…}/v1/chat/completions
SITE_URL                                   # absolute origin; Stripe redirects AND page metadata
```

`SITE_URL` has ONE consumer contract and two readers, and they must not drift: `lib/billing/server-env.ts` builds Stripe Checkout's success and cancel URLs from it, and `lib/seo/site-url.ts` builds `metadataBase`, canonical URLs, the sitemap and the `Sitemap:` line in `robots.txt`. Two different answers to "where does this site live" is not a cosmetic split — on a custom domain it returns a paying developer to one host while every canonical tag names another. Both fall back the same way: `SITE_URL`, then `VERCEL_PROJECT_PRODUCTION_URL` (stable across deployments), then localhost. `lib/seo` adds `VERCEL_URL` below those so a preview links to itself; it must never outrank the production domain, because a per-deployment hostname in a canonical tag is worse than none.

`NEXT_PUBLIC_DEFAULT_MODEL` and `NEXT_PUBLIC_COLD_START_ESTIMATE_SECONDS` are read only through `lib/public-env.ts`, which supplies a default for each — the seeded model id, and 100 seconds. Both are therefore optional: leaving them unset is a supported configuration, not a missing one, and the fallbacks are the values a fresh deployment runs on.

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

`POST /v1/messages`, `POST /v1/messages/count_tokens` — the Anthropic Messages API (PRD §4.6),
served off the SAME key table, resolver, hold, upstream and settlement. Auth is `x-api-key` with
`Authorization: Bearer` as a fallback. Errors use the Anthropic envelope
(`{"type":"error","error":{"type","message"}}`) with Anthropic's own statuses — notably **529**
`overloaded_error`, where the OpenAI route answers 503. `GET /v1/models` returns the Anthropic
shape when the request carries `x-api-key` or `anthropic-version`, and the OpenAI shape otherwise.

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
   *Exception, `/v1/messages` only:* re-framing OpenAI chunks into Anthropic events IS that
   route's work, so verbatim forwarding is structurally impossible there. The re-framing runs
   DOWNSTREAM of the same proxy, so rules 1, 2, 5 and 6 and the usage tee are untouched — usage
   still comes from the OpenAI bytes, never from the translator.
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

Lock order is always `usage_transactions` → `profiles(payer)` → `profiles(creator)` → `api_keys`.

`api_keys` joined the order in `20260819000400`, which made `authorize_request` the only writer of `api_keys.request_count` / `last_used_at` (FR-CON-001). It is **last** and is a sink — no RPC acquires anything after it — and the bump is a plain UPDATE of non-key columns, so it takes `FOR NO KEY UPDATE` and does not conflict with the `FOR KEY SHARE` the `usage_transactions` FK check just took on the same row. Putting `request_count` under a unique index or a foreign key promotes that lock and deadlocks concurrent requests sharing a key.

## Frontend / auth contract (FROZEN — auth, console and marketplace build against this)

Supabase Auth via `@supabase/ssr`. Three client factories, one per execution context — mixing them up is the usual source of "session works locally, vanishes in production":

```
lib/supabase/client.ts   createClient()        browser / "use client"   — createBrowserClient, anon key
lib/supabase/server.ts   createClient()        RSC + route handlers     — createServerClient, async, cookies()
lib/supabase/middleware.ts updateSession(req)  middleware only          — refreshes the auth cookie
```

Route protection:

| Public | Authenticated |
|---|---|
| `/`, `/models/**`, `/login`, `/signup`, `/auth/**` | `/chat/**`, `/console/**`, `/studio/**`, `/playground/**` |

`/chat` is authenticated for a reason that is not "it feels internal": every turn wakes a metered GPU, so an anonymous turn is inference the platform pays for outright, with no wallet to charge and no creator to pay. That is the same free-inference shape the `GREATEST(1, …)` minimum billable unit above exists to close. Guest mode is a budget and a rate limit, not a flag — see `docs/CHAT-PLAN.md` §7.

**What the browser may do directly** (RLS enforces all of it — no route handler needed):

| Table | Browser access |
|---|---|
| `profiles` | SELECT own; UPDATE only `display_name`, `avatar_url`, `bio` |
| `api_keys` | SELECT own · UPDATE only `name`, `revoked_at` · DELETE own |
| `usage_transactions` | SELECT own |
| `wallet_ledger` | SELECT own |
| `creator_earnings_feed` | SELECT own (view) |
| `custom_models` | SELECT public+ready, or own in any status |

**What it may NOT**, and therefore needs a server route with the service role:

- **Creating an API key.** `api_keys` has no client INSERT policy, by design — the plaintext must be generated server-side, returned exactly once, and never persisted. Reuse `generateApiKey`/`hashApiKey` from `supabase/functions/gateway/auth.ts`; do not write a second implementation of the format.
- **Holding the chat session key.** `/chat` bills the signed-in user, so its browser session carries a real `sk-plat-` key minted by `lib/chat/session-key.ts`, named `Web chat (browser session)` and scoped `['inference','chat']`. The plaintext lives in ONE httpOnly cookie (`__Host-nx_chat_key`, or `nx_chat_key` in development where a `Secure` cookie cannot be set) and is read only by `/api/chat`. It is never in a column, never in a log line, never in a response body. The gateway is unchanged by this: chat turns travel the ordinary authenticated path. Do not add a second credential type to the gateway to avoid the cookie — that trade is written up in `docs/CHAT-PLAN.md` §4.
- Anything touching `usage_transactions`, `wallet_ledger`, `creator_earnings` as a write. Those are RPC-only.

`profiles` rows are created automatically by a trigger on `auth.users`, and `handle` is **immutable** by RLS — there is no handle-claim flow to build. Display it; do not offer to edit it.

`SUPABASE_SERVICE_ROLE_KEY` is server-only and must never appear in a `NEXT_PUBLIC_*` variable or a `"use client"` module. `lib/env.ts` imports `server-only` for this reason, and `npm run check:env` fails the build on violations.

## Definition of done

Your work is done when it builds clean, its tests pass, and someone else can use it from the contract alone. Report honestly: if a test fails or you skipped something, say so plainly with the output. A green report that hides a failure costs more than the failure.
