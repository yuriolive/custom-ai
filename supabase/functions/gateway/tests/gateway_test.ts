/**
 * Gateway unit tests.
 *
 * Written against `node:test` + `node:assert/strict` so the SAME file runs under
 * Deno (`deno test`) and under Node (`node --import tsx/esm --test`). Deno is not
 * installed in the authoring environment, so the recorded run is the Node one.
 *
 * Everything here is pure: no database, no network, no Deno-only globals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  errorEnvelope,
  errorResponse,
  GatewayError,
  looksLikeOom,
  mapUpstreamError,
  REQUEST_ID_HEADER,
  sanitizeUpstreamText,
  statusForCode,
  typeForCode,
} from "../errors.ts";
import {
  extractApiKey,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  KEY_PREFIX,
  KEY_TOTAL_LENGTH,
} from "../auth.ts";
import {
  invalidateModelCache,
  parseModelId,
  type RawModelRow,
  type RawResolveRow,
  resolveRequest,
} from "../resolve.ts";
import {
  assembleNonStreaming,
  assertToolsSupported,
  buildUpstreamRequest,
  estimatePromptTokens,
  promptChars,
  shouldVoid,
  toolDefinitionChars,
  uuidv7,
  validateChatRequest,
  validateToolParams,
} from "../index.ts";
import type {
  GatewayErrorCode,
  ResolvedRequest,
  UsageResult,
} from "../../../../packages/shared/types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const CALLER_KEY = "sk-plat-" + "A".repeat(43);
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";

function modelRow(over: Partial<RawModelRow> = {}): RawModelRow {
  return {
    id: MODEL_ID,
    user_id: OWNER_ID,
    status: "ready",
    visibility: "public",
    deleted_at: null,
    runpod_endpoint_id: "ep_abcdef123456",
    served_model_name: "Qwen3.8-27B-Uncensored-Q4_K_M.gguf",
    runtime: "llamacpp",
    price_prompt_micro_usd_per_mtoken: 500_000,
    price_completion_micro_usd_per_mtoken: 1_500_000,
    platform_fee_bps: 2000,
    context_length: 8192,
    cold_start_budget_s: 90,
    ...over,
  };
}

function execReturning(row: RawResolveRow) {
  return () => Promise.resolve(row);
}

async function expectGatewayError(fn: () => Promise<unknown> | unknown): Promise<GatewayError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof GatewayError, `expected GatewayError, got ${e}`);
    return e as GatewayError;
  }
  throw new Error("expected a GatewayError to be thrown, but nothing was thrown");
}

const resolvedFixture: ResolvedRequest = {
  apiKeyId: "44444444-4444-4444-8444-444444444444",
  userId: OWNER_ID,
  modelId: MODEL_ID,
  creatorId: OWNER_ID,
  upstreamEndpointRef: "ep_abcdef123456",
  servedModelName: "Qwen3.8-27B-Uncensored-Q4_K_M.gguf",
  runtime: "llamacpp",
  pricePromptMicro: 500_000,
  priceCompletionMicro: 1_500_000,
  platformFeeBps: 2000,
  contextLength: 8192,
  coldStartBudgetS: 90,
  // Unknown, which is what every row provisioned before FR-TOOL-003 carries.
  supportsTools: null,
};

/** A well-formed single tool, the shape every OpenAI client sends. */
const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather.",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
};

