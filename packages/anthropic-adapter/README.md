# @nexus/anthropic-adapter

Bidirectional translation between the **Anthropic Messages API** and **OpenAI Chat
Completions**, so that Claude Code — and any Anthropic-SDK client that honours
`ANTHROPIC_BASE_URL` — can talk to an OpenAI-compatible inference gateway.

Pure functions plus one state machine. **Zero runtime dependencies**, no I/O, no
imports from the gateway. Explicit `.ts` import specifiers throughout, so it runs
unchanged under Node 24 native type-stripping and under Deno, with no build step.

```ts
import {
  translateRequest,
  translateResponse,
  AnthropicStreamTranslator,
  translateError,
} from "@nexus/anthropic-adapter";
```

## Surfaces

| | Function | Notes |
|---|---|---|
| Request | `translateRequest(req, opts?)` | → `{ request, warnings }`. Throws `AnthropicAdapterError` on unrepresentable input. |
| Response | `translateResponse(resp, opts?)` | → `{ message, warnings }`. |
| Stream | `new AnthropicStreamTranslator(opts)` | `.push(chunk)` / `.finish()` → `AnthropicStreamEvent[]`. Also `translateStream()` (chunks in, events out) and `translateSseText()` (raw SSE text in, Anthropic SSE text out). |
| Errors | `translateError(body, httpStatus?)` | → `{ status, body }`. Never throws. |

Framing helpers: `formatSseEvent`, `formatSseEvents`, `createSseDecoder`,
`isDoneSentinel`.

Everything that cannot be represented across the boundary is reported in a
`warnings: string[]` rather than dropped silently.

## ⚠️ Known deviations from the Anthropic wire contract

These are the places where a client that trusts the Anthropic spec literally will
be wrong when talking through this adapter. Read them.

### 1. `message_start.usage.input_tokens` is **0**

Anthropic knows the prompt token count before generation and reports it in
`message_start`. Our upstream (llama.cpp / vLLM) reports usage only on the
**final** chunk. So `message_start` carries `{ input_tokens: 0, output_tokens: 0 }`
and the real numbers arrive in `message_delta.usage`.

**A consumer that bills, budgets, or displays from `message_start.usage` will
under-count to zero.** Read usage from `message_delta` only.

Two mitigations exist:

- Pass `inputTokens` in `StreamTranslatorOptions` if the caller already has an
  estimate (the gateway does this: it passes the same estimate that sized the
  authorization hold).
  It is then reported in `message_start` and used as the `message_delta` fallback
  when upstream reports nothing at all.
- `message_delta.usage` includes `input_tokens`. Anthropic itself emits
  `input_tokens` in `message_delta` on server-tool turns, so this is
  contract-legal, but it is *not* what a plain text turn from Anthropic looks
  like — there, `message_delta.usage` carries `output_tokens` only.

Anthropic also reports a small **non-zero** `output_tokens` (1–3) in
`message_start`; we report 0.

### 2. `thinking` blocks carry an empty `signature`

Anthropic emits a `signature_delta` immediately before a thinking block's
`content_block_stop`; the signature is an opaque integrity token minted by
Anthropic. We cannot mint one, and fabricating a plausible-looking string would
be worse than omitting it. So:

- `content_block_start` for a thinking block is `{"type":"thinking","thinking":"","signature":""}`
- `thinking_delta` events are emitted normally
- **no `signature_delta` is emitted**

A client that round-trips a thinking block back to *real* Anthropic will have it
rejected. Round-tripping it back to *this* adapter is fine: input `thinking`
blocks are dropped by default (`thinkingBlocks: "drop"`), because OpenAI Chat
Completions has no field for prior chain-of-thought and reasoning models
regenerate their own.

### 3. Reasoning content is mapped, never dropped

Our target model streams chain-of-thought as `delta.reasoning_content`
(some servers use `delta.reasoning`; both are accepted). It maps to a `thinking`
block. Per `docs/CONTRACTS.md`, `completion_tokens` covers both `content` and
`reasoning_content`, so **dropping reasoning under-counts billed output by up to
89%**. This adapter never drops it, and warns loudly when a stream produced
output but reported no usage.

### 4. Stop-sequence detection is best-effort

OpenAI's `finish_reason: "stop"` is ambiguous — natural end of turn *or* a stop
sequence hit — and the standard response says nothing about which sequence matched.
Detection consults, in order:

1. `choice.stop_reason` — a vLLM extension carrying the matched string.
2. A suffix match of the emitted text against the request's `stop_sequences`.

**llama.cpp strips the stop sequence and reports neither**, so a genuine
stop-sequence hit against llama.cpp is reported as `end_turn`. In the
non-streaming path the matched sequence is removed from the text (as Anthropic
does); in the streaming path it cannot be, because the bytes are already gone.

### 5. Other lossy edges (all warned)

- `tool_choice.disable_parallel_tool_use` — no OpenAI equivalent.
- `thinking` request config — no OpenAI equivalent; the upstream model decides
  on its own whether to emit `reasoning_content`.
