# mock-upstream

Zero-dependency (node:http only) mock of **RunPod's OpenAI-compatible serverless route**.
It exists so gateway work does not need a live GPU or a ~101 s cold start per test cycle.

```
POST {UPSTREAM_BASE_URL}/v2/{endpointId}/openai/v1/chat/completions
Authorization: Bearer {RUNPOD_API_KEY}     # accepted and recorded, never validated
```

Anything else → `404`. Non-`POST` on the route → `405`. Unparseable JSON body → `400`.
All error bodies use the OpenAI envelope: `{"error":{"message","type","param","code"}}`.

Point `UPSTREAM_BASE_URL` at the mock's `url` and the gateway needs no other change.

---

## Run it standalone

```bash
node tools/mock-upstream/cli.ts --port 8787
node tools/mock-upstream/cli.ts --port 8787 --usage none --cold-start-ms 3000 --quiet
node tools/mock-upstream/cli.ts --help
```

Every control below is also a `--kebab-case` CLI flag that changes the **server-wide default**;
per-request headers/query params still win.

## Use it from tests

```js
import { startMockUpstream } from "../../tools/mock-upstream/index.ts";

const mock = await startMockUpstream({ port: 0 }); // 0 => ephemeral port
process.env.UPSTREAM_BASE_URL = mock.url; // http://127.0.0.1:53211

mock.setDefaults({ usage: "none", coldStartMs: 100 }); // server-wide defaults
// ... drive the gateway ...
const r = mock.lastRequest();
assert.equal(r.stream, true); // gateway forced stream:true
assert.equal(r.authorization, "Bearer " + RUNPOD_API_KEY); // platform key not forwarded
mock.reset(); // clear mock.requests
await mock.close(); // destroys hung sockets too
```

`startMockUpstream({ port, host, defaults, log })` resolves to:

| member                 | meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `url`                  | `http://127.0.0.1:<port>` — use as `UPSTREAM_BASE_URL`             |
| `port`                 | actual bound port (resolved when `port: 0`)                        |
| `requests`             | live array of every received request, in order                     |
| `lastRequest()`        | last element of `requests`                                         |
| `reset()`              | empties `requests`                                                 |
| `setDefaults(partial)` | merges into server-wide defaults, returns the merged object        |
| `getDefaults()`        | current defaults                                                   |
| `close()`              | destroys all sockets (including `fail=hang`) and closes the server |
| `server`               | the raw `node:http` server                                         |

Each recorded request:

```js
{
  (at,
    method,
    url,
    path,
    query,
    endpointId,
    headers, // ALL raw headers — assert the platform key never appears here
    authorization, // convenience copy of headers.authorization
    rawBody,
    body,
    bodyParseError,
    stream, // body.stream — assert the gateway forced true
    streamOptions, // body.stream_options
    model,
    messages,
    options); // the fully resolved mock options for this request
}
```

---

## Control surface (frozen — build against this)

Per-request, via **header** or **query param**. Precedence:
**header > query param > `setDefaults()` / CLI flag > built-in default**.
An unrecognized or malformed value is ignored (falls through to the next level).

| Option              | Header                       | Query param           | Default | Meaning                                                                                                                                        |
| ------------------- | ---------------------------- | --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| cold start          | `x-mock-cold-start-ms`       | `cold_start_ms`       | `0`     | withhold **every** byte, response headers included, for N ms. Handles `100000`.                                                                |
| token delay         | `x-mock-token-delay-ms`      | `token_delay_ms`      | `0`     | ms between content frames                                                                                                                      |
| token count         | `x-mock-tokens`              | `tokens`              | `8`     | number of content frames / `completion_tokens`                                                                                                 |
| usage mode          | `x-mock-usage`               | `usage`               | `full`  | `full` \| `basic` \| `none` — see below                                                                                                        |
| honor include_usage | `x-mock-honor-include-usage` | `honor_include_usage` | `false` | vLLM semantics: when `true`, a **streaming** response emits usage only if the body carries `stream_options: {include_usage: true}` — see below |
| usage placement     | `x-mock-usage-placement`     | `usage_placement`     | `auto`  | `auto` \| `separate` \| `final`                                                                                                                |
| failure mode        | `x-mock-fail`                | `fail`                | `none`  | `none` \| `500` \| `429` \| `404` \| `drop` \| `hang` \| `malformed`                                                                           |
| drop point          | `x-mock-drop-after`          | `drop_after`          | `3`     | content tokens emitted before `fail=drop` kills the socket                                                                                     |
| malformed point     | `x-mock-malformed-after`     | `malformed_after`     | `2`     | token index before which `fail=malformed` injects a bad frame                                                                                  |
| prompt tokens       | `x-mock-prompt-tokens`       | `prompt_tokens`       | `11`    | reported `usage.prompt_tokens`                                                                                                                 |
| cached tokens       | `x-mock-cached-tokens`       | `cached_tokens`       | `0`     | `usage.prompt_tokens_details.cached_tokens` (`usage=full` only)                                                                                |
| token text          | `x-mock-token-text`          | `token_text`          | `null`  | repeat this string instead of the built-in lorem                                                                                               |
| finish reason       | `x-mock-finish-reason`       | `finish_reason`       | `stop`  | value on the final chunk                                                                                                                       |
| model echo          | `x-mock-model`               | `model`               | `null`  | override the echoed model name (default: echo request `model`)                                                                                 |