/** Wraps SSE lines into the framing assembleNonStreaming reads. */
function sseResponse(lines: string[]): Response {
  return new Response([...lines, "data: [DONE]", ""].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunkLine(choices: unknown[], extra: Record<string, unknown> = {}): string {
  return `data: ${
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1730000000,
      choices,
      ...extra,
    })
  }`;
}

// ─── 1. Key hashing & generation ─────────────────────────────────────────────

test("hashApiKey matches an independent SHA-256 of the full plaintext", async () => {
  const expected = createHash("sha256").update(CALLER_KEY, "utf8").digest("hex");
  const actual = await hashApiKey(CALLER_KEY);
  assert.equal(actual, expected);
  assert.match(actual, /^[a-f0-9]{64}$/); // matches the api_keys.key_hash CHECK
});

test("hashApiKey is stable and collision-distinct", async () => {
  const a = await hashApiKey(CALLER_KEY);
  const b = await hashApiKey(CALLER_KEY);
  const c = await hashApiKey(CALLER_KEY.slice(0, -1) + "B");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("generateApiKey produces a 32-byte base64url key with a storable hash", async () => {
  const k = await generateApiKey();
  assert.ok(k.plaintext.startsWith(KEY_PREFIX));
  assert.equal(k.plaintext.length, KEY_TOTAL_LENGTH);
  assert.equal(k.plaintext.length, 51);
  assert.match(k.plaintext.slice(KEY_PREFIX.length), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(k.hash, await hashApiKey(k.plaintext));
  assert.match(k.hash, /^[a-f0-9]{64}$/);
  // key_prefix column CHECK: '^sk-plat-[A-Za-z0-9_-]{8}$'
  assert.match(k.prefix, /^sk-plat-[A-Za-z0-9_-]{8}$/);
  assert.ok(k.plaintext.startsWith(k.prefix));
  // The stored artifacts must not contain the plaintext.
  assert.ok(!k.hash.includes(k.plaintext));
  assert.notEqual(k.prefix, k.plaintext);
});

test("generateApiKey does not repeat", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) seen.add((await generateApiKey()).plaintext);
  assert.equal(seen.size, 64);
});

test("isWellFormedApiKey enforces prefix, length and alphabet", () => {
  assert.ok(isWellFormedApiKey(CALLER_KEY));
  assert.ok(!isWellFormedApiKey("sk-plat-" + "A".repeat(42)));
  assert.ok(!isWellFormedApiKey("sk-plat-" + "A".repeat(44)));
  assert.ok(!isWellFormedApiKey("sk-live-" + "A".repeat(43)));
  assert.ok(!isWellFormedApiKey("sk-plat-" + "A".repeat(42) + "!"));
  assert.ok(!isWellFormedApiKey(""));
});

test("extractApiKey returns the token and rejects every malformed header the same way", () => {
  const ok = new Request("https://x/v1/chat/completions", {
    headers: { authorization: `Bearer ${CALLER_KEY}` },
  });
  assert.equal(extractApiKey(ok), CALLER_KEY);

  for (
    const header of [
      undefined,
      "",
      CALLER_KEY,
      `Basic ${CALLER_KEY}`,
      "Bearer ",
      "Bearer sk-plat-short",
      "Bearer sk-other-" + "A".repeat(43),
    ]
  ) {
    const req = new Request(
      "https://x/v1/chat/completions",
      header === undefined ? {} : { headers: { authorization: header } },
    );
    let thrown: GatewayError | null = null;
    try {
      extractApiKey(req);
    } catch (e) {
      thrown = e as GatewayError;
    }
    assert.ok(thrown instanceof GatewayError, `header ${JSON.stringify(header)} should reject`);
    assert.equal(thrown!.code, "invalid_api_key");
    assert.equal(thrown!.status, 401);
    // The rejection must never echo the presented token.
    assert.ok(!thrown!.message.includes("sk-plat-"));
  }
});

// ─── 2. Model-id parsing ─────────────────────────────────────────────────────

test("parseModelId splits creator/slug and lower-cases", () => {
  assert.deepEqual(parseModelId("JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"), {
    creatorHandle: "jonathancoletti",
    slug: "qwen3.8-27b-uncensored-gguf",
  });
});

test("a model with no '/' is a 400 whose message names the correct form", async () => {
  const err = await expectGatewayError(() => parseModelId("qwen3-8b"));
  assert.equal(err.code, "invalid_model_format");
  assert.equal(err.status, 400);
  assert.equal(err.param, "model");
  assert.match(err.message, /creator\/model-slug/);
});

test("parseModelId rejects empty, non-string, and multi-slash ids", async () => {
  for (const bad of ["", "   ", "a/b/c", "/slug", "creator/", "UPPER ONLY"]) {
    const err = await expectGatewayError(() => parseModelId(bad));
    assert.equal(err.code, "invalid_model_format", `for ${JSON.stringify(bad)}`);
    assert.equal(err.status, 400);
  }
  for (const bad of [undefined, null, 42, {}, []]) {
    const err = await expectGatewayError(() => parseModelId(bad));
    assert.equal(err.code, "invalid_model_format");
  }
});

// ─── 3. Error envelope shape ─────────────────────────────────────────────────

const ALL_CODES: GatewayErrorCode[] = [
  "invalid_model_format",
  "unsupported_parameter",
  "invalid_api_key",
  "revoked_api_key",
  "insufficient_balance",
  "account_suspended",
  "model_not_found",
  "rate_limit_exceeded",
  "internal_error",
  "not_implemented",
  "model_unavailable",
  "cold_start_timeout",
  "stream_timeout",
];

test("every GatewayErrorCode renders a complete OpenAI envelope", () => {
  for (const code of ALL_CODES) {
    const env = errorEnvelope(code, "boom", null);
    assert.deepEqual(Object.keys(env), ["error"]);
    assert.deepEqual(Object.keys(env.error).toSorted(), ["code", "message", "param", "type"]);
    assert.equal(env.error.code, code);
    assert.equal(env.error.message, "boom");
    assert.equal(env.error.param, null);
    assert.equal(typeof env.error.type, "string");
    assert.ok(env.error.type.length > 0);
    assert.equal(typeForCode(code), env.error.type);
  }
});

test("the CONTRACTS.md status table is honored exactly", () => {
  const table: Array<[GatewayErrorCode, number]> = [
    ["invalid_model_format", 400],
    ["unsupported_parameter", 400],
    ["invalid_api_key", 401],
    ["revoked_api_key", 401],
    ["insufficient_balance", 402],
    ["account_suspended", 403],
    ["model_not_found", 404],
    ["rate_limit_exceeded", 429],
    ["internal_error", 500],
    ["not_implemented", 501],
    ["model_unavailable", 503],
    ["cold_start_timeout", 504],
    ["stream_timeout", 504],
  ];
  for (const [code, status] of table) assert.equal(statusForCode(code), status, code);
});

test("errorResponse always carries x-nexus-request-id, even for errors", async () => {
  const rid = uuidv7();
  const res = errorResponse(new GatewayError("model_not_found", "nope"), rid);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get(REQUEST_ID_HEADER), rid);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assert.equal(body.error.code, "model_not_found");
  assert.equal(body.error.type, "invalid_request_error");
});

test("an unknown thrown value degrades to a 500 envelope that leaks nothing", async () => {
  const res = errorResponse(
    new Error("connect ECONNREFUSED 10.0.0.4:5432 at db.internal"),
    "rid-1",
  );
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, "internal_error");
  assert.ok(!body.error.message.includes("10.0.0.4"));
  assert.ok(!body.error.message.includes("ECONNREFUSED"));
});

test("402 carries x-nexus-balance-micro-usd", () => {
  const err = new GatewayError("insufficient_balance", "broke", {
    headers: { "x-nexus-balance-micro-usd": "1234" },
  });
  const res = errorResponse(err, "rid-2");
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("x-nexus-balance-micro-usd"), "1234");
});

