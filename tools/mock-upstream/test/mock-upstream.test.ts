import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../index.ts";
import type { MockUpstream } from "../index.ts";

let mock: MockUpstream;
const ENDPOINT = "abc123endpoint";
const route = () => `${mock.url}/v2/${ENDPOINT}/openai/v1/chat/completions`;

const BODY: Record<string, unknown> = {
  model: "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

before(async () => {
  mock = await startMockUpstream({ port: 0 });
});
after(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

async function post(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = BODY,
  urlOverride?: string,
): Promise<Response> {
  return fetch(urlOverride ?? route(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer runpod-secret",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Read the whole SSE body as text. */
async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

/** Split SSE text into `data:` payload strings. */
function dataLines(text: string): string[] {
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data: "))
    .map((f) => f.slice("data: ".length));
}

function parsedChunks(text: string): any[] {
  return dataLines(text)
    .filter((d) => d !== "[DONE]")
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return { __malformed: d };
      }
    });
}

// ── 1. baseline streaming ────────────────────────────────────────────────────
test("streams OpenAI chat.completion.chunk frames terminated by [DONE]", async () => {
  const res = await post({ "x-mock-tokens": "4" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);

  const text = await readAll(res);
  const lines = dataLines(text);
  assert.equal(lines.at(-1), "[DONE]");

  const chunks = parsedChunks(text);
  assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");

  const content = chunks
    .flatMap((c) => c.choices)
    .map((ch) => ch?.delta?.content ?? "")
    .join("");
  assert.equal(content.length > 0, true);

  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason === "stop");
  assert.ok(finish, "expected a finish_reason chunk");
  assert.equal(chunks.filter((c) => c.choices?.[0]?.delta?.content).length, 4);
  assert.equal(chunks.at(-1).model, BODY.model);
});

// ── 2. usage modes ───────────────────────────────────────────────────────────
test("usage=full emits prompt/completion + prompt_tokens_details.cached_tokens", async () => {
  const res = await post({
    "x-mock-tokens": "3",
    "x-mock-usage": "full",
    "x-mock-cached-tokens": "7",
  });
  const chunks = parsedChunks(await readAll(res));
  const withUsage = chunks.filter((c) => c.usage);
  assert.equal(withUsage.length, 1);
  const u = withUsage[0].usage;
  assert.deepEqual(withUsage[0].choices, [], "vLLM puts usage on a separate choices:[] chunk");
  assert.equal(u.prompt_tokens, 11);
  assert.equal(u.completion_tokens, 3);
  assert.equal(u.prompt_tokens_details.cached_tokens, 7);
});

test("usage=basic emits prompt/completion only, on the final chunk, no cached_tokens", async () => {
  const res = await post({ "x-mock-tokens": "5", "x-mock-usage": "basic" });
  const chunks = parsedChunks(await readAll(res));
  const withUsage = chunks.filter((c) => c.usage);
  assert.equal(withUsage.length, 1);
  const u = withUsage[0].usage;
  assert.equal(u.prompt_tokens, 11);
  assert.equal(u.completion_tokens, 5);
  assert.equal(u.prompt_tokens_details, undefined);
  assert.equal(
    withUsage[0].choices[0].finish_reason,
    "stop",
    "llama.cpp attaches usage to the finish chunk",
  );
});

test("usage=none emits NO usage object anywhere (llama.cpp worst case)", async () => {
  const res = await post({ "x-mock-tokens": "5", "x-mock-usage": "none" });
  const text = await readAll(res);
  assert.equal(text.includes("usage"), false);
  assert.equal(parsedChunks(text).filter((c) => c.usage).length, 0);
  assert.equal(dataLines(text).at(-1), "[DONE]");
});

test("usage placement can be forced independently of usage mode", async () => {
  const res = await post({
    "x-mock-tokens": "2",
    "x-mock-usage": "full",
    "x-mock-usage-placement": "final",
  });
  const chunks = parsedChunks(await readAll(res));
  const withUsage = chunks.find((c) => c.usage);
  assert.equal(withUsage.choices[0].finish_reason, "stop");
  assert.ok(withUsage.usage.prompt_tokens_details);
});

// ── 2b. honorIncludeUsage (vLLM stream_options semantics) ────────────────────
test("honorIncludeUsage=true: usage IS emitted when stream_options.include_usage is sent", async () => {
  const res = await post(
    { "x-mock-honor-include-usage": "true", "x-mock-tokens": "3", "x-mock-usage": "full" },
    { ...BODY, stream: true, stream_options: { include_usage: true } },
  );
  const chunks = parsedChunks(await readAll(res));
  const withUsage = chunks.filter((c) => c.usage);
  assert.equal(withUsage.length, 1, "gateway injected include_usage => vLLM returns usage");
  assert.equal(withUsage[0].usage.completion_tokens, 3);
  assert.equal(withUsage[0].usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal((mock.lastRequest()!.streamOptions as any).include_usage, true);
});

test("honorIncludeUsage=true: usage is ABSENT when include_usage is missing, even with usage=full", async () => {
  const res = await post(
    { "x-mock-honor-include-usage": "true", "x-mock-tokens": "3", "x-mock-usage": "full" },
    { ...BODY, stream: true }, // no stream_options — the regression this catches
  );
  const text = await readAll(res);
  assert.equal(text.includes("usage"), false, "vLLM stays silent about usage => estimator path");
  assert.equal(parsedChunks(text).filter((c) => c.usage).length, 0);
  assert.equal(dataLines(text).at(-1), "[DONE]");
  assert.equal(mock.lastRequest()!.streamOptions, undefined);
});

test("honorIncludeUsage=true: include_usage:false is treated as missing", async () => {
  const res = await post(
    { "x-mock-honor-include-usage": "1", "x-mock-tokens": "2" },
    { ...BODY, stream: true, stream_options: { include_usage: false } },
  );
  assert.equal((await readAll(res)).includes("usage"), false);
});

test("honorIncludeUsage defaults to false — usage flows without stream_options", async () => {
  const res = await post({ "x-mock-tokens": "2" });
  assert.equal(mock.lastRequest()!.options.honorIncludeUsage, false);
  assert.equal(parsedChunks(await readAll(res)).filter((c) => c.usage).length, 1);
});

// ── 3. cold start ────────────────────────────────────────────────────────────
test("cold start withholds every byte for the configured delay", async () => {
  const DELAY = 300;
  const t0 = Date.now();
  const res = await post({
    "x-mock-cold-start-ms": String(DELAY),
    "x-mock-tokens": "2",
    "x-mock-usage": "none",
  });
  const headersAt = Date.now() - t0;

  const reader = res.body!.getReader();
  const first = await reader.read();
  const firstByteAt = Date.now() - t0;
  await reader.cancel();

  assert.equal(res.status, 200);
  assert.ok(
    headersAt >= DELAY - 30,
    `response headers arrived after ${headersAt}ms, expected >= ${DELAY}`,
  );
  assert.ok(
    firstByteAt >= DELAY - 30,
    `first byte arrived after ${firstByteAt}ms, expected >= ${DELAY}`,
  );
  assert.equal(first.done, false);
});

test("cold start default is 0 (no delay)", async () => {
  const t0 = Date.now();
  const res = await post({ "x-mock-tokens": "1" });
  await readAll(res);
  assert.ok(Date.now() - t0 < 250);
  assert.equal(mock.lastRequest()!.options.coldStartMs, 0);
});

// ── 4. inter-token delay ─────────────────────────────────────────────────────
test("token delay paces the stream", async () => {
  const t0 = Date.now();
  const res = await post({ "x-mock-tokens": "4", "x-mock-token-delay-ms": "40" });
  await readAll(res);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 150, `expected >= 150ms of pacing, got ${elapsed}ms`);
});

// ── 5. failure modes ─────────────────────────────────────────────────────────
for (const status of ["500", "429", "404"]) {
  test(`fail=${status} returns HTTP ${status} with an OpenAI error envelope`, async () => {
    const res = await post({ "x-mock-fail": status });
    assert.equal(res.status, Number(status));
    const json = (await res.json()) as any;
    assert.equal(typeof json.error.message, "string");
    assert.equal(typeof json.error.code, "string");
    if (status === "429") assert.equal(res.headers.get("retry-after"), "1");
  });
}

test("fail=drop cuts the connection mid-stream after N tokens, with no [DONE]", async () => {
  const res = await post({
    "x-mock-fail": "drop",
    "x-mock-drop-after": "2",
    "x-mock-tokens": "10",
  });
  assert.equal(res.status, 200, "headers flush before the drop");

  let text = "";
  let threw: unknown = null;
  try {
    text = await readAll(res);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "reading the truncated body must fail (premature close)");
  assert.equal(text.includes("[DONE]"), false, "no [DONE] on a dropped stream");
});

test("fail=hang sends no bytes at all (client must time out)", async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300);
  let aborted = false;
  const t0 = Date.now();
  try {
    const res = await fetch(route(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-fail": "hang" },
      body: JSON.stringify(BODY),
      signal: ac.signal,
    });
    await readAll(res);
  } catch (err) {
    const e = err as { name?: string; cause?: { name?: string } };
    aborted = e.name === "AbortError" || String(e.cause?.name) === "AbortError";
  } finally {
    clearTimeout(timer);
  }
  assert.equal(aborted, true, "expected no response headers and no bytes within 300ms");
  assert.ok(Date.now() - t0 >= 290);
});

