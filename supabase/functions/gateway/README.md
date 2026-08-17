# `gateway` — OpenAI-compatible inference gateway (Supabase Edge Function, Deno)

Request-handling half of the gateway. Owns `index.ts`, `auth.ts`, `resolve.ts`,
`errors.ts`, `deno.json`. `stream.ts` and `usage.ts` are owned by another agent and
are consumed against the frozen interface below.

```
POST /v1/chat/completions   OpenAI Chat Completions, byte-compatible
GET  /v1/models             OpenAI-shaped catalog (public + caller's own private)
OPTIONS *                   CORS preflight
```

Deployed path is `/functions/v1/gateway/v1/…`; the router matches on the `/v1/…`
suffix so both forms work.

## Pipeline order (fail as cheaply as possible — PRD §4.2.2)

| # | Step | Failure | Where |
|---|---|---|---|
| 1 | Bearer shape: `sk-plat-` + 43 url-safe chars | 401 `invalid_api_key` | `auth.ts` |
| 2 | Parse JSON body | 400 | `index.ts` |
| 3 | `creator/model-slug` parse | 400 `invalid_model_format` | `resolve.ts` |
| 4 | Param validation (`n>1`, `logprobs`, `tools`) | 400 / 501 | `index.ts` |
| 5 | SHA-256 the key | — | `auth.ts` |
| 6 | ONE round trip: `api_keys → profiles → custom_models` | 401 / 404 / 503 | `resolve.ts` |
| 7 | `authorize_request()` — balance + suspension, never cached | 402 / 403 | `index.ts` |
| 8 | Build + issue upstream fetch | — | `index.ts` |

Steps 1–4 run before any hashing or IO, so junk traffic never reaches Postgres.

## `gateway_overhead_ms` — instrumentation points (FR-GW-050)

- **Start (`t0`)**: first statement of `handleRequest()` in `index.ts`, before the
  request id is generated. Uses `performance.now()`.
- **Stop**: `const overheadMs = now() - t0` in `handleChatCompletions()`, on the line
  immediately **before** `fetchUpstreamWithRetry(...)` is called — i.e. the last
  instant before the upstream fetch is issued. Nothing between the stop and the
  fetch but the promise construction.
- **Emitted on**: every settled/voided request in the `settle()` log line, every
  rejected request in the `handleRequest()` catch block, and as the
  `x-nexus-overhead-ms` response header on both the streaming and non-streaming
  paths (so a black-box latency test can assert the budget without log access).
- Rejections short-circuit before the upstream fetch, so their `gateway_overhead_ms`
  is total wall time to the error — which is the number you want for a p95 alarm.
- `cache_hit` is emitted alongside it (FR-GW-056) so the ~4 ms LRU saving claimed in
  §4.2.6 is measured rather than assumed.

## Caching boundary (FR-GW-052 / 053 — a security boundary, not an optimization)

| Datum | Cached? |
|---|---|
| `creator/slug` → endpoint, served name, prices, status, visibility, owner | **Yes** — 60 s, per-isolate LRU, max 500 entries |
| API key validity / revocation | **NO** — a revoked key must die immediately |
| Wallet balance | **NO** — read inside `authorize_request` |
| Suspension state | **NO** — read inside `authorize_request` |

`resolveRequest()` therefore *always* issues its round trip; on a model-cache hit it
passes `p_include_model = false` so the query degrades to a key-only lookup. There is
no code path in which a cached value can authenticate a request.

`invalidateModelCache(handle?, slug?)` is the Realtime kill switch (FR-GW-054). The
Realtime subscription on `custom_models` is **not yet wired** — the 60 s TTL is the
only invalidation in place today. See "Gaps" below.

## Required RPC — `gateway_resolve` (NOT in CONTRACTS.md; needs A1)

`resolve.ts` calls one RPC that CONTRACTS.md does not currently define. Suggested
signature (`SECURITY DEFINER`, `search_path = public, pg_temp`, granted to
`service_role` only):

```sql
create or replace function public.gateway_resolve(
  p_key_hash        text,
  p_creator_handle  text,
  p_slug            text,
  p_include_model   boolean default true
) returns jsonb
```

returning

```jsonc
{
  "api_key": { "id": "uuid", "user_id": "uuid", "revoked_at": null },   // or null
  "model":   {                                                          // or null
    "id": "uuid", "user_id": "uuid", "status": "ready", "visibility": "public",
    "deleted_at": null, "runpod_endpoint_id": "…", "served_model_name": "…",
    "runtime": "llamacpp",
    "price_prompt_micro_usd_per_mtoken": 500000,
    "price_completion_micro_usd_per_mtoken": 1500000,
    "platform_fee_bps": 2000, "context_length": 8192, "cold_start_budget_s": 90
  }
}
```

Two constraints on the implementation:

1. **Do not filter the key lookup on `revoked_at is null`.** A revoked key must come
   back so the gateway can answer 401 `revoked_api_key` instead of 401
   `invalid_api_key`. The partial index `api_keys_hash_active_idx` is therefore not
   sufficient on its own; add a plain `(key_hash)` index or make the partial index
   total.
2. **Do not filter the model lookup on visibility or status.** Both halves are
   evaluated in the gateway so that "private, not yours" and "does not exist" produce
   a byte-identical 404 (FR-GW-012), which a DB-side filter cannot express.

Substitute any executor via `setDeps()` / the `exec` dependency — the tests and the
mock upstream harness need no database.

## Interface consumed from `stream.ts` (frozen, owned by A6)

```ts
export function proxyStream(
  upstreamPromise: Promise<Response>,
  onComplete: (usage: UsageResult, meta: StreamMeta) => void,
  opts: { coldStartBudgetMs: number; totalBudgetMs: number; estimateFrom?: { promptChars: number } },
): Response
```