// ─── 4. The private-model-returns-404 rule (FR-GW-012) ───────────────────────

const KEY_HASH = "a".repeat(64);
const parsedId = { creatorHandle: "owner", slug: "secret-model" };
const liveKeyOwner = { id: "k1", user_id: OWNER_ID, revoked_at: null };
const liveKeyStranger = { id: "k2", user_id: STRANGER_ID, revoked_at: null };

test("a private model requested by a NON-owner returns 404, never 403", async () => {
  invalidateModelCache();
  const err = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({
        api_key: liveKeyStranger,
        model: modelRow({ visibility: "private", user_id: OWNER_ID }),
      }),
      { useCache: false },
    )
  );
  assert.equal(err.status, 404);
  assert.notEqual(err.status, 403);
  assert.equal(err.code, "model_not_found");
});

test("private-not-owner is byte-identical to model-does-not-exist", async () => {
  invalidateModelCache();
  const missing = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({ api_key: liveKeyStranger, model: null }),
      {
        useCache: false,
      },
    )
  );
  const forbidden = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({
        api_key: liveKeyStranger,
        model: modelRow({ visibility: "private", user_id: OWNER_ID }),
      }),
      { useCache: false },
    )
  );
  assert.equal(missing.status, forbidden.status);
  assert.equal(missing.code, forbidden.code);
  assert.equal(missing.message, forbidden.message);
  assert.deepEqual(missing.toEnvelope(), forbidden.toEnvelope());
});

test("a private model NOT ready still returns 404 to a stranger (no existence leak)", async () => {
  invalidateModelCache();
  const err = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({
        api_key: liveKeyStranger,
        model: modelRow({ visibility: "private", user_id: OWNER_ID, status: "provisioning" }),
      }),
      { useCache: false },
    )
  );
  assert.equal(err.status, 404, "503 here would confirm the private model exists");
});