test("fail=malformed injects an unparseable SSE frame but still terminates", async () => {
  const res = await post({
    "x-mock-fail": "malformed",
    "x-mock-tokens": "5",
    "x-mock-malformed-after": "2",
  });
  const text = await readAll(res);
  const chunks = parsedChunks(text);
  const bad = chunks.filter((c) => c.__malformed);
  assert.equal(bad.length, 1, "expected exactly one malformed frame");
  assert.equal(dataLines(text).at(-1), "[DONE]");
});

// ── 6. non-streaming ─────────────────────────────────────────────────────────
test("stream:false returns a single assembled chat.completion", async () => {
  const res = await post({ "x-mock-tokens": "6" }, { ...BODY, stream: false });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /application\/json/);
  const json = (await res.json()) as any;
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.role, "assistant");
  assert.ok(json.choices[0].message.content.length > 0);
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.equal(json.usage.completion_tokens, 6);
  assert.ok(json.usage.prompt_tokens_details);
});

test("stream:false with usage=none has no usage object", async () => {
  const res = await post({ "x-mock-usage": "none" }, { ...BODY, stream: false });
  const json = (await res.json()) as any;
  assert.equal(json.usage, undefined);
});

// ── 7. request recording ─────────────────────────────────────────────────────
test("records what the gateway actually sent upstream", async () => {
  const res = await post(
    { authorization: "Bearer runpod-only-key", "x-mock-tokens": "1" },
    { ...BODY, stream: true, stream_options: { include_usage: true } },
  );
  await readAll(res);

  assert.equal(mock.requests.length, 1);
  const r = mock.lastRequest()!;
  assert.equal(r.method, "POST");
  assert.equal(r.endpointId, ENDPOINT);
  assert.equal(r.path, `/v2/${ENDPOINT}/openai/v1/chat/completions`);
  assert.equal(r.stream, true, "gateway must force stream:true upstream");
  assert.deepEqual(r.streamOptions, { include_usage: true });
  assert.equal(r.authorization, "Bearer runpod-only-key");
  // a platform key must never be forwarded upstream
  assert.equal(r.rawBody.includes("sk-plat-"), false);
  assert.equal(JSON.stringify(r.headers).includes("sk-plat-"), false);
  assert.equal(r.model, BODY.model);
  assert.deepEqual(r.messages, BODY.messages);
});

