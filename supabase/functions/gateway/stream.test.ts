/**
 * Tests for the SSE proxy core (FR-GW-040…048).
 * Run: node --test supabase/functions/gateway/
 *
 * Deliberately self-contained: no import from tools/mock-upstream/ (owned by
 * A4, may not exist). Upstream is faked with a plain Response over a
 * ReadableStream we drive by hand.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { StreamMeta, UsageResult } from "../../../packages/shared/types.ts";
import { KEEPALIVE_FRAME, proxyStream } from "./stream.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── test doubles ────────────────────────────────────────────────────────────

interface ManualUpstream {
  response: Response;
  push(bytes: Uint8Array | string): void;
  close(): void;
}

/** An upstream whose body we drive chunk by chunk. */
function manualUpstream(): ManualUpstream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push(bytes) {
      controller.enqueue(typeof bytes === "string" ? enc.encode(bytes) : bytes);
    },
    close() {
      controller.close();
    },
  };
}

/** An upstream that emits exactly these chunks, then closes. */
function staticUpstream(chunks: (Uint8Array | string)[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

async function drain(res: Response): Promise<Uint8Array> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return concat(parts);
}

/** Captures the single onComplete call. */
function completion() {
  const d = deferred<{ usage: UsageResult; meta: StreamMeta }>();
  let calls = 0;
  const onComplete = (usage: UsageResult, meta: StreamMeta) => {
    calls += 1;
    d.resolve({ usage, meta });
  };
  return { onComplete, done: d.promise, get calls() { return calls; } };
}

const OPTS = { coldStartBudgetMs: 300_000, totalBudgetMs: 300_000 };

const sseChunk = (content: string) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;

const tick = () => new Promise((r) => setImmediate(r));

// ─── FR-GW-040: headers before upstream resolves ─────────────────────────────

test("headers are available before the upstream promise resolves", async () => {
  const up = deferred<Response>();
  const c = completion();

  const res = proxyStream(up.promise, c.onComplete, OPTS);

  // Synchronously after the call — upstream has NOT settled.
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("connection"), "keep-alive");
  assert.equal(res.headers.get("x-accel-buffering"), "no");

  let upstreamSettled = false;
  up.promise.then(() => {
    upstreamSettled = true;
  });
  await tick();
  assert.equal(upstreamSettled, false, "headers were readable while upstream was still pending");

  up.resolve(staticUpstream([sseChunk("hi"), "data: [DONE]\n\n"]));
  await drain(res);
  await c.done;
});

// ─── FR-GW-041 / 042: keep-alive ─────────────────────────────────────────────

test("keep-alive frames are emitted during upstream silence and stop on the first upstream byte", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

  const upstream = manualUpstream();
  const up = deferred<Response>();
  const c = completion();

  const res = proxyStream(up.promise, c.onComplete, OPTS);
  const reader = res.body!.getReader();
  const seen: string[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) seen.push(dec.decode(value));
    }
  })();

  await tick();
  t.mock.timers.tick(5_000);
  await tick();
  assert.deepEqual(seen, [KEEPALIVE_FRAME], "one keep-alive after 5 s of silence");

  t.mock.timers.tick(5_000);
  await tick();
  assert.deepEqual(seen, [KEEPALIVE_FRAME, KEEPALIVE_FRAME], "a second at 10 s");

  // Upstream finally wakes up.
  up.resolve(upstream.response);
  await tick();
  upstream.push(sseChunk("A"));
  await tick();
  assert.equal(seen.length, 3);
  assert.equal(seen[2], sseChunk("A"));

  // FR-GW-042: never resumes, even after further silence.
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(seen.length, 3, "keep-alive did not resume after the first upstream byte");

  upstream.push("data: [DONE]\n\n");
  upstream.close();
  await pump;
  const { meta } = await c.done;
  assert.equal(meta.clientGone, false);
  t.mock.timers.reset();
});

// ─── FR-GW-043: verbatim forwarding + frame reassembly ───────────────────────