test("the OWNER of a private model resolves it successfully", async () => {
  invalidateModelCache();
  const { resolved } = await resolveRequest(
    KEY_HASH,
    parsedId,
    execReturning({
      api_key: liveKeyOwner,
      model: modelRow({ visibility: "private", user_id: OWNER_ID }),
    }),
    { useCache: false },
  );
  assert.equal(resolved.modelId, MODEL_ID);
  assert.equal(resolved.userId, OWNER_ID);
  assert.equal(resolved.servedModelName, "Qwen3.8-27B-Uncensored-Q4_K_M.gguf");
  // Balance is never part of resolution (FR-GW-053).
  assert.ok(!("balanceMicroUsd" in (resolved as unknown as Record<string, unknown>)));
});

test("resolve order: unknown key 401, revoked key 401 revoked_api_key, not-ready 503", async () => {
  invalidateModelCache();

  const unknown = await expectGatewayError(() =>
    resolveRequest(KEY_HASH, parsedId, execReturning({ api_key: null, model: modelRow() }), {
      useCache: false,
    })
  );
  assert.equal(unknown.status, 401);
  assert.equal(unknown.code, "invalid_api_key");

  const revoked = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({
        api_key: { id: "k3", user_id: OWNER_ID, revoked_at: "2026-01-01T00:00:00Z" },
        model: modelRow(),
      }),
      { useCache: false },
    )
  );
  assert.equal(revoked.status, 401);
  assert.equal(revoked.code, "revoked_api_key");

  const notReady = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({ api_key: liveKeyOwner, model: modelRow({ status: "provisioning" }) }),
      { useCache: false },
    )
  );
  assert.equal(notReady.status, 503);
  assert.equal(notReady.code, "model_unavailable");

  const deleted = await expectGatewayError(() =>
    resolveRequest(
      KEY_HASH,
      parsedId,
      execReturning({ api_key: liveKeyOwner, model: modelRow({ deleted_at: "2026-01-01" }) }),
      { useCache: false },
    )
  );
  assert.equal(deleted.status, 404);
});

test("the model LRU serves the model half but always re-fetches the key half", async () => {
  invalidateModelCache();
  const calls: boolean[] = [];
  const exec = (q: { includeModel: boolean }) => {
    calls.push(q.includeModel);
    return Promise.resolve({
      api_key: liveKeyOwner,
      model: q.includeModel ? modelRow() : null,
    } as RawResolveRow);
  };

  const first = await resolveRequest(KEY_HASH, parsedId, exec);
  const second = await resolveRequest(KEY_HASH, parsedId, exec);

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(calls, [true, false], "the key half is queried on BOTH requests");
  assert.equal(second.resolved.modelId, MODEL_ID);

  // A revoked key must fail immediately even with a warm model cache.
  const err = await expectGatewayError(() =>
    resolveRequest(KEY_HASH, parsedId, () =>
      Promise.resolve({
        api_key: { id: "k1", user_id: OWNER_ID, revoked_at: "2026-02-02T00:00:00Z" },
        model: null,
      }))
  );
  assert.equal(err.code, "revoked_api_key");
  invalidateModelCache();
});

// ─── 5. Upstream request builder ─────────────────────────────────────────────

const UPSTREAM_BASE = "http://127.0.0.1:8787";
const RUNPOD_KEY = "rp_test_secret_key";

test("stream:true is forced upstream even when the client asked for stream:false", () => {
  const built = buildUpstreamRequest(
    { model: "owner/m", messages: [], stream: false },
    resolvedFixture,
    {
      baseUrl: UPSTREAM_BASE,
      runpodApiKey: RUNPOD_KEY,
    },
  );
  assert.equal(built.payload.stream, true);
  const sent = JSON.parse(built.init.body as string);
  assert.equal(sent.stream, true);
});

test("stream_options.include_usage is injected and overrides the client's value", () => {
  const built = buildUpstreamRequest(
    { messages: [], stream: true, stream_options: { include_usage: false } },
    resolvedFixture,
    { baseUrl: UPSTREAM_BASE, runpodApiKey: RUNPOD_KEY },
  );
  assert.deepEqual(built.payload.stream_options, { include_usage: true });
});

test("the upstream model field is servedModelName, not creator/slug", () => {
  const built = buildUpstreamRequest(
    { model: "jonathancoletti/qwen3-8b", messages: [] },
    resolvedFixture,
    { baseUrl: UPSTREAM_BASE, runpodApiKey: RUNPOD_KEY },
  );
  assert.equal(built.payload.model, resolvedFixture.servedModelName);
  assert.notEqual(built.payload.model, "jonathancoletti/qwen3-8b");
});