- `metadata` — no OpenAI equivalent.
- `n > 1` — Anthropic Messages has no multi-choice shape; `choice[0]` only.
- Images inside a `tool_result` — OpenAI `{role:"tool"}` messages are text-only.
- A tool `function.name` arriving *after* its first argument fragment cannot be
  represented, because Anthropic pins the name into `content_block_start`.

## Corrections to the original spec

Verified against the current published contract
(`platform.claude.com/docs/en/api/messages` and `.../build-with-claude/streaming`,
fetched 2026-08-17):

- **Every event's `data` payload repeats the event name in a `type` field.**
  `content_block_stop` is `{"type":"content_block_stop","index":0}`, not `{index}`.
  Both the `event:` line and `data.type` must be present — SDK clients validate
  the latter.
- **`message_start.message` includes `stop_reason: null` and `stop_sequence: null`**
  alongside `id/type/role/model/content/usage`.
- **`message_delta.usage` is cumulative**, and may legally include `input_tokens`
  (Anthropic does so on server-tool turns).
- **`stop_reason` has seven values**, not four: `end_turn`, `max_tokens`,
  `stop_sequence`, `tool_use`, `pause_turn`, `refusal`,
  `model_context_window_exceeded`. OpenAI's `content_filter` maps to `refusal`.
- **`tool_choice` has a fourth variant**, `{type:"none"}` → OpenAI `"none"`.
- **Thinking blocks need a `signature_delta`** before `content_block_stop` — see
  deviation 2.
- **Anthropic error types include `billing_error` (402), `request_too_large`
  (413) and `timeout_error` (504)** beyond the seven originally listed.
- Anthropic emits its `ping` right after the first `content_block_start`, and
  further pings are sprinkled through the stream. We match that shape:
  one ping after the first block opens, then one every `pingEveryDeltas`
  (default 25) content deltas.

## What a gateway still has to do

**This is now done, in `supabase/functions/gateway/anthropic.ts` + `index.ts`.** The
list below is kept as the specification that file is written against — read it as
"what the gateway does", not "what is missing". Two answers differ from what the list
anticipated and are called out inline: items 5 and 7.

This library is pure translation. Exposing it as `POST /v1/messages` requires, on
the gateway side:

1. **Auth header translation.** Anthropic clients send `x-api-key: <key>` (and
   `anthropic-version: 2023-06-01`, and often `anthropic-beta`). OpenAI clients
   send `Authorization: Bearer <key>`. The gateway must accept `x-api-key`,
   fall back to `Authorization`, and resolve it against the same API-key table
   `/v1/chat/completions` uses. Per `docs/CONTRACTS.md`, key validity is **never
   cached**.
2. **Routing and model mapping.** Claude Code sends `model: "claude-opus-5"` (and
   a small `claude-*-haiku` for its background tasks). Something must map those to
   `creator/model-slug`. That mapping is policy, not translation, so it is not in
   this library — pass the result via `TranslateRequestOptions.model`.
3. **`/v1/messages/count_tokens`.** Claude Code calls it. There is no OpenAI
   equivalent; the gateway must answer with its own estimator.
4. **`GET /v1/models`** in Anthropic's shape (`{data:[{type:"model",id,display_name,created_at}]}`),
   which differs from OpenAI's.
5. **Non-streaming responses assembled from a stream.** `docs/CONTRACTS.md` #4
   requires the gateway to always request `stream: true` upstream. For a
   non-streaming `/v1/messages` call it must buffer and assemble, then use
   `translateResponse`. This library does not do the assembling.
   *As built:* `assembleFromSse()` in `index.ts` does it once, for both routes —
   including per-index reassembly of `tool_calls[].function.arguments`, which
   arrive as fragments split mid-JSON.
6. **Header flush order and keepalives.** Flush response headers before the
   upstream fetch; emit `: keepalive\n\n` every 5 s while upstream is silent
   (`docs/CONTRACTS.md` #2). SSE comment frames are ignored by `createSseDecoder`,
   so they compose safely.
7. **Verbatim-forwarding is impossible on this path.** `docs/CONTRACTS.md` #3
   requires the OpenAI path to forward upstream bytes untouched. `/v1/messages`
   cannot: the whole point is re-framing.
   *As built, usage does NOT come from the translator.* The re-framing runs
   DOWNSTREAM of the same `proxyStream` the OpenAI route uses, so the byte tee
   still sees ordinary OpenAI chunks and settlement is byte-identical between the
   two routes. Deriving usage from `message_delta` instead would have created a
   second billing path to keep in step with the first — the failure mode being
   that only one of them counts `reasoning_content`.
8. **Error status codes.** `translateError` returns the status to use, but the
   gateway owns actually setting it, plus `retry-after` on 429 and
   `request-id`/`anthropic-*` response headers if it wants SDK parity.
9. **Cancellation.** A client disconnect must still settle billed work; this
   library holds no resources and needs no teardown, but the caller must call
   `finish()` to get final usage out of a partially consumed stream.

## Tests

```
npm test --workspace @nexus/anthropic-adapter
npx tsc -p packages/anthropic-adapter --noEmit
```