test("forwarded bytes are byte-identical to what upstream sent", async () => {
  const frames = [
    sseChunk("Hello"),
    sseChunk(" wörld — 世界 🚀"),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const original = concat(frames.map((f) => enc.encode(f)));
  const c = completion();

  const res = proxyStream(Promise.resolve(staticUpstream(frames)), c.onComplete, OPTS);
  const forwarded = await drain(res);

  assert.deepEqual(Array.from(forwarded), Array.from(original));
  const { usage } = await c.done;
  assert.equal(usage.source, "upstream");
  assert.equal(usage.completionTokens, 9);
});

test("SSE frames split across chunk boundaries, incl. a multi-byte UTF-8 char split across reads", async () => {
  const content = "héllo 世界";
  const frame = sseChunk(content);
  const bytes = enc.encode(frame);

  // Find a split point that lands INSIDE the 3-byte encoding of 世.
  const marker = enc.encode("世");
  let idx = -1;
  outer: for (let i = 0; i + marker.length <= bytes.length; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    idx = i;
    break;
  }
  assert.ok(idx > 0, "found the multi-byte character in the frame");
  const splitAt = idx + 1; // mid-sequence: 1 of 3 bytes in the first read

  const chunks = [
    bytes.slice(0, splitAt),
    bytes.slice(splitAt, bytes.length - 3), // also splits the frame before its "\n\n"
    bytes.slice(bytes.length - 3),
    enc.encode("data: [DONE]\n\n"),
  ];

  const c = completion();
  const res = proxyStream(
    Promise.resolve(staticUpstream(chunks)),
    c.onComplete,
    { ...OPTS, estimateFrom: { promptChars: 20 } },
  );
  const forwarded = await drain(res);

  assert.deepEqual(
    Array.from(forwarded),
    Array.from(concat(chunks.map((ch) => new Uint8Array(ch)))),
    "bytes forwarded unchanged despite the mid-sequence split",
  );

  const { usage } = await c.done;
  assert.equal(usage.source, "estimated");
  // The reassembled frame must have parsed: completion chars == content.length.
  assert.equal(usage.completionTokens, Math.ceil(content.length / 3.5));
});

test("a terminal usage frame with NO trailing newline is still counted", async () => {
  // Real upstreams do this. Dropping the last partial line loses the usage
  // frame entirely and silently moves the request onto the estimator.
  const frames = [
    sseChunk("x"),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } })}`,
  ];
  const c = completion();
  const res = proxyStream(Promise.resolve(staticUpstream(frames)), c.onComplete, OPTS);
  await drain(res);
  const { usage } = await c.done;
  assert.equal(usage.source, "upstream");
  assert.equal(usage.promptTokens, 12);
  assert.equal(usage.completionTokens, 34);
});

test("`data:` with no space after the colon is parsed (llama.cpp / proxy variant)", async () => {
  const frames = [
    `data:${JSON.stringify({ choices: [{ delta: { content: "y" } }] })}\r\n\r\n`,
    `data:${JSON.stringify({ timings: { prompt_n: 6, predicted_n: 8 } })}\r\n\r\n`,
    "data: [DONE]\r\n\r\n",
  ];
  const c = completion();
  const res = proxyStream(Promise.resolve(staticUpstream(frames)), c.onComplete, OPTS);
  await drain(res);
  const { usage } = await c.done;
  assert.equal(usage.source, "upstream");
  assert.equal(usage.promptTokens, 6);
  assert.equal(usage.completionTokens, 8);
});

// ─── FR-GW-044: the three extraction paths, end to end ───────────────────────

test("usage path 1 (vLLM terminal usage incl. cached_tokens)", async () => {
  const frames = [
    sseChunk("a"),
    `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 31,
        completion_tokens: 17,
        prompt_tokens_details: { cached_tokens: 24 },
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const c = completion();
  await drain(proxyStream(Promise.resolve(staticUpstream(frames)), c.onComplete, OPTS));
  const { usage } = await c.done;
  assert.deepEqual(usage, {
    promptTokens: 31,
    completionTokens: 17,
    cachedPromptTokens: 24,
    source: "upstream",
  });
});