test("the upstream URL is built from UPSTREAM_BASE_URL and the endpoint id", () => {
  const built = buildUpstreamRequest({ messages: [] }, resolvedFixture, {
    baseUrl: UPSTREAM_BASE + "/",
    runpodApiKey: RUNPOD_KEY,
  });
  assert.equal(
    built.url,
    `${UPSTREAM_BASE}/v2/${resolvedFixture.upstreamEndpointRef}/openai/v1/chat/completions`,
  );
});

test("the caller's sk-plat- key is NEVER forwarded upstream", () => {
  const built = buildUpstreamRequest(
    {
      messages: [{ role: "user", content: "hi" }],
      // Hostile client trying to smuggle the platform key into the upstream body.
      api_key: CALLER_KEY,
      authorization: `Bearer ${CALLER_KEY}`,
      extra_headers: { authorization: `Bearer ${CALLER_KEY}` },
    },
    resolvedFixture,
    { baseUrl: UPSTREAM_BASE, runpodApiKey: RUNPOD_KEY },
  );

  const serialized = JSON.stringify({
    url: built.url,
    headers: built.init.headers,
    body: built.init.body,
  });
  assert.ok(!serialized.includes("sk-plat-"), "no sk-plat- token may appear upstream");
  assert.ok(!serialized.includes(CALLER_KEY));
  assert.equal(built.init.headers["authorization"], `Bearer ${RUNPOD_KEY}`);
  assert.equal(built.payload.api_key, undefined);
  assert.equal(built.payload.authorization, undefined);
  assert.equal(built.payload.extra_headers, undefined);
});

test("honored params pass through, n is pinned to 1, unknown params are dropped", () => {
  const built = buildUpstreamRequest(
    {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 128,
      stop: ["\n"],
      seed: 7,
      response_format: { type: "json_object" },
      wild_unknown_param: "drop me",
    },
    resolvedFixture,
    { baseUrl: UPSTREAM_BASE, runpodApiKey: RUNPOD_KEY },
  );
  assert.equal(built.payload.temperature, 0.2);
  assert.equal(built.payload.top_p, 0.9);
  assert.equal(built.payload.max_tokens, 128);
  assert.deepEqual(built.payload.stop, ["\n"]);
  assert.equal(built.payload.seed, 7);
  assert.deepEqual(built.payload.response_format, { type: "json_object" });
  assert.equal(built.payload.n, 1);
  assert.equal(built.payload.wild_unknown_param, undefined);
});

// ─── 6. Request validation ───────────────────────────────────────────────────

test("n > 1 and logprobs are 400", async () => {
  const base = { messages: [{ role: "user", content: "hi" }] };

  const n = await expectGatewayError(() => validateChatRequest({ ...base, n: 2 }));
  assert.equal(n.status, 400);
  assert.equal(n.param, "n");

  const lp = await expectGatewayError(() => validateChatRequest({ ...base, logprobs: true }));
  assert.equal(lp.status, 400);
  assert.equal(lp.param, "logprobs");

  // n:1 and logprobs:false are fine.
  validateChatRequest({ ...base, n: 1, logprobs: false });
});

// ─── 6a. Tool calling (FR-TOOL-001, FR-TOOL-003) ─────────────────────────────

test("a well-formed tool request is accepted, not 501'd", () => {
  const base = { messages: [{ role: "user", content: "hi" }] };
  validateChatRequest({ ...base, tools: [WEATHER_TOOL] });
  validateChatRequest({ ...base, tools: [WEATHER_TOOL], tool_choice: "auto" });
  validateChatRequest({ ...base, tools: [WEATHER_TOOL], tool_choice: "required" });
  validateChatRequest({ ...base, tools: [WEATHER_TOOL], tool_choice: "none" });
  validateChatRequest({
    ...base,
    tools: [WEATHER_TOOL],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  });
  // The deprecated spelling, still emitted by several agent frameworks.
  validateChatRequest({ ...base, functions: [{ name: "get_weather" }], function_call: "auto" });
  validateChatRequest({ ...base, functions: [{ name: "f" }], function_call: { name: "f" } });
});

