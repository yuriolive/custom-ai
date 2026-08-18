/**
 * End-to-end wiring tests: the real router, the real resolve/auth/error modules,
 * and the REAL `stream.ts`, driven by a fake upstream and fake RPCs.
 *
 * Runs under both `deno test` and `node --import tsx/esm --test`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { REQUEST_ID_HEADER } from "../errors.ts";
import { invalidateModelCache, type RawModelRow } from "../resolve.ts";
import { type GatewayDeps, handleRequest } from "../index.ts";
import { proxyStream } from "../stream.ts";

const CALLER_KEY = "sk-plat-" + "A".repeat(43);
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY_ID = "44444444-4444-4444-8444-444444444444";
const SERVED_NAME = "Qwen3.8-27B-Uncensored-Q4_K_M.gguf";
const ENDPOINT_ID = "ep_abcdef123456";
const UPSTREAM_BASE = "http://127.0.0.1:8787";
const RUNPOD_KEY = "rp_test_secret_key";

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

const SSE_OK = [
  'data: {"id":"c1","object":"chat.completion.chunk","created":1730000000,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1730000000,"choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1730000000,"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
  "data: [DONE]",
  "",
].join("\n\n");

interface Harness {
  deps: GatewayDeps;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  upstreamCalls: Array<
    { url: string; init: RequestInit & { headers: Record<string, string> } }
  >;
}

function harness(over: { authorize?: unknown; sse?: string } = {}): Harness {
  const rpcCalls: Harness["rpcCalls"] = [];
  const upstreamCalls: Harness["upstreamCalls"] = [];

  const deps: GatewayDeps = {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role-secret",
    upstreamBaseUrl: UPSTREAM_BASE,
    runpodApiKey: RUNPOD_KEY,
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
      upstreamCalls.push({ url: String(url), init: init as never });
      return Promise.resolve(
        new Response(over.sse ?? SSE_OK, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch,
  };
  return { deps, rpcCalls, upstreamCalls };
}

function chatRequest(body: Record<string, unknown>): Request {
  return new Request("https://gw.example/functions/v1/gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${CALLER_KEY}`, "content-type": "application/json" },
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

test("E2E streaming: proxies bytes, stamps the request id, settles exactly once", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    chatRequest({ model: "owner/secret-model", messages: [HELLO], stream: true }),
    h.deps,
  );

  assert.equal(res.status, 200);
  const rid = res.headers.get(REQUEST_ID_HEADER);
  assert.match(
    rid ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.ok(res.headers.has("x-nexus-overhead-ms"));

  const text = await res.text();
  assert.ok(text.includes("[DONE]"));
  assert.ok(text.includes("Hi"));

  assert.equal(h.upstreamCalls.length, 1);
  const sent = JSON.parse(h.upstreamCalls[0].init.body as string);
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(sent.model, SERVED_NAME);
  assert.equal(
    h.upstreamCalls[0].url,
    `${UPSTREAM_BASE}/v2/${ENDPOINT_ID}/openai/v1/chat/completions`,
  );
  assert.ok(!JSON.stringify(h.upstreamCalls[0]).includes("sk-plat-"));

  const authorize = h.rpcCalls.find((c) => c.name === "authorize_request");
  assert.ok(authorize, "authorize_request must run before upstream");
  assert.equal(authorize!.args.p_txn_id, rid, "the request id IS the usage_transactions id");
  assert.equal(authorize!.args.p_model_id, MODEL_ID);
  assert.equal(authorize!.args.p_api_key_id, API_KEY_ID);
  assert.equal(authorize!.args.p_was_streaming, true);
  assert.ok(Number(authorize!.args.p_est_prompt_tokens) > 0);

  await waitFor(() => h.rpcCalls.some((c) => c.name === "deduct_token_cost"));
  const deduct = h.rpcCalls.filter((c) => c.name === "deduct_token_cost");
  assert.equal(deduct.length, 1, "settles exactly once");
  assert.equal(deduct[0].args.p_txn_id, rid);
  assert.equal(deduct[0].args.p_prompt_tokens, 11);
  assert.equal(deduct[0].args.p_completion_tokens, 2);
  assert.ok(!h.rpcCalls.some((c) => c.name === "void_reservation"));
});

test("E2E non-streaming: the forced stream is assembled into one chat.completion", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    chatRequest({ model: "owner/secret-model", messages: [HELLO], stream: false }),
    h.deps,
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "Hi there");
  assert.equal(body.choices[0].finish_reason, "stop");
  // The client sees the platform-facing id, never the served name.
  assert.equal(body.model, "owner/secret-model");
  assert.equal(body.usage.prompt_tokens, 11);
  // Upstream was still asked to stream (FR-GW-030).
  assert.equal(JSON.parse(h.upstreamCalls[0].init.body as string).stream, true);
});

test("E2E 402: the balance header is set and no upstream call is made", async () => {
  invalidateModelCache();
  const h = harness({
    authorize: { ok: false, code: "insufficient_balance", balance_micro_usd: 42 },
  });
  const res = await handleRequest(
    chatRequest({ model: "owner/secret-model", messages: [HELLO], stream: true }),
    h.deps,
  );

  assert.equal(res.status, 402);
  assert.equal(res.headers.get("x-nexus-balance-micro-usd"), "42");
  assert.ok(res.headers.get(REQUEST_ID_HEADER));
  const body = await res.json();
  assert.equal(body.error.code, "insufficient_balance");
  assert.match(body.error.message, /billing/);
  assert.equal(h.upstreamCalls.length, 0, "no GPU may be engaged on a 402");
});

test("E2E: suspension is 403; an upstream 401 becomes a client 500 and voids the hold", async () => {
  invalidateModelCache();
  const suspended = harness({ authorize: { ok: false, code: "account_suspended" } });
  const r1 = await handleRequest(
    chatRequest({ model: "owner/secret-model", messages: [HELLO] }),
    suspended.deps,
  );
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).error.code, "account_suspended");
  assert.equal(suspended.upstreamCalls.length, 0);

  const h = harness();
  h.deps.fetchImpl = (() =>
    Promise.resolve(
      new Response('{"error":"unauthorized for endpoint ep_9xk2"}', { status: 401 }),
    )) as unknown as typeof fetch;

  const r2 = await handleRequest(
    chatRequest({ model: "owner/secret-model", messages: [HELLO], stream: false }),
    h.deps,
  );
  assert.equal(r2.status, 500);
  const body = await r2.json();
  assert.equal(body.error.code, "internal_error");
  assert.ok(!JSON.stringify(body).includes("ep_9xk2"), "upstream endpoint id leaked");

  // Zero tokens produced => the hold is released, not settled.
  await waitFor(() => h.rpcCalls.some((c) => c.name === "void_reservation"));
  assert.ok(!h.rpcCalls.some((c) => c.name === "deduct_token_cost"));
});

test("E2E: every rejection and the CORS preflight carry x-nexus-request-id", async () => {
  invalidateModelCache();
  const h = harness();

  const cases: Array<[Record<string, unknown>, number]> = [
    [{ model: "no-slash", messages: [HELLO] }, 400],
    [{ model: "owner/secret-model", messages: [HELLO], n: 3 }, 400],
    [{ model: "owner/secret-model", messages: [HELLO], logprobs: true }, 400],
    [{ model: "owner/secret-model", messages: [HELLO], tools: [{}] }, 501],
    [{ model: "owner/secret-model", messages: [] }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await handleRequest(chatRequest(body), h.deps);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.ok(res.headers.get(REQUEST_ID_HEADER), "request id missing on an error response");
  }
  assert.equal(h.upstreamCalls.length, 0, "no rejected request may reach upstream");

  const noAuth = await handleRequest(
    new Request("https://gw.example/v1/chat/completions", { method: "POST", body: "{}" }),
    h.deps,
  );
  assert.equal(noAuth.status, 401);
  assert.ok(noAuth.headers.get(REQUEST_ID_HEADER));

  const preflight = await handleRequest(
    new Request("https://gw.example/v1/chat/completions", { method: "OPTIONS" }),
    h.deps,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, GET, OPTIONS");
  assert.ok(preflight.headers.get(REQUEST_ID_HEADER));

  const unknownRoute = await handleRequest(
    new Request("https://gw.example/v1/embeddings", { method: "POST" }),
    h.deps,
  );
  assert.equal(unknownRoute.status, 404);
  assert.ok(unknownRoute.headers.get(REQUEST_ID_HEADER));
});

test("E2E: a bad key is rejected before the body is parsed or upstream is touched", async () => {
  invalidateModelCache();
  const h = harness();
  const res = await handleRequest(
    new Request("https://gw.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-plat-tooshort" },
      body: "this is not json at all",
    }),
    h.deps,
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "invalid_api_key");
  assert.equal(h.rpcCalls.length, 0);
  assert.equal(h.upstreamCalls.length, 0);
});