Programmatic names are camelCase of the same options: `coldStartMs`, `tokenDelayMs`, `tokens`,
`usage`, `honorIncludeUsage`, `usagePlacement`, `fail`, `dropAfter`, `malformedAfter`,
`promptTokens`, `cachedTokens`, `tokenText`, `finishReason`, `model`.
Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`.

### `honorIncludeUsage` — catching a silent gateway regression

`docs/CONTRACTS.md` requires the gateway to inject `stream_options: { include_usage: true }` on
every upstream request. Real vLLM only emits usage when that flag is present, so if the injection
regresses **nothing errors** — vLLM returns no usage, the gateway's estimator quietly takes over,
and billing drifts. `honorIncludeUsage` reproduces exactly that.

| `honorIncludeUsage` | request body                            | result                                                     |
| ------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `false` (default)   | anything                                | usage per the `usage` mode — existing behaviour, unchanged |
| `true`              | `stream_options.include_usage === true` | usage per the `usage` mode                                 |
| `true`              | flag absent, or `include_usage: false`  | **no usage anywhere**, regardless of `usage`               |

`stream_options` is a streaming-only field, so `stream: false` responses ignore this option.
Turn it on in gateway tests that must fail loudly the moment the injection is dropped:

```js
mock.setDefaults({ honorIncludeUsage: true, usage: "full" });
// drive the gateway, then assert usage arrived — it only can if the flag was injected
assert.equal(mock.lastRequest().streamOptions.include_usage, true);
```

### Streaming vs non-streaming

`stream: false` in the body → one assembled `chat.completion`. **Anything else (including an
absent `stream`) streams** — the gateway always sends `stream: true`, and this default makes a
bare curl useful. Assert on `requests[i].stream` to prove what the gateway actually sent.

### Usage modes — why they matter

The MVP target is llama.cpp, whose usage emission is build-dependent.

| mode    | shape                                                                                                                                     | placement (`auto`)                                        | models the                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `full`  | `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` | **separate** trailing chunk with `"choices":[]`           | vLLM                                                                                         |
| `basic` | `prompt_tokens`, `completion_tokens`, `total_tokens` only                                                                                 | on the **final** chunk (the one carrying `finish_reason`) | llama.cpp best case                                                                          |
| `none`  | no `usage` key anywhere in the stream                                                                                                     | —                                                         | llama.cpp worst case → forces the gateway's estimator (`UsageResult.source === "estimated"`) |

Placement and shape are independent: `x-mock-usage-placement` forces `separate` or `final`
regardless of mode, for parsers that must handle both wire layouts.

### Failure modes

| value                 | behaviour                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `500` / `429` / `404` | immediate HTTP status + OpenAI error envelope, **before** any cold-start delay. `429` also sends `retry-after: 1`.                                                              |
| `drop`                | streams `drop_after` content tokens, flushes them, then destroys the socket. No `[DONE]`. Client sees a premature close (`curl: (18)`).                                         |
| `hang`                | accepts the request and writes **nothing at all** — no status line, no headers — holding the socket open until the client gives up or `close()` is called. For timeout budgets. |
| `malformed`           | injects one syntactically-valid SSE frame carrying truncated JSON at token index `malformed_after`, then continues normally and still terminates with `[DONE]`.                 |

Cold start composes with everything except the immediate HTTP failures: `fail=hang` with
`cold_start_ms` still writes nothing, and `fail=drop` drops after the cold start elapses.

---

## Copy-pasteable curl

Assume `node tools/mock-upstream/cli.ts --port 8787` is running, and:

```bash
URL=http://127.0.0.1:8787/v2/ep_abc123/openai/v1/chat/completions
BODY='{"model":"JonathanColetti/Qwen3.8-27B-Uncensored-GGUF","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