test("malformed tool parameters are 400 and name the parameter", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ tools: [] }, "tools"],
    [{ tools: "get_weather" }, "tools"],
    [{ tools: [{}] }, "tools"],
    [{ tools: [{ type: "function" }] }, "tools"],
    [{ tools: [{ type: "retrieval", function: { name: "x" } }] }, "tools"],
    [{ tools: [{ type: "function", function: { name: "" } }] }, "tools"],
    [{ functions: [] }, "functions"],
    [{ functions: [{ description: "no name" }] }, "functions"],
    [{ tools: [WEATHER_TOOL], tool_choice: "any" }, "tool_choice"],
    [{ tools: [WEATHER_TOOL], tool_choice: { type: "function" } }, "tool_choice"],
    // Requiring a tool without supplying one cannot be rendered by any template.
    [{ tool_choice: "required" }, "tool_choice"],
    [{ function_call: "required" }, "function_call"],
  ];
  for (const [body, param] of cases) {
    const err = await expectGatewayError(() => validateToolParams(body));
    assert.equal(err.status, 400, JSON.stringify(body));
    assert.equal(err.code, "unsupported_parameter", JSON.stringify(body));
    assert.equal(err.param, param, JSON.stringify(body));
  }
  // `tool_choice: "none"` with no tools is redundant, not wrong.
  validateToolParams({ tool_choice: "none" });
  validateToolParams({ function_call: "none" });
});

test("supports_tools: only a measured false refuses; null forwards", async () => {
  const withTools = { messages: [], tools: [WEATHER_TOOL] };

  const err = await expectGatewayError(() =>
    assertToolsSupported(withTools, { ...resolvedFixture, supportsTools: false })
  );
  assert.equal(err.status, 400);
  assert.equal(err.param, "tools");

  // null = "the template could not be read". Absence of evidence forwards.
  assertToolsSupported(withTools, { ...resolvedFixture, supportsTools: null });
  assertToolsSupported(withTools, { ...resolvedFixture, supportsTools: true });
  // A request that asks for nothing is unaffected by the flag.
  assertToolsSupported({ messages: [] }, { ...resolvedFixture, supportsTools: false });

  // The deprecated spelling is gated identically.
  const legacy = await expectGatewayError(() =>
    assertToolsSupported({ messages: [], functions: [{ name: "f" }] }, {
      ...resolvedFixture,
      supportsTools: false,
    })
  );
  assert.equal(legacy.status, 400);
});

test("tool definitions and replayed tool calls count toward the prompt estimate", () => {
  // FR-TOOL-006's "verify, do not assume": the schema is rendered INTO the
  // prompt, so a hold sized without it under-reserves on every agentic turn.
  assert.ok(
    toolDefinitionChars({ tools: [WEATHER_TOOL] }) > 100,
    "a JSON Schema is hundreds of characters and must not be counted as zero",
  );
  assert.equal(toolDefinitionChars({ messages: [] }), 0);

  // An assistant turn that only called a tool has content:null, so the
  // arguments are the whole message and are invisible to a content-only count.
  const replay = promptChars([
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"location":"Lisbon"}' },
      }],
    },
  ]);
  const bare = promptChars([{ role: "assistant", content: null }]);
  assert.ok(replay > bare + 25, `expected the arguments to count; got ${replay} vs ${bare}`);
});

test("the non-streaming assembler rebuilds tool_calls from split fragments", async () => {
  // Arguments arrive as fragments split mid-JSON, two calls interleaved by index
  // — the shape FR-TOOL-004 describes and the one a naive concatenation ruins.
  const sse = sseResponse([
    chunkLine([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    chunkLine([{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }],
      },
      finish_reason: null,
    }]),
    chunkLine([{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] },
      finish_reason: null,
    }]),
    chunkLine([{
      index: 0,
      delta: {
        tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "" } }],
      },
      finish_reason: null,
    }]),
    chunkLine([{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"Lisbon"}' } }] },
      finish_reason: null,
    }]),
    chunkLine([{
      index: 0,
      delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] },
      finish_reason: null,
    }]),
    chunkLine([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
      usage: { prompt_tokens: 41, completion_tokens: 19, total_tokens: 60 },
    }),
  ]);

  const res = await assembleNonStreaming(sse, "req-1", "owner/model", { value: null });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    choices: Array<{
      finish_reason: string;
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };

  const choice = body.choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  // OpenAI sends null, and agent frameworks branch on it being falsy.
  assert.equal(choice.message.content, null);
  const calls = choice.message.tool_calls ?? [];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "call_a");
  assert.equal(calls[0].function.name, "get_weather");
  // Reassembled across a mid-key split, and left as the string the wire carried.
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { location: "Lisbon" });
  assert.equal(calls[1].id, "call_b");
  assert.equal(calls[1].function.arguments, "{}");
});