// ── 8. control precedence & routing ──────────────────────────────────────────
test("query params work and headers beat query params", async () => {
  const res = await post({ "x-mock-tokens": "2" }, BODY, `${route()}?tokens=9&usage=none`);
  const chunks = parsedChunks(await readAll(res));
  assert.equal(chunks.filter((c) => c.choices?.[0]?.delta?.content).length, 2, "header wins");
  assert.equal(chunks.filter((c) => c.usage).length, 0, "query param applied");
});

test("setDefaults changes server-wide defaults; per-request still wins", async () => {
  mock.setDefaults({ usage: "none", tokens: 2 });
  try {
    const a = parsedChunks(await readAll(await post()));
    assert.equal(a.filter((c) => c.usage).length, 0);
    assert.equal(a.filter((c) => c.choices?.[0]?.delta?.content).length, 2);

    const b = parsedChunks(await readAll(await post({ "x-mock-usage": "basic" })));
    assert.equal(b.filter((c) => c.usage).length, 1);
  } finally {
    mock.setDefaults({ usage: "full", tokens: 8 });
  }
});

test("unknown path 404s and non-POST 405s", async () => {
  const bad = await post({}, BODY, `${mock.url}/v2/${ENDPOINT}/openai/v1/embeddings`);
  assert.equal(bad.status, 404);
  const get = await fetch(route(), { method: "GET" });
  assert.equal(get.status, 405);
  await get.body?.cancel();
});

test("token text is overridable", async () => {
  const res = await post({ "x-mock-tokens": "3", "x-mock-token-text": "yo" });
  const chunks = parsedChunks(await readAll(res));
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  assert.equal(content, "yo yo yo");
});