`stream.ts` has landed, so this is a plain static import. It is injected through
`GatewayDeps.proxyStream`, so tests can substitute a fake — the E2E suite drives the
**real** `proxyStream` against a fake upstream.

Contract notes for the consumer side:

- The promise handed to `proxyStream` **never rejects and never resolves non-`ok`**.
  A connection failure or a non-2xx upstream is converted, in `fetchUpstreamWithRetry`,
  into a 200 SSE response whose only content is a terminating error frame plus
  `data: [DONE]`. `proxyStream` can therefore assume a well-formed stream.
- `onComplete` is invoked at most once (guarded); settlement is fired with `void` and
  never awaited in the client-write path (FR-GW-046).

### Settlement predicate — `shouldVoid()`

"Zero tokens produced" is **not** `prompt + completion === 0`. When upstream fails
before emitting a byte, `stream.ts`'s fallback estimator still reports a non-zero
*prompt* count derived from `estimateFrom.promptChars` (FR-GW-044 path 3). Settling on
that bills a caller for GPU work that never happened — an E2E test caught exactly this.

The hold is **voided** when upstream failed, when nothing was reported at all, or when
nothing was generated and the counts are only estimates. It is **settled** whenever
completion tokens were produced, and also when an *authoritative* upstream usage object
reports prefill with an empty completion — the worker really did that work.

## Upstream request (FR-GW-030/031/032)

```
POST {UPSTREAM_BASE_URL}/v2/{runpod_endpoint_id}/openai/v1/chat/completions
Authorization: Bearer {RUNPOD_API_KEY}
```

- `stream: true` is forced **regardless of the client's value**; `stream:false`
  clients get the stream buffered and assembled into one `chat.completion`.
- `stream_options: { include_usage: true }` is always injected.
- `model` is `custom_models.served_model_name`, never `creator/slug`.
- The body is an **allowlist** copy (`HONORED_PARAMS`), so no client-supplied field —
  including a smuggled `authorization` or `api_key` — can be relayed upstream. The
  caller's `sk-plat-` key is never forwarded; upstream sees only `RUNPOD_API_KEY`.
- `UPSTREAM_BASE_URL` is read from env, which is what lets tests point at
  `tools/mock-upstream`.

## Security invariants

- Only the SHA-256 hash of an API key is stored, compared, or logged. The plaintext
  exists exactly twice: the creation response body, and the caller's `Authorization`
  header. `keyFingerprintForLog()` (first 12 hex of the *hash*) is the only key-ish
  value permitted in a log line. There is no debug flag that relaxes this.
- `logJson()` is the single logging call site in the whole function and is typed to a
  closed field set (`GatewayLog`). It has no field for message content, prompt text,
  generated tokens, or key material. Adding one requires editing that interface —
  deliberately.
- Upstream bodies are passed through `sanitizeUpstreamText()` (RunPod endpoint ids,
  URLs, internal hostnames, IPv4 literals, filesystem paths, stack frames, tracebacks)
  before they reach even a *log*. Client-facing messages are fixed strings and never
  include upstream text at all.
- Private-model failure is 404, never 403, and is byte-identical to
  model-does-not-exist.

## Running

Deno is **not installed** in the authoring environment, so the recorded verification
run is the Node one. The test files use `node:test` + `node:assert/strict`, which Deno
also supports, so both commands should work.

```bash
# Deno (the deployment target) — UNVERIFIED here, no Deno binary available
deno task check
deno task test

# Node — the verification that was actually run (43 tests, 0 failures)
npx tsx --test "supabase/functions/gateway/tests/*_test.ts"
```

`tests/gateway_test.ts` is pure unit coverage (hashing, id parsing, envelopes,
private-model 404, upstream builder, sanitization, settlement predicate).
`tests/gateway_e2e_test.ts` drives the real router and the real `stream.ts` against a
fake upstream and fake RPCs.

## Gaps / divergences (also reported to the lead)

1. **`gateway_resolve` RPC does not exist in CONTRACTS.md.** See above.
2. **Check order changed vs. the PRD table.** PRD §4.2.2 lists status (503) at step 5
   and visibility (404) at step 6. That order leaks existence: a stranger probing a
   *private, not-yet-ready* model gets 503 ("exists, unavailable") instead of 404 —
   the exact confirmation FR-GW-012 exists to prevent. Visibility is evaluated first
   here. Observable behavior is unchanged for owners and for public models.
3. **`GatewayErrorCode` has no generic invalid-request code.** Malformed JSON, a
   missing `messages` array, and other body-level faults are reported as
   `unsupported_parameter` (400) because the enum is closed. An
   `invalid_request_error` code would be more honest.
4. **No code for "unknown route".** `POST /v1/embeddings` returns 404
   `model_not_found` with a "Unrecognized request URL" message; a wrong method on a
   known route returns 501. Neither is quite right.
5. **Rate limiting (FR-GW-014) is not implemented.** Step 7 of the PRD table is
   absent; `rate_limit_exceeded` exists in `errors.ts` and is only produced by
   upstream 429 mapping. It is a P1 and needs a store the Edge isolate can share.
6. **`last_used_at` fire-and-forget (FR-GW-013) is not implemented.**
7. **Realtime cache invalidation (FR-GW-054) is not wired** — TTL only.
8. **OOM model flagging (FR-GW-033) is logged, not persisted.** `model_flagged: true`
   appears in the log line; nothing writes to `custom_models`, which is A1's table.
9. **`authorize_request` return shape for suspension is assumed.** CONTRACTS.md says
   `{ok:false, code}` without enumerating codes; this code treats
   `code === "account_suspended"` as 403 and everything else as 402.
