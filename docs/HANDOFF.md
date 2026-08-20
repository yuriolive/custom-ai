# Handoff — 2026-08-18

State at the end of the first build session. Read this first tomorrow.

## Where things stand

**MVP-0 works end to end.** A real `openai` SDK client, unmodified except `base_url` and `api_key`, streams tokens from a scale-to-zero llama.cpp worker on Modal and settles atomically. Verified against live infrastructure, not mocks:

```
[PASS] acceptance_stream :: chunks=42 ttft=20.94s total=23.84s
[PASS] revoked_key_401 · unknown_model_404 · bad_key_401 · client_disconnect
```

Billing checked against real rows: `ceil(53×0.5)+ceil(42×1.5) = 90` micro-USD, platform `18`, creator `72` — exact. One `wallet_ledger` row per transaction, `v_balance_drift` returns zero rows, and a client that hung up mid-stream was still billed its full 400 tokens.

**Tests:** 363 node across 6 test groups (362 pass, 1 skipped) · 339 pgTAP · 48 Python.
CI runs all of them. Node and pgTAP re-measured 2026-08-20 — the pgTAP figure by RUNNING
them (`npx supabase test db --local supabase/tests` reports its own total), not by summing
`plan()` declarations, which is what the two figures before this one were. `npm run test:app`
now also globs `components/**/*.test.ts`, so a pure module under `components/` is testable
where it was not before.

## Branches

| Branch | State |
|---|---|
| `mvp-0-foundation` | Green. All work above. This is the trunk. |
| `wip/frontend-auth-console` | **Incomplete, do not merge.** Snapshot of three agents stopped mid-build. |

## Resume here

The three frontend agents were stopped mid-task so the machine could shut down safely. Their partial work is on `wip/frontend-auth-console`, and each was interrupted at a known point:

- **auth** — furthest along; was partway through the session-aware nav edit
- **console** — had finished auth wiring, was starting the console itself
- **marketplace** — was about to write the snippet generator, the most important element on that page

Known failing: `lib/console/queries.ts:189` (oxlint `no-array-sort`). There will be more — none of that branch passed typecheck, lint, build, or manual exercise.

To resume: check out the branch, re-read the **frozen** "Frontend / auth contract" section of `CONTRACTS.md`, finish each surface, then verify with `npm run typecheck && npm run lint && npm run build` before merging.

## Blocked on credentials

1. **Modal proxy token.** The endpoints were shipping publicly reachable (`requires_proxy_auth` defaults to `False`); that is fixed and verified in both directions. But the agent deleted the token it minted, so a real inference run needs `modal workspace proxy-tokens create` and `MODAL_KEY` / `MODAL_SECRET` in `supabase/functions/.env`. **Without them the next run returns 500 `internal_error`, which looks like a gateway bug but is a missing credential.**
2. **The authenticated Modal path is unverified.** The passing acceptance run hit the endpoint *before* proxy auth was enabled. The code path exists and is untested.
3. **Hosted Supabase is NOT untouched — this entry was wrong.** The Supabase GitHub integration has been applying migrations to `gexxzdlppbplfpfqhszf` on every merge to main since PR #13, which deployed `20260819000200_tool_calling.sql` there. Its `Supabase Preview` check is the only signal we get, and nothing in this repo reads it. `SUPABASE_ACCESS_TOKEN` is still needed to inspect remote migration history directly — the state above was reconstructed from check-run summaries.

## Measured facts worth not re-deriving

| | |
|---|---|
| Cold start | 115 s first-ever · **23 s** with the weights Volume warm · 0.93 s warm |
| Decode | 14 tok/s on L4 (predicted 13 — MFU 0.75 is close, real ~0.79) |
| Prompt eval | 133 tok/s — **prefill, not decode, dominates any large stable prefix** |
| KV cache | 64 KiB/token (16 of 65 attention layers, hybrid SSM) |
| Target model | `qwen35`, hybrid attention/SSM, 262144 native context, **bf16 source exists** |

## Anthropic Messages API — added 2026-08-19

`POST /v1/messages`, `POST /v1/messages/count_tokens` and an Anthropic-shaped
`GET /v1/models` are served by `supabase/functions/gateway/anthropic.ts`, on `x-api-key`
(bearer still accepted), through the same pipeline and the same settlement as
`/v1/chat/completions` — `handleChatCompletions` was split so both routes call one
`runInference()`. Tool calling (PR #13) is the prerequisite that makes it useful: an
Anthropic client that cannot call a tool connects and does nothing.

Two things worth not re-deriving:

- **The re-framing runs downstream of `proxyStream`, not instead of it.** Usage therefore
  still comes from the OpenAI byte tee. Reading it from `message_delta` instead would be a
  second billing path to keep in step with the first.
- **The adapter's error precedence is `type` before `code`, which inverts ours.** Our
  envelopes carry a coarse `type` (`api_error`) and a precise `code` (`model_unavailable`),
  so passing both collapses every 503 to `api_error/500` and every 404/401 to a flat 400.
  `anthropic.ts` drops the `type` when a `code` is present; that is what makes 529
  `overloaded_error` come out right.

Not verified against a live `claude` session — the coverage is unit + e2e against a fake
upstream, which cannot prove an agent loop completes at 14 tok/s.

## Known-open, deliberately

- **Warm TTFT p50 926 ms misses NFR-CS-002** (400 ms). Recorded as a miss, not restated to match what we measured.
- **MFU is a guessed 0.75.** Tier selection and $0.85/hr rest on it — A10 vs L40S flips on this constant.
- **`active_weights_bytes`** equals total weights. Correct for this dense model; diverges only for MoE.
- No Stripe by decision. Wallet balance and ledger read fine without it.
- **`20260819000200` is a burned migration version.** Two files collided on it (see
  `20260819000200_collided_version_placeholder.sql`); both were renumbered to `…000300` and
  `…000400`, and a no-op placeholder holds the original version so that databases which
  already recorded it — including the hosted project — still resolve it to a local file.
  `_tool_calling` and `_api_key_usage_counters` are both written to be re-runnable
  (`if not exists` / `drop … if exists`), so they apply cleanly over objects that already
  exist. No `migration repair` is needed anywhere. Do not reuse that version number;
  `npm run check:migrations` now rejects it along with any other duplicate.

## The lesson this session kept teaching

Every P1 bug found had the same shape: **it failed silently rather than loudly.**

- Seed API keys were the wrong length — valid at INSERT, rejected at the gateway's shape check, surfacing as a mysterious 401
- `performance.now()` into an `integer` column — settlement threw *after* the GPU work was delivered, stranding the row as `reserved` and unbilled
- Modal endpoints public — worked perfectly, just bypassed all billing
- A renamed column left a dead name inside an RLS policy — semantically correct, `db reset` reported success
- Counting only `delta.content` on a reasoning model — under-counts billed output by 89%, in the platform's favour, so nothing complains

Where a check is cheap, make the failure loud. `seed.sql`'s assertion block and the in-migration RLS-reference assertions are the pattern; both caught real problems that a passing test run had already declared fine.