// ── 9. the MVP worst case, end to end ────────────────────────────────────────
test("cold start + usage=none: gateway estimator path with a real delay", async () => {
  const t0 = Date.now();
  const res = await post({
    "x-mock-cold-start-ms": "300",
    "x-mock-usage": "none",
    "x-mock-tokens": "3",
    "x-mock-token-delay-ms": "10",
  });
  const text = await readAll(res);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 300, `expected >= 300ms, got ${elapsed}`);
  assert.equal(text.includes("usage"), false);
  assert.equal(dataLines(text).at(-1), "[DONE]");
  assert.equal(parsedChunks(text).filter((c) => c.choices?.[0]?.delta?.content).length, 3);
});
// ─── tool calls (FR-TOOL-004) ────────────────────────────────────────────────

/** Reassemble `delta.tool_calls` fragments the way a consumer has to. */
function assembleToolCalls(
  frames: string[],
): Map<number, { id: string; name: string; args: string }> {
  const out = new Map<number, { id: string; name: string; args: string }>();
  for (const frame of frames) {
    if (frame === "[DONE]") continue;
    const chunk = JSON.parse(frame) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const acc = out.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) acc.id = call.id;
      if (call.function?.name) acc.name = call.function.name;
      if (typeof call.function?.arguments === "string") acc.args += call.function.arguments;
      out.set(index, acc);
    }
  }
  return out;
}

test("streaming tool calls arrive as fragments that reassemble into valid JSON", async () => {
  const res = await post({ "x-mock-tool-calls": "2", "x-mock-tokens": "0" });
  const frames = dataLines(await readAll(res));

  // The arguments must be SPLIT — a single-frame call would not exercise the
  // reassembly this fixture exists to test.
  const argFrames = frames.filter(
    (f) => f !== "[DONE]" && f.includes('"arguments"') && !f.includes('"name"'),
  );
  assert.ok(argFrames.length >= 4, `expected split arguments, got ${argFrames.length} frames`);

  const calls = assembleToolCalls(frames);
  assert.equal(calls.size, 2);
  const first = calls.get(0)!;
  assert.equal(first.name, "get_weather");
  assert.ok(first.id.startsWith("call_"));
  assert.deepEqual(JSON.parse(first.args), {
    location: "city-0",
    unit: "celsius",
    detailed: true,
  });
  assert.equal(calls.get(1)!.name, "get_weather_2");
  assert.deepEqual(JSON.parse(calls.get(1)!.args).location, "city-1");
});

test("a tool-call stream finishes with tool_calls and counts the tokens", async () => {
  const res = await post({ "x-mock-tool-calls": "1", "x-mock-tokens": "3" });
  const frames = dataLines(await readAll(res));

  const finish = frames
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f) as { choices?: Array<{ finish_reason?: string | null }> })
    .map((c) => c.choices?.[0]?.finish_reason)
    .find((r) => typeof r === "string" && r !== null);
  assert.equal(finish, "tool_calls");

  const usage = frames
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f) as { usage?: { completion_tokens?: number } })
    .map((c) => c.usage)
    .find((u) => u !== undefined);
  // FR-TOOL-006: the tool output is inside completion_tokens, so the count must
  // exceed the 3 content tokens on its own.
  assert.ok(
    (usage?.completion_tokens ?? 0) > 3,
    `expected tool tokens inside completion_tokens, got ${usage?.completion_tokens}`,
  );
});

test("an explicit finish_reason still wins over the tool-call default", async () => {
  const res = await post({
    "x-mock-tool-calls": "1",
    "x-mock-tokens": "0",
    "x-mock-finish-reason": "length",
  });
  const frames = dataLines(await readAll(res));
  const reasons = frames
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f) as { choices?: Array<{ finish_reason?: string | null }> })
    .map((c) => c.choices?.[0]?.finish_reason)
    .filter((r) => typeof r === "string");
  assert.deepEqual(reasons, ["length"]);
});

test("non-streaming tool calls come back assembled, with content null", async () => {
  const res = await post(
    { "x-mock-tool-calls": "1", "x-mock-tokens": "0" },
    { ...BODY, stream: false },
  );
  const body = (await res.json()) as {
    choices: Array<{
      finish_reason: string;
      message: {
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };
  const choice = body.choices[0]!;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls?.length, 1);
  assert.equal(choice.message.tool_calls?.[0]!.type, "function");
  assert.deepEqual(JSON.parse(choice.message.tool_calls![0]!.function.arguments).unit, "celsius");
});

test("forwarded tool parameters are recorded for assertion", async () => {
  const tools = [{ type: "function", function: { name: "get_weather" } }];
  await post({}, { ...BODY, tools, tool_choice: "auto" });
  const seen = mock.lastRequest()!;
  assert.deepEqual(seen.tools, tools);
  assert.equal(seen.toolChoice, "auto");
});

test("tool calls are off unless asked for", async () => {
  const res = await post();
  const text = await readAll(res);
  assert.ok(!text.includes("tool_calls"), "the default stream must stay text-only");
});