test("usage path 2 (llama.cpp timings on a trailing frame)", async () => {
  const frames = [
    sseChunk("a"),
    sseChunk("b"),
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      timings: { prompt_n: 45, predicted_n: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const c = completion();
  await drain(proxyStream(Promise.resolve(staticUpstream(frames)), c.onComplete, OPTS));
  const { usage } = await c.done;
  assert.deepEqual(usage, {
    promptTokens: 45,
    completionTokens: 2,
    cachedPromptTokens: 0,
    source: "upstream",
  });
});

test("usage path 3 (none emitted) => estimated, with a non-zero completion count", async () => {
  const text = "Tokens the worker never counted for us.";
  const frames = [...text.split("").map(sseChunk), "data: [DONE]\n\n"];
  const c = completion();
  await drain(
    proxyStream(Promise.resolve(staticUpstream(frames)), c.onComplete, {
      ...OPTS,
      estimateFrom: { promptChars: 70 },
    }),
  );
  const { usage } = await c.done;
  assert.equal(usage.source, "estimated");
  assert.equal(usage.promptTokens, Math.ceil(70 / 3.5));
  assert.equal(usage.completionTokens, Math.ceil(text.length / 3.5));
  assert.ok(usage.completionTokens > 0, "a completed stream is never left unbilled");
});

// ─── FR-GW-045/046: client disconnect ────────────────────────────────────────

test("client disconnect mid-stream still drains upstream and calls onComplete", async () => {
  const upstream = manualUpstream();
  const c = completion();
  const res = proxyStream(Promise.resolve(upstream.response), c.onComplete, OPTS);

  const reader = res.body!.getReader();
  upstream.push(sseChunk("one"));
  const first = await reader.read();
  assert.ok(first.value && first.value.byteLength > 0);

  // The client hangs up.
  await reader.cancel();
  await tick();

  // The GPU keeps working; those tokens are billable.
  upstream.push(sseChunk("two"));
  upstream.push(sseChunk("three"));
  await tick();
  upstream.push(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } })}\n\n`,
  );
  upstream.push("data: [DONE]\n\n");
  upstream.close();

  const { usage, meta } = await c.done;
  assert.equal(meta.clientGone, true, "disconnect was detected");
  assert.equal(usage.source, "upstream");
  assert.equal(usage.completionTokens, 3, "tokens produced after the client left are still billed");
  assert.equal(c.calls, 1, "onComplete fired exactly once");
});

test("client disconnect before any usage frame still bills the tokens seen so far", async () => {
  const upstream = manualUpstream();
  const c = completion();
  const res = proxyStream(Promise.resolve(upstream.response), c.onComplete, {
    ...OPTS,
    estimateFrom: { promptChars: 14 },
  });
  const reader = res.body!.getReader();
  upstream.push(sseChunk("hello there"));
  await reader.read();
  await reader.cancel();
  await tick();
  upstream.push(sseChunk("more output"));
  upstream.close();

  const { usage, meta } = await c.done;
  assert.equal(meta.clientGone, true);
  assert.equal(usage.source, "estimated");
  assert.equal(usage.completionTokens, Math.ceil("hello theremore output".length / 3.5));
});

// ─── FR-GW-047: timeouts ─────────────────────────────────────────────────────

test("cold-start timeout emits an error frame then [DONE], and calls onComplete", async () => {
  const never = new Promise<Response>(() => {});
  const c = completion();
  const res = proxyStream(never, c.onComplete, {
    coldStartBudgetMs: 60,
    totalBudgetMs: 5_000,
    estimateFrom: { promptChars: 21 },
  });

  const out = dec.decode(await drain(res));
  assert.match(out, /"code":"cold_start_timeout"/);
  assert.ok(out.trimEnd().endsWith("data: [DONE]"), `stream terminated with [DONE]:\n${out}`);

  const { usage, meta } = await c.done;
  assert.equal(usage.source, "estimated");
  assert.equal(usage.promptTokens, 6);
  assert.equal(usage.completionTokens, 0);
  assert.equal(meta.ttftMs, null);
  assert.equal(c.calls, 1);
});

test("total-stream timeout emits an error frame and bills the tokens observed", async () => {
  const upstream = manualUpstream();
  const c = completion();
  const res = proxyStream(Promise.resolve(upstream.response), c.onComplete, {
    coldStartBudgetMs: 5_000,
    totalBudgetMs: 120,
    estimateFrom: { promptChars: 7 },
  });

  upstream.push(sseChunk("partial output"));
  // ...then upstream goes silent forever and the total budget expires.

  const out = dec.decode(await drain(res));
  assert.match(out, /"code":"stream_timeout"/);
  assert.ok(out.includes(sseChunk("partial output")), "already-forwarded bytes are untouched");
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));

  const { usage, meta } = await c.done;
  assert.equal(usage.source, "estimated");
  assert.equal(usage.completionTokens, Math.ceil("partial output".length / 3.5));
  assert.ok(meta.ttftMs !== null && meta.ttftMs >= 0);
  assert.equal(c.calls, 1);
});

test("a non-2xx upstream produces a terminating error frame and settles", async () => {
  const c = completion();
  const res = proxyStream(
    Promise.resolve(new Response("boom", { status: 500 })),
    c.onComplete,
    OPTS,
  );
  const out = dec.decode(await drain(res));
  assert.match(out, /"error"/);
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
  assert.equal(c.calls, 1);
});

// ─── FR-GW-048: meta ─────────────────────────────────────────────────────────

test("ttftMs, durationMs and coldStart are computed", async () => {
  const upstream = manualUpstream();
  const c = completion();
  const res = proxyStream(Promise.resolve(upstream.response), c.onComplete, OPTS);
  const pump = drain(res);
  await tick();
  upstream.push(sseChunk("q"));
  upstream.push("data: [DONE]\n\n");
  upstream.close();
  await pump;

  const { meta } = await c.done;
  assert.ok(meta.ttftMs !== null && meta.ttftMs >= 0, "ttft measured");
  assert.ok(meta.durationMs !== null && meta.durationMs >= meta.ttftMs!, "duration >= ttft");
  assert.equal(meta.coldStart, false, "a fast first token is not a cold start");
  assert.equal(meta.clientGone, false);
});

test("coldStart is true when the first token takes longer than 5 s", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  // node's mock timers do not cover performance.now(); pin it to mocked Date.
  t.mock.method(globalThis.performance, "now", () => Date.now());
  const upstream = manualUpstream();
  const c = completion();
  const res = proxyStream(Promise.resolve(upstream.response), c.onComplete, OPTS);
  const reader = res.body!.getReader();
  const pump = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();

  await tick();
  t.mock.timers.tick(101_000); // the MVP's ~101 s cold start
  await tick();
  upstream.push(sseChunk("z"));
  upstream.push("data: [DONE]\n\n");
  upstream.close();
  await pump;

  const { meta } = await c.done;
  assert.ok(meta.ttftMs! >= 100_000, `ttft ${meta.ttftMs}`);
  assert.equal(meta.coldStart, true);
  t.mock.timers.reset();
});