**Baseline stream (usage=full, vLLM shape)**

```bash
curl -N -H 'Content-Type: application/json' -H 'Authorization: Bearer rp-fake-key' -d "$BODY" "$URL"
```

**usage=basic — llama.cpp best case (usage on the finish chunk, no cached_tokens)**

```bash
curl -N -H 'Content-Type: application/json' -H 'x-mock-usage: basic' -d "$BODY" "$URL"
```

**usage=none — llama.cpp worst case (estimator path)**

```bash
curl -N -H 'Content-Type: application/json' -H 'x-mock-usage: none' -d "$BODY" "$URL"
```

**Cold start + usage=none — the MVP's actual worst case (2 s here; use 101000 for the real thing)**

```bash
curl -N -w '\n[curl] ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  -H 'Content-Type: application/json' \
  -H 'x-mock-cold-start-ms: 2000' -H 'x-mock-usage: none' \
  -H 'x-mock-tokens: 5' -H 'x-mock-token-delay-ms: 120' \
  -d "$BODY" "$URL"
```

**The real 101 s cold start (exercises the 5 s keepalive loop — expect ~20 `: keepalive` frames from the gateway)**

```bash
curl -N -H 'Content-Type: application/json' -H 'x-mock-cold-start-ms: 101000' -d "$BODY" "$URL"
```

**Slow token stream**

```bash
curl -N -H 'Content-Type: application/json' -H 'x-mock-tokens: 40' -H 'x-mock-token-delay-ms: 250' -d "$BODY" "$URL"
```

**Query params instead of headers (handy in a browser or a fixed-header client)**

```bash
curl -N -H 'Content-Type: application/json' -d "$BODY" "$URL?usage=none&cold_start_ms=1500&tokens=4"
```

**Upstream 500 / 429 / 404**

```bash
curl -i -H 'Content-Type: application/json' -H 'x-mock-fail: 500' -d "$BODY" "$URL"
curl -i -H 'Content-Type: application/json' -H 'x-mock-fail: 429' -d "$BODY" "$URL"   # + retry-after: 1
curl -i -H 'Content-Type: application/json' -H 'x-mock-fail: 404' -d "$BODY" "$URL"
```

**Connection dropped mid-stream after 1 token**

```bash
curl -N -H 'Content-Type: application/json' -H 'x-mock-fail: drop' -H 'x-mock-drop-after: 1' -H 'x-mock-tokens: 9' -d "$BODY" "$URL"
# => two frames, then: curl: (18) transfer closed with outstanding read data remaining
```

**Hang forever, no bytes (timeout testing)**

```bash
curl -N --max-time 5 -H 'Content-Type: application/json' -H 'x-mock-fail: hang' -d "$BODY" "$URL"
# => curl: (28) Operation timed out
```

**Malformed SSE frame mid-stream**

```bash
curl -N -H 'Content-Type: application/json' -H 'x-mock-fail: malformed' -H 'x-mock-tokens: 3' -d "$BODY" "$URL"
```

**vLLM `include_usage` semantics — usage present only when the flag is injected**

```bash
# flag injected => usage arrives
curl -N -H 'Content-Type: application/json' -H 'x-mock-honor-include-usage: true' \
  -d '{"model":"m","messages":[],"stream":true,"stream_options":{"include_usage":true}}' "$URL" | tail -4

# flag missing => no usage anywhere, even though usage=full is the default
curl -N -H 'Content-Type: application/json' -H 'x-mock-honor-include-usage: true' \
  -d '{"model":"m","messages":[],"stream":true}' "$URL" | tail -4
```

**Non-streaming**

```bash
curl -H 'Content-Type: application/json' -H 'x-mock-tokens: 3' \
  -d '{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":false}' "$URL"
```

---

## Tests

```bash
cd tools/mock-upstream && node --test "test/*.test.ts"
```

26 tests, ~1.3 s, no network, no dependencies.
