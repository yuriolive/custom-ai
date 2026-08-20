/**
 * Anthropic Messages API surface — unit + end-to-end wiring (PRD §4.6).
 *
 * Runs under both `deno test` and `node --test`. The e2e half drives the REAL
 * router, the REAL stream.ts and the REAL adapter against a fake upstream, so a
 * regression in the shared pipeline shows up here as an Anthropic-shaped failure
 * rather than as a silently OpenAI-shaped body.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractAnthropicApiKey } from "../auth.ts";
import { GatewayError } from "../errors.ts";
import {
  anthropicErrorResponse,
  countTokensChars,
  countTokensEstimate,
  isAnthropicClient,
  mapAnthropicModel,
  parseModelMap,
  toAnthropicSse,
} from "../anthropic.ts";
import {
  estimatePromptTokens,
  type GatewayDeps,
  handleRequest,
  routeOf,
  toolDefinitionChars,
} from "../index.ts";
import { invalidateModelCache, type RawModelRow } from "../resolve.ts";
import { proxyStream } from "../stream.ts";
import type { AnthropicMessagesRequest } from "../../../../packages/anthropic-adapter/src/types.ts";

const CALLER_KEY = "sk-plat-" + "A".repeat(43);
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY_ID = "44444444-4444-4444-8444-444444444444";
const SERVED_NAME = "Qwen3.8-27B-Uncensored-Q4_K_M.gguf";
const ENDPOINT_ID = "ep_abcdef123456";
const UPSTREAM_BASE = "http://127.0.0.1:8787";
const PLATFORM_MODEL = "owner/secret-model";

// ─── unit: model-name policy ─────────────────────────────────────────────────

test("parseModelMap keeps only creator/slug values and never throws", () => {
  assert.deepEqual(parseModelMap(undefined), {});
  assert.deepEqual(parseModelMap("{not json"), {});
  assert.deepEqual(parseModelMap('["a"]'), {});
  assert.deepEqual(
    parseModelMap('{"Claude-Opus-5":"owner/big","haiku":"owner/small","bad":"no-slash"}'),
    { "claude-opus-5": "owner/big", haiku: "owner/small" },
  );
});

test("mapAnthropicModel: passthrough, exact, longest substring, default, 404", () => {
  const map = { haiku: "owner/small", "claude-opus-5": "owner/big" };

  assert.equal(mapAnthropicModel("owner/other", map, undefined), "owner/other");
  assert.equal(mapAnthropicModel("CLAUDE-OPUS-5", map, undefined), "owner/big");
  // A dated snapshot Claude Code actually sends, covered by one substring entry.
  assert.equal(mapAnthropicModel("claude-3-5-haiku-20241022", map, undefined), "owner/small");
  assert.equal(mapAnthropicModel("claude-unknown", map, "owner/fallback"), "owner/fallback");

  assert.throws(
    () => mapAnthropicModel("claude-unknown", map, undefined),
    (e: unknown) => e instanceof GatewayError && e.code === "model_not_found",
  );
  assert.throws(
    () => mapAnthropicModel("", map, "owner/fallback"),
    (e: unknown) => e instanceof GatewayError && e.code === "invalid_model_format",
  );
});

test("the longest matching key wins, so a specific entry beats a generic one", () => {
  const map = { haiku: "owner/small", "claude-3-5-haiku": "owner/exact" };
  assert.equal(mapAnthropicModel("claude-3-5-haiku-20241022", map, undefined), "owner/exact");
});

// ─── unit: auth dialect + routing ────────────────────────────────────────────

test("extractAnthropicApiKey accepts x-api-key, falls back to bearer, rejects junk", () => {
  const withXApiKey = new Request("https://gw.example/v1/messages", {
    method: "POST",
    headers: { "x-api-key": CALLER_KEY },
  });
  assert.equal(extractAnthropicApiKey(withXApiKey), CALLER_KEY);

  const withBearer = new Request("https://gw.example/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${CALLER_KEY}` },
  });
  assert.equal(extractAnthropicApiKey(withBearer), CALLER_KEY);

  const bad = new Request("https://gw.example/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-ant-api03-not-ours" },
  });
  assert.throws(
    () => extractAnthropicApiKey(bad),
    (e: unknown) => e instanceof GatewayError && e.code === "invalid_api_key",
  );
});

test("count_tokens routes before messages, on both the bare and deployed paths", () => {
  assert.equal(routeOf("/v1/messages"), "messages");
  assert.equal(routeOf("/v1/messages/count_tokens"), "count_tokens");
  assert.equal(routeOf("/functions/v1/gateway/v1/messages/count_tokens"), "count_tokens");
  assert.equal(routeOf("/functions/v1/gateway/v1/messages/"), "messages");
});

test("isAnthropicClient keys off the Anthropic header dialect only", () => {
  const anthropic = new Request("https://gw.example/v1/models", {
    headers: { "anthropic-version": "2023-06-01" },
  });
  const openai = new Request("https://gw.example/v1/models", {
    headers: { authorization: `Bearer ${CALLER_KEY}` },
  });
  assert.equal(isAnthropicClient(anthropic), true);
  assert.equal(isAnthropicClient(openai), false);
});

// ─── unit: errors ────────────────────────────────────────────────────────────

test("gateway errors render as Anthropic envelopes with ANTHROPIC statuses", async () => {
  const unavailable = anthropicErrorResponse(
    new GatewayError("model_unavailable", "not ready"),
    "req-1",
  );
  // 503 to an OpenAI client, 529 to an Anthropic one (FR-ANTH-013).
  assert.equal(unavailable.status, 529);
  const body = await unavailable.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "overloaded_error");

  const broke = anthropicErrorResponse(
    new GatewayError("insufficient_balance", "top up", {
      headers: { "x-nexus-balance-micro-usd": "42" },
    }),
    "req-2",
  );
  assert.equal(broke.status, 402);
  assert.equal((await broke.json()).error.type, "billing_error");
  assert.equal(broke.headers.get("x-nexus-balance-micro-usd"), "42");
  assert.equal(broke.headers.get("request-id"), "req-2");
});

// ─── unit: count_tokens estimator ────────────────────────────────────────────

test("count_tokens counts system, message blocks and the tool schemas", () => {
  const base: AnthropicMessagesRequest = {
    model: "claude-opus-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  };
  const withTools: AnthropicMessagesRequest = {
    ...base,
    system: "You are a helpful assistant.",
    tools: [{ name: "grep", description: "search", input_schema: { type: "object" } }],
  };

  assert.ok(countTokensChars(withTools) > countTokensChars(base));
  const counted = countTokensEstimate(withTools, estimatePromptTokens);
  assert.ok(counted.input_tokens > 0);
  assert.equal(Number.isInteger(counted.input_tokens), true);
});

test("tool definitions count toward the prompt estimate on the OpenAI path too", () => {
  assert.equal(toolDefinitionChars({ messages: [] }), 0);
  assert.ok(
    toolDefinitionChars({
      messages: [],
      tools: [{ type: "function", function: { name: "grep", parameters: {} } }],
    }) > 10,
  );
});

// ─── unit: SSE re-framing ────────────────────────────────────────────────────

function sseResponse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

async function framesOf(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split("\n\n").filter((f) => f.trim() !== "");
}

const OPENAI_SSE = [
  ": keepalive",
  'data: {"id":"c1","created":1730000000,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
  'data: {"id":"c1","created":1730000000,"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}',
  'data: {"id":"c1","created":1730000000,"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
  "data: [DONE]",
  "",
].join("\n\n");

test("toAnthropicSse emits the full event sequence and forwards keepalives", async () => {
  const framed = toAnthropicSse(sseResponse(OPENAI_SSE), {
    messageId: "msg_test",
    model: PLATFORM_MODEL,
    inputTokens: 9,
  });
  const frames = await framesOf(framed);

  assert.equal(frames[0], ": keepalive", "the cold-start keepalive must survive re-framing");

  const events = frames.filter((f) => f.startsWith("event:")).map((f) => {
    const [nameLine, dataLine] = f.split("\n");
    return {
      name: nameLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    };
  });

  assert.deepEqual(
    events.map((e) => e.name).filter((n) => n !== "ping"),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );

  // Every payload repeats its own name (FR-ANTH-008) — SDK clients validate it.
  for (const e of events) assert.equal(e.data.type, e.name);

  const start = events.find((e) => e.name === "message_start")!;
  assert.equal(start.data.message.id, "msg_test");
  assert.equal(start.data.message.model, PLATFORM_MODEL);
  assert.equal(start.data.message.usage.input_tokens, 9, "the hold estimate seeds message_start");

  const delta = events.find((e) => e.name === "message_delta")!;
  assert.equal(delta.data.delta.stop_reason, "end_turn");
  assert.equal(delta.data.usage.output_tokens, 2);
  assert.equal(delta.data.usage.input_tokens, 11, "the real count corrects the estimate");

  const text = events
    .filter((e) => e.name === "content_block_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert.equal(text, "Hi there");
});

test("an upstream error frame becomes an Anthropic error event, not a dead socket", async () => {
  const errorSse = [
    'data: {"error":{"message":"worker fell over","type":"api_error","param":null,"code":"model_unavailable"}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  const frames = await framesOf(
    toAnthropicSse(sseResponse(errorSse), { messageId: "msg_e", model: PLATFORM_MODEL }),
  );
  assert.equal(frames.length, 1);
  assert.ok(frames[0].startsWith("event: error"));
  const payload = JSON.parse(frames[0].split("\n")[1].slice("data: ".length));
  assert.equal(payload.type, "error");
  assert.equal(payload.error.type, "overloaded_error");
  assert.match(payload.error.message, /worker fell over/);
});

test("frames split across chunk boundaries are reassembled", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      // Split mid-JSON, which is what a real socket does.
      controller.enqueue(enc.encode('data: {"id":"c1","choices":[{"index":0,"delta":{"con'));
      controller.enqueue(enc.encode('tent":"Hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });

  const frames = await framesOf(
    toAnthropicSse(new Response(body), { messageId: "msg_s", model: PLATFORM_MODEL }),
  );
  const text = frames
    .filter((f) => f.startsWith("event: content_block_delta"))
    .map((f) => JSON.parse(f.split("\n")[1].slice("data: ".length)).delta.text)
    .join("");
  assert.equal(text, "Hi");
});

// ─── e2e harness ─────────────────────────────────────────────────────────────

function modelRow(over: Partial<RawModelRow> = {}): RawModelRow {
  return {
    id: MODEL_ID,
    user_id: OWNER_ID,
    status: "ready",
    visibility: "public",
    deleted_at: null,
    runpod_endpoint_id: ENDPOINT_ID,
    served_model_name: SERVED_NAME,
    runtime: "llamacpp",
    price_prompt_micro_usd_per_mtoken: 500_000,
    price_completion_micro_usd_per_mtoken: 1_500_000,
    platform_fee_bps: 2000,
    context_length: 8192,
    cold_start_budget_s: 90,
    ...over,
  };
}

interface Harness {
  deps: GatewayDeps;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  upstreamCalls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }>;
}

const CATALOG = [
  { slug: "secret-model", created_at: "2026-01-02T03:04:05Z", profiles: { handle: "owner" } },
];

function harness(over: { authorize?: unknown; sse?: string } = {}): Harness {
  const rpcCalls: Harness["rpcCalls"] = [];
  const upstreamCalls: Harness["upstreamCalls"] = [];

  const deps: GatewayDeps = {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role-secret",
    upstreamBaseUrl: UPSTREAM_BASE,
    runpodApiKey: "rp_test_secret_key",
    anthropicModelMap: { "claude-opus-5": PLATFORM_MODEL, haiku: PLATFORM_MODEL },
    proxyStream,
    exec: () =>
      Promise.resolve({
        api_key: { id: API_KEY_ID, user_id: OWNER_ID, revoked_at: null },
        model: modelRow(),
      }),
    rpc: (name, args) => {
      rpcCalls.push({ name, args });
      if (name === "authorize_request") {
        return Promise.resolve(
          over.authorize ?? {
            ok: true,
            txn_id: args.p_txn_id,
            hold_micro_usd: 5000,
            balance_micro_usd: 1_000_000,
          },
        );
      }
      return Promise.resolve({ ok: true, cost_micro_usd: 8500 });
    },
    fetchImpl: ((url: string, init: RequestInit) => {
      if (String(url).includes("/rest/v1/custom_models")) {
        return Promise.resolve(new Response(JSON.stringify(CATALOG), { status: 200 }));
      }
      upstreamCalls.push({ url: String(url), init: init as never });
      return Promise.resolve(
        new Response(over.sse ?? OPENAI_SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch,
  };
  return { deps, rpcCalls, upstreamCalls };
}

function messagesRequest(body: Record<string, unknown>, path = "/v1/messages"): Request {
  return new Request(`https://gw.example/functions/v1/gateway${path}`, {
    method: "POST",
    headers: {
      "x-api-key": CALLER_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const HELLO = { role: "user", content: "hi" };

// ─── e2e ─────────────────────────────────────────────────────────────────────

test("E2E /v1/messages streaming: Anthropic events out, ONE settlement, shared pipeline", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    messagesRequest({
      model: "claude-opus-5",
      max_tokens: 128,
      system: "be terse",
      messages: [HELLO],
      stream: true,
    }),
    h.deps,
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(res.headers.get("request-id"));

  const text = await res.text();
  assert.ok(text.includes("event: message_start"));
  assert.ok(text.includes("event: message_stop"));
  assert.ok(!text.includes("chat.completion.chunk"), "OpenAI frames must not leak through");

  // The upstream call is the ordinary one: served name, forced stream, usage flag.
  assert.equal(h.upstreamCalls.length, 1);
  const sent = JSON.parse(h.upstreamCalls[0].init.body as string);
  assert.equal(sent.model, SERVED_NAME);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  // The top-level Anthropic `system` became a leading system message.
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[0].content, "be terse");

  const authorize = h.rpcCalls.find((c) => c.name === "authorize_request")!;
  assert.equal(authorize.args.p_model_id, MODEL_ID);
  assert.equal(authorize.args.p_max_tokens, 128);
  assert.equal(authorize.args.p_was_streaming, true);

  await waitFor(() => h.rpcCalls.some((c) => c.name === "deduct_token_cost"));
  const deduct = h.rpcCalls.filter((c) => c.name === "deduct_token_cost");
  assert.equal(deduct.length, 1, "settles exactly once, from the OpenAI-side tee");
  assert.equal(deduct[0].args.p_prompt_tokens, 11);
  assert.equal(deduct[0].args.p_completion_tokens, 2);
});

test("E2E /v1/messages non-streaming: one assembled Anthropic message", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    messagesRequest({ model: "claude-opus-5", max_tokens: 64, messages: [HELLO] }),
    h.deps,
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.deepEqual(body.content, [{ type: "text", text: "Hi there" }]);
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.model, PLATFORM_MODEL);
  assert.equal(body.usage.input_tokens, 11);
  assert.equal(body.usage.output_tokens, 2);
  // Upstream was still asked to stream (FR-GW-030).
  assert.equal(JSON.parse(h.upstreamCalls[0].init.body as string).stream, true);
});

test("E2E /v1/messages: a tool call streams as a tool_use block and bills", async () => {
  invalidateModelCache();
  const toolSse = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"grep","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"todo\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":30,"completion_tokens":9,"total_tokens":39}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  const h = harness({ sse: toolSse });
  const res = await handleRequest(
    messagesRequest({
      model: "claude-opus-5",
      max_tokens: 64,
      messages: [HELLO],
      tools: [{ name: "grep", input_schema: { type: "object" } }],
    }),
    h.deps,
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stop_reason, "tool_use");
  assert.deepEqual(body.content, [
    { type: "tool_use", id: "call_1", name: "grep", input: { q: "todo" } },
  ]);

  // The tool definitions reached the worker untouched (FR-TOOL-001).
  const sent = JSON.parse(h.upstreamCalls[0].init.body as string);
  assert.equal(sent.tools[0].function.name, "grep");

  await waitFor(() => h.rpcCalls.some((c) => c.name === "deduct_token_cost"));
  const deduct = h.rpcCalls.find((c) => c.name === "deduct_token_cost")!;
  assert.equal(deduct.args.p_completion_tokens, 9);
});

test("E2E /v1/messages: missing max_tokens is an Anthropic 400, before any upstream call", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    messagesRequest({ model: "claude-opus-5", messages: [HELLO] }),
    h.deps,
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /max_tokens/);
  assert.equal(h.upstreamCalls.length, 0);
  assert.equal(h.rpcCalls.length, 0);
});

test("E2E /v1/messages: an unmapped model 404s in Anthropic shape and engages no GPU", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    messagesRequest({ model: "claude-does-not-exist", max_tokens: 8, messages: [HELLO] }),
    h.deps,
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.type, "not_found_error");
  assert.match(body.error.message, /claude-does-not-exist/);
  assert.equal(h.upstreamCalls.length, 0);
});

test("E2E /v1/messages: an insufficient balance is a 402 billing_error", async () => {
  invalidateModelCache();
  const h = harness({
    authorize: { ok: false, code: "insufficient_balance", balance_micro_usd: 42 },
  });
  const res = await handleRequest(
    messagesRequest({ model: "claude-opus-5", max_tokens: 8, messages: [HELLO], stream: true }),
    h.deps,
  );

  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error.type, "billing_error");
  assert.equal(res.headers.get("x-nexus-balance-micro-usd"), "42");
  assert.equal(h.upstreamCalls.length, 0, "no GPU may be engaged on a 402");
});

test("E2E /v1/messages/count_tokens: authenticated, free, and never bills", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    messagesRequest(
      { model: "claude-opus-5", messages: [HELLO], system: "be terse" },
      "/v1/messages/count_tokens",
    ),
    h.deps,
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.input_tokens > 0);
  assert.equal(h.rpcCalls.length, 0, "count_tokens must not reserve or settle anything");
  assert.equal(h.upstreamCalls.length, 0);

  const unauthenticated = await handleRequest(
    new Request("https://gw.example/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-not-ours" },
      body: "{}",
    }),
    h.deps,
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.type, "authentication_error");
});

test("E2E GET /v1/models: Anthropic headers get the Anthropic shape, bearer gets OpenAI's", async () => {
  invalidateModelCache();
  const h = harness();

  const anthropic = await handleRequest(
    new Request("https://gw.example/v1/models", {
      headers: { "x-api-key": CALLER_KEY, "anthropic-version": "2023-06-01" },
    }),
    h.deps,
  );
  assert.equal(anthropic.status, 200);
  const aBody = await anthropic.json();
  assert.equal(aBody.has_more, false);
  assert.deepEqual(aBody.data[0], {
    type: "model",
    id: "owner/secret-model",
    display_name: "owner/secret-model",
    created_at: "2026-01-02T03:04:05.000Z",
  });

  const openai = await handleRequest(
    new Request("https://gw.example/v1/models", {
      headers: { authorization: `Bearer ${CALLER_KEY}` },
    }),
    h.deps,
  );
  const oBody = await openai.json();
  assert.equal(oBody.object, "list");
  assert.equal(oBody.data[0].object, "model");
});