test("the assembler infers finish_reason and synthesizes a missing tool-call id", async () => {
  // A worker that ends without a finish_reason must not read as a plain "stop":
  // the client would never execute the call it just received.
  const sse = sseResponse([
    chunkLine([{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] },
      finish_reason: null,
    }]),
  ]);
  const res = await assembleNonStreaming(sse, "req-2", "owner/model", { value: null });
  const body = await res.json() as {
    choices: Array<{
      finish_reason: string;
      message: { tool_calls?: Array<{ id: string; type: string }> };
    }>;
  };
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  const call = body.choices[0].message.tool_calls?.[0];
  // Unanswerable without an id, so one is synthesized rather than left undefined.
  assert.equal(call?.id, "call_req-2_0");
  assert.equal(call?.type, "function");
});

test("fragments with no index append to the open call, not to a new one", async () => {
  // Defensive path: no worker we serve omits `index`, and if one did, splitting
  // the arguments across two entries would leave neither parseable.
  const sse = sseResponse([
    chunkLine([{
      index: 0,
      delta: { tool_calls: [{ id: "call_a", type: "function", function: { name: "f", arguments: "" } }] },
      finish_reason: null,
    }]),
    chunkLine([{ index: 0, delta: { tool_calls: [{ function: { arguments: '{"a"' } }] }, finish_reason: null }]),
    chunkLine([{ index: 0, delta: { tool_calls: [{ function: { arguments: ":1}" } }] }, finish_reason: null }]),
    // A different id, still with no index: that IS a second call.
    chunkLine([{
      index: 0,
      delta: { tool_calls: [{ id: "call_b", type: "function", function: { name: "g", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    }]),
  ]);
  const res = await assembleNonStreaming(sse, "req-4", "owner/model", { value: null });
  const body = await res.json() as {
    choices: Array<{
      message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    }>;
  };
  const calls = body.choices[0].message.tool_calls ?? [];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "call_a");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { a: 1 });
  assert.equal(calls[1].id, "call_b");
  assert.equal(calls[1].function.name, "g");
});

test("a text-only response keeps content as a string and never grows tool_calls", async () => {
  const sse = sseResponse([
    chunkLine([{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }]),
    chunkLine([{ index: 0, delta: { content: " there" }, finish_reason: "stop" }]),
  ]);
  const res = await assembleNonStreaming(sse, "req-3", "owner/model", { value: null });
  const body = await res.json() as {
    choices: Array<{ finish_reason: string; message: { content: unknown; tool_calls?: unknown } }>;
  };
  assert.equal(body.choices[0].message.content, "Hi there");
  assert.equal(body.choices[0].message.tool_calls, undefined);
  assert.equal(body.choices[0].finish_reason, "stop");
});

test("an empty or missing messages array is rejected", async () => {
  for (const body of [{}, { messages: [] }, { messages: "hi" }]) {
    const err = await expectGatewayError(() => validateChatRequest(body));
    assert.equal(err.status, 400);
    assert.equal(err.param, "messages");
  }
});

test("the prompt estimator is conservative (chars/3.5 * 1.15)", () => {
  assert.equal(estimatePromptTokens(0), 0);
  assert.equal(estimatePromptTokens(350), Math.ceil(100 * 1.15));
  assert.ok(estimatePromptTokens(3500) > 1000, "must over-estimate, never under");
  const chars = promptChars([{ role: "user", content: "hello" }]);
  assert.ok(chars >= 5);
});

// ─── 7. Upstream failure mapping & sanitization ──────────────────────────────

test("RunPod 401/403 becomes a 500 internal error with no upstream detail", () => {
  for (const status of [401, 403]) {
    const f = mapUpstreamError(status, '{"error":"Invalid API key for endpoint ep_9xk2"}');
    assert.equal(f.error.status, 500);
    assert.equal(f.error.code, "internal_error");
    assert.ok(!/ep_9xk2/.test(f.error.message));
    assert.ok(!/api key/i.test(f.error.message), "must not blame the caller's key");
  }
});

test("RunPod 404 becomes 503 model_unavailable", () => {
  const f = mapUpstreamError(404, "endpoint not found");
  assert.equal(f.error.status, 503);
  assert.equal(f.error.code, "model_unavailable");
});

test("RunPod 429 stays 429 and carries Retry-After", () => {
  const f = mapUpstreamError(429, "too many requests", new Headers({ "retry-after": "12" }));
  assert.equal(f.error.status, 429);
  assert.equal(f.error.code, "rate_limit_exceeded");
  assert.equal(f.error.extraHeaders["retry-after"], "12");

  const noHeader = mapUpstreamError(429, "too many requests");
  assert.equal(noHeader.error.extraHeaders["retry-after"], "1");
});

test("an OOM becomes a 500 with a hardware-tier hint and flags the model", () => {
  for (
    const body of [
      "CUDA error: out of memory",
      "ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 12000 MB",
      "torch.OutOfMemoryError: CUDA out of memory",
    ]
  ) {
    assert.ok(looksLikeOom(body), body);
    const f = mapUpstreamError(500, body);
    assert.equal(f.error.status, 500);
    assert.equal(f.flagModel, true);
    assert.match(f.error.message, /hardware tier/i);
  }
});

test("sanitizeUpstreamText strips endpoint ids, hosts, IPs, paths and stack frames", () => {
  const dirty = [
    "POST https://api.runpod.ai/v2/8f3kd92hs01xq/openai/v1/chat/completions failed",
    'endpoint_id: "8f3kd92hs01xq"',
    "connect to 10.0.13.7:8000 refused via worker-3.internal",
    "Traceback (most recent call last):",
    '  File "/usr/lib/python3/vllm/engine/async_llm.py", line 412, in step',
    "  at Object.handler (/srv/functions/gateway/index.ts:88:11)",
    "C:\\workers\\llama\\main.cpp",
  ].join("\n");

  const clean = sanitizeUpstreamText(dirty);
  for (
    const secret of [
      "8f3kd92hs01xq",
      "api.runpod.ai",
      "10.0.13.7",
      "worker-3.internal",
      "/usr/lib/python3",
      "async_llm.py",
      "index.ts:88",
      "C:\\workers",
      "Traceback",
    ]
  ) {
    assert.ok(!clean.includes(secret), `leaked "${secret}" in: ${clean}`);
  }
  assert.ok(clean.length <= 500);
  assert.equal(sanitizeUpstreamText(null), "");
});

test("mapUpstreamError never puts raw upstream text into the client message", () => {
  const raw = "boom at https://api.runpod.ai/v2/secretid/run — 10.1.2.3";
  for (const status of [400, 401, 404, 429, 500, 502]) {
    const f = mapUpstreamError(status, raw);
    assert.ok(!f.error.message.includes("secretid"));
    assert.ok(!f.error.message.includes("10.1.2.3"));
    assert.ok(!f.error.message.includes("runpod"));
  }
});

// ─── 8. Settlement predicate ─────────────────────────────────────────────────

test("shouldVoid releases the hold instead of billing phantom prefill", () => {
  const est = (p: number, c: number): UsageResult => ({
    promptTokens: p,
    completionTokens: c,
    cachedPromptTokens: 0,
    source: "estimated",
  });
  const up = (p: number, c: number): UsageResult => ({
    promptTokens: p,
    completionTokens: c,
    cachedPromptTokens: 0,
    source: "upstream",
  });

  // Upstream failed: never bill, whatever the estimator says.
  assert.equal(shouldVoid(est(3, 0), true), true);
  assert.equal(shouldVoid(up(11, 2), true), true);

  // Nothing reported at all.
  assert.equal(shouldVoid(est(0, 0), false), true);
  assert.equal(shouldVoid(null, false), true);

  // The regression this exists for: the estimator invents a prompt count from
  // input chars even when no byte ever arrived. That must NOT be billed.
  assert.equal(shouldVoid(est(3, 0), false), true);

  // Real work: bill it.
  assert.equal(shouldVoid(est(11, 2), false), false);
  assert.equal(shouldVoid(up(11, 2), false), false);
  // Authoritative prefill with an empty completion IS real GPU work.
  assert.equal(shouldVoid(up(11, 0), false), false);
});

// ─── 9. Request id ───────────────────────────────────────────────────────────

test("uuidv7 is well-formed, version 7, variant 10, and time-ordered", () => {
  const a = uuidv7();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const ids = Array.from({ length: 200 }, () => uuidv7());
  assert.equal(new Set(ids).size, 200);

  // Timestamp prefix decodes to ~now.
  const ms = parseInt(a.replace(/-/g, "").slice(0, 12), 16);
  assert.ok(Math.abs(ms - Date.now()) < 5000, `timestamp prefix ${ms} not close to now`);
});
