/**
 * Nexus inference gateway — Supabase Edge Function (Deno).
 *
 *   POST /v1/chat/completions   OpenAI-compatible, byte-for-byte
 *   GET  /v1/models             OpenAI-shaped catalog
 *   OPTIONS *                   CORS preflight
 *
 * The pipeline is ordered to fail as cheaply as possible (PRD §4.2.2) and every
 * pre-upstream step counts against the p95 < 10 ms overhead budget (§4.2.6).
 *
 * OWNERSHIP: this file, auth.ts, resolve.ts, errors.ts. `stream.ts` is owned by
 * another agent and imported against the frozen interface documented in README.md.
 */

import type {
  StreamMeta,
  UsageResult,
} from "../../../packages/shared/types.ts";
import type { ResolvedRequest } from "../../../packages/shared/types.ts";
import {
  BALANCE_HEADER,
  CORS_HEADERS,
  errorResponse,
  GatewayError,
  mapUpstreamError,
  REQUEST_ID_HEADER,
  sseErrorFrame,
} from "./errors.ts";
import { extractApiKey, hashApiKey } from "./auth.ts";
import { proxyStream } from "./stream.ts";
import {
  makePostgrestExecutor,
  parseModelId,
  resolveRequest,
  type ResolveExecutor,
} from "./resolve.ts";

// ─── Environment ─────────────────────────────────────────────────────────────

/** Reads Deno env when present, process.env otherwise (keeps the module testable). */
export function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.get) return g.Deno.env.get(name) ?? undefined;
  return g.process?.env?.[name] ?? undefined;
}

const DEFAULT_UPSTREAM_BASE_URL = "https://api.runpod.ai";
const TOTAL_STREAM_BUDGET_MS = 300_000; // FR-GW-047
const CHARS_PER_TOKEN = 3.5;
const PROMPT_ESTIMATE_SAFETY = 1.15;
const DEFAULT_MAX_TOKENS = 4096;

// ─── UUIDv7 (FR-GW-005) ──────────────────────────────────────────────────────

/**
 * RFC 9562 UUIDv7: 48-bit big-endian unix-ms timestamp, version 7, variant 10.
 * Time-ordered so it indexes well as the `usage_transactions` primary key.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ms = Date.now();
  bytes[0] = Math.floor(ms / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ms / 0x100000000) & 0xff;
  bytes[2] = Math.floor(ms / 0x1000000) & 0xff;
  bytes[3] = Math.floor(ms / 0x10000) & 0xff;
  bytes[4] = Math.floor(ms / 0x100) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10

  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

// ─── Structured logging ──────────────────────────────────────────────────────

/**
 * The ONLY logging entry point. JSON lines, fixed field set.
 * NEVER add message content, an API key (plaintext or otherwise), a bearer
 * header, or generated tokens to this object.
 */
export interface GatewayLog {
  request_id: string;
  outcome: string;
  user_id?: string | null;
  model_id?: string | null;
  gateway_overhead_ms?: number;
  cache_hit?: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_prompt_tokens?: number;
  usage_source?: string;
  cost_micro_usd?: number;
  cold_start?: boolean;
  ttft_ms?: number | null;
  duration_ms?: number | null;
  client_disconnected?: boolean;
  error_code?: string;
  upstream_detail?: string;
  model_flagged?: boolean;
}

export function logJson(fields: GatewayLog): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), src: "gateway", ...fields }));
}

// ─── Request validation (§4.2.1 honored/rejected params) ─────────────────────

/** Params forwarded upstream. An allowlist, so nothing unexpected can be relayed. */
const HONORED_PARAMS = [
  "messages",
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "response_format",
  "user",
] as const;

export interface ChatBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  n?: unknown;
  logprobs?: unknown;
  top_logprobs?: unknown;
  tools?: unknown;
  functions?: unknown;
  tool_choice?: unknown;
  function_call?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  [k: string]: unknown;
}

/** Throws a GatewayError for anything we refuse. Hand-rolled — no schema lib (FR-GW-051). */
export function validateChatRequest(body: ChatBody): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayError(
      "unsupported_parameter",
      "Invalid request body: expected a JSON object.",
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(
      "unsupported_parameter",
      "You must provide a non-empty 'messages' array.",
      { param: "messages" },
    );
  }

  // Phase 2 features — explicitly not implemented rather than silently dropped.
  for (const p of ["tools", "functions", "tool_choice", "function_call"] as const) {
    if (body[p] !== undefined && body[p] !== null) {
      throw new GatewayError(
        "not_implemented",
        `The '${p}' parameter is not supported yet. Tool and function calling are ` +
          `planned for a future release.`,
        { param: p },
      );
    }
  }

  if (body.n !== undefined && body.n !== null && Number(body.n) !== 1) {
    throw new GatewayError(
      "unsupported_parameter",
      "Only n=1 is supported. Issue multiple requests for multiple completions.",
      { param: "n" },
    );
  }

  if (body.logprobs !== undefined && body.logprobs !== null && body.logprobs !== false) {
    throw new GatewayError(
      "unsupported_parameter",
      "The 'logprobs' parameter is not supported.",
      { param: "logprobs" },
    );
  }
  if (body.top_logprobs !== undefined && body.top_logprobs !== null) {
    throw new GatewayError(
      "unsupported_parameter",
      "The 'top_logprobs' parameter is not supported.",
      { param: "top_logprobs" },
    );
  }
}

/** Total characters across message contents — the input to the prompt estimator. */
export function promptChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") total += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        const t = (part as { text?: unknown })?.text;
        if (typeof t === "string") total += t.length;
      }
    }
    const role = (m as { role?: unknown }).role;
    if (typeof role === "string") total += role.length + 4; // chat-template overhead
  }
  return total;
}

/** ceil(chars / 3.5) * 1.15, rounded up. Deliberately conservative (§4.2.3). */
export function estimatePromptTokens(chars: number): number {
  return Math.ceil(Math.ceil(chars / CHARS_PER_TOKEN) * PROMPT_ESTIMATE_SAFETY);
}

// ─── Upstream request builder (FR-GW-030/031/032) ────────────────────────────

export interface UpstreamRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
  /** The exact JSON sent upstream — exposed for tests and never logged. */
  payload: Record<string, unknown>;
}

/**
 * Builds the upstream call.
 *
 *   - `stream` is ALWAYS true, regardless of what the client asked for (FR-GW-030).
 *   - `stream_options.include_usage` is always injected (FR-GW-031).
 *   - `model` is the worker's served name, not the platform `creator/slug` (FR-GW-032).
 *   - Authorization is RUNPOD_API_KEY. The caller's `sk-plat-` key is never
 *     forwarded, and no client header is copied through.
 */
export function buildUpstreamRequest(
  body: ChatBody,
  resolved: ResolvedRequest,
  opts: { baseUrl: string; runpodApiKey: string; signal?: AbortSignal },
): UpstreamRequest {
  const payload: Record<string, unknown> = {};
  for (const key of HONORED_PARAMS) {
    if (body[key] !== undefined) payload[key] = body[key];
  }

  payload.model = resolved.servedModelName;
  payload.stream = true;
  payload.stream_options = { include_usage: true };
  payload.n = 1;

  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/v2/${resolved.runpodEndpointId}/openai/v1/chat/completions`;

  return {
    url,
    payload,
    init: {
      method: "POST",
      headers: {
        "authorization": `Bearer ${opts.runpodApiKey}`,
        "content-type": "application/json",
        "accept": "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: opts.signal,
    },
  };
}

export function resolveMaxTokens(body: ChatBody, contextLength: number): number {
  const raw = body.max_tokens ?? body.max_completion_tokens;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), contextLength);
  return Math.min(DEFAULT_MAX_TOKENS, contextLength);
}

// ─── RPC plumbing ────────────────────────────────────────────────────────────

export type RpcCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export function makeRpcCaller(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): RpcCaller {
  const base = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc`;
  return async (name, args) => {
    const res = await fetchImpl(`${base}/${name}`, {
      method: "POST",
      headers: {
        "apikey": serviceRoleKey,
        "authorization": `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new GatewayError(
        "internal_error",
        "The server encountered an internal error. Please retry.",
      );
    }
    return await res.json();
  };
}

export interface AuthorizeResult {
  ok: boolean;
  code?: string;
  txn_id?: string;
  hold_micro_usd?: number;
  balance_micro_usd?: number;
}

// ─── Dependency injection surface (tests/mock upstream) ──────────────────────

export interface GatewayDeps {
  exec: ResolveExecutor;
  rpc: RpcCaller;
  fetchImpl: typeof fetch;
  upstreamBaseUrl: string;
  runpodApiKey: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Deferred so this module stays importable before stream.ts lands. */
  proxyStream: ProxyStreamFn;
}

export type ProxyStreamFn = (
  upstreamPromise: Promise<Response>,
  onComplete: (usage: UsageResult, meta: StreamMeta) => void,
  opts: { coldStartBudgetMs: number; totalBudgetMs: number; estimateFrom?: { promptChars: number } },
) => Response;

let depsCache: GatewayDeps | null = null;

async function defaultDeps(): Promise<GatewayDeps> {
  if (depsCache) return depsCache;
  const supabaseUrl = getEnv("SUPABASE_URL") ?? "";
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  depsCache = {
    supabaseUrl,
    serviceRoleKey,
    fetchImpl: fetch,
    upstreamBaseUrl: getEnv("UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL,
    runpodApiKey: getEnv("RUNPOD_API_KEY") ?? "",
    exec: makePostgrestExecutor(supabaseUrl, serviceRoleKey),
    rpc: makeRpcCaller(supabaseUrl, serviceRoleKey),
    proxyStream: proxyStream as ProxyStreamFn,
  };
  return depsCache;
}

/** Test seam. */
export function setDeps(d: GatewayDeps | null): void {
  depsCache = d;
}

// ─── Chat completions ────────────────────────────────────────────────────────

async function handleChatCompletions(
  req: Request,
  requestId: string,
  t0: number,
  deps: GatewayDeps,
): Promise<Response> {
  // 1. Bearer shape check — ~0 ms, rejects junk before the body parser runs.
  const apiKey = extractApiKey(req);

  // 2. Body.
  let body: ChatBody;
  try {
    body = await req.json() as ChatBody;
  } catch {
    throw new GatewayError(
      "unsupported_parameter",
      "Invalid request body: could not parse JSON.",
    );
  }

  // 3. Model addressing + parameter validation, before any hashing or IO.
  const parsed = parseModelId(body.model);
  validateChatRequest(body);

  // 4. Hash, then the single resolution round trip.
  const keyHash = await hashApiKey(apiKey);
  const { resolved, cacheHit } = await resolveRequest(keyHash, parsed, deps.exec);

  // 5. Reserve. Balance and suspension are read INSIDE this transaction and are
  //    never cached (FR-GW-053).
  const chars = promptChars(body.messages);
  const maxTokens = resolveMaxTokens(body, resolved.contextLength);
  const clientWantsStream = body.stream === true;

  const auth = await deps.rpc("authorize_request", {
    p_txn_id: requestId, // FR-GW-005: the request id IS the usage_transactions id
    p_user_id: resolved.userId,
    p_api_key_id: resolved.apiKeyId,
    p_model_id: resolved.modelId,
    p_est_prompt_tokens: estimatePromptTokens(chars),
    p_max_tokens: maxTokens,
    p_was_streaming: clientWantsStream,
  }) as AuthorizeResult;

  if (!auth?.ok) throw authorizeFailure(auth);

  // 6. Build and issue upstream. Everything above this line is gateway overhead.
  const upstream = buildUpstreamRequest(body, resolved, {
    baseUrl: deps.upstreamBaseUrl,
    runpodApiKey: deps.runpodApiKey,
  });

  const failure: { value: GatewayError | null; flagged: boolean; detail: string } = {
    value: null,
    flagged: false,
    detail: "",
  };

  // ── gateway_overhead_ms measurement point (FR-GW-050) ──────────────────────
  const overheadMs = now() - t0;

  const upstreamPromise = fetchUpstreamWithRetry(deps, upstream, failure);

  let settled = false;
  const onComplete = (usage: UsageResult, meta: StreamMeta) => {
    if (settled) return;
    settled = true;
    // FR-GW-046: settlement is NOT awaited inside the client-write path.
    void settle(deps, requestId, resolved, usage, meta, overheadMs, cacheHit, failure);
  };

  const sse = deps.proxyStream(upstreamPromise, onComplete, {
    coldStartBudgetMs: resolved.coldStartBudgetS * 1000,
    totalBudgetMs: TOTAL_STREAM_BUDGET_MS,
    estimateFrom: { promptChars: chars },
  });

  if (clientWantsStream) {
    return withGatewayHeaders(sse, requestId, { "x-nexus-overhead-ms": String(Math.round(overheadMs)) });
  }

  // FR-GW-030: non-streaming clients get the forced stream buffered and assembled.
  return await assembleNonStreaming(sse, requestId, String(body.model), failure, overheadMs);
}

/**
 * Maps the `{ok:false, code}` shape of `authorize_request` onto a gateway error.
 * Codes emitted by the RPC today: account_suspended | user_not_found |
 * model_unavailable | insufficient_balance. Anything unrecognized is treated as
 * insufficient_balance, which is the safe default (it never grants access).
 */
export function authorizeFailure(auth: AuthorizeResult | null | undefined): GatewayError {
  const code = auth?.code ?? "insufficient_balance";

  if (code === "account_suspended") {
    return new GatewayError(
      "account_suspended",
      "This account is suspended. Contact support@nexus.dev.",
    );
  }
  if (code === "user_not_found") {
    // The key resolved but its owner did not: do not confirm anything.
    return new GatewayError(
      "invalid_api_key",
      "Incorrect API key provided. You can find your API key at " +
        "https://nexus.dev/dashboard/keys.",
    );
  }
  if (code === "model_unavailable") {
    return new GatewayError(
      "model_unavailable",
      "The model is not currently available for inference. Please try again later.",
      { param: "model" },
    );
  }

  return new GatewayError(
    "insufficient_balance",
    "Insufficient balance for this request. Add credit at " +
      "https://nexus.dev/dashboard/billing.",
    // FR-GW-022: the 402 carries the live balance and a top-up URL.
    { headers: { [BALANCE_HEADER]: String(Number(auth?.balance_micro_usd ?? 0)) } },
  );
}

/**
 * One retry on a connection-level failure, before any byte reaches the client
 * (FR-GW-035). A non-ok upstream status is converted into a terminating SSE
 * error frame so `proxyStream` always receives a well-formed stream, and the
 * mapped failure is recorded for the non-streaming path and the logs.
 */
async function fetchUpstreamWithRetry(
  deps: GatewayDeps,
  upstream: UpstreamRequest,
  failure: { value: GatewayError | null; flagged: boolean; detail: string },
): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await deps.fetchImpl(upstream.url, upstream.init);
      break;
    } catch (e) {
      if (attempt === 1) {
        failure.value = new GatewayError(
          "model_unavailable",
          "Could not reach the model worker. Please try again shortly.",
        );
        failure.detail = String((e as Error)?.name ?? "network_error");
        return sseFailureResponse(failure.value);
      }
    }
  }

  if (!res) {
    failure.value = new GatewayError(
      "model_unavailable",
      "Could not reach the model worker. Please try again shortly.",
    );
    return sseFailureResponse(failure.value);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const mapped = mapUpstreamError(res.status, text, res.headers);
    failure.value = mapped.error;
    failure.flagged = mapped.flagModel;
    failure.detail = mapped.logDetail;
    return sseFailureResponse(mapped.error);
  }

  return res;
}

function sseFailureResponse(err: GatewayError): Response {
  return new Response(sseErrorFrame(err.code, err.message), {
    status: 200, // headers already flushed to the client; the frame carries the cause
    headers: { "content-type": "text/event-stream" },
  });
}

function withGatewayHeaders(
  res: Response,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(res.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extra })) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ─── Non-streaming assembly (FR-GW-030) ──────────────────────────────────────

/** Buffers the forced upstream stream and emits one `chat.completion` object. */
export async function assembleNonStreaming(
  sse: Response,
  requestId: string,
  clientFacingModel: string,
  failure: { value: GatewayError | null },
  overheadMs = 0,
): Promise<Response> {
  const raw = await sse.text();

  let content = "";
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let created = Math.floor(Date.now() / 1000);
  let embeddedError: { code?: string; message?: string } | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.error) {
      embeddedError = chunk.error as { code?: string; message?: string };
      continue;
    }
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.usage) usage = chunk.usage as Record<string, unknown>;
    const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    const delta = choice.delta as { content?: unknown } | undefined;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }

  if (failure.value) return errorResponse(failure.value, requestId);
  if (embeddedError) {
    return errorResponse(
      new GatewayError(
        (embeddedError.code as never) ?? "internal_error",
        embeddedError.message ?? "The server encountered an internal error.",
      ),
      requestId,
    );
  }

  const completion = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created,
    model: clientFacingModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: null,
        finish_reason: finishReason ?? "stop",
      },
    ],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      [REQUEST_ID_HEADER]: requestId,
      "x-nexus-overhead-ms": String(Math.round(overheadMs)),
      ...CORS_HEADERS,
    },
  });
}

// ─── Settlement ──────────────────────────────────────────────────────────────

/**
 * Decides between `void_reservation` and `deduct_token_cost`.
 *
 * "Zero tokens produced" cannot be `prompt + completion === 0`: when upstream
 * fails before emitting a byte, the fallback estimator still reports a non-zero
 * PROMPT count derived from the input characters (FR-GW-044 path 3). Settling on
 * that bills a caller for GPU work that never happened.
 *
 * The hold is released when:
 *   - upstream failed outright, or
 *   - nothing at all was reported, or
 *   - nothing was generated AND the counts are only estimates (so there is no
 *     authoritative evidence that prefill ran).
 *
 * A completion of 0 with an AUTHORITATIVE upstream usage object is still billed:
 * the worker really did prefill the prompt. A completed stream is never left
 * unbilled (FR-GW-044) — revenue leakage is worse than a slightly imprecise charge.
 */
export function shouldVoid(usage: UsageResult | null | undefined, upstreamFailed: boolean): boolean {
  if (upstreamFailed) return true;
  const prompt = usage?.promptTokens ?? 0;
  const completion = usage?.completionTokens ?? 0;
  if (prompt === 0 && completion === 0) return true;
  if (completion === 0 && usage?.source !== "upstream") return true;
  return false;
}

async function settle(
  deps: GatewayDeps,
  requestId: string,
  resolved: ResolvedRequest,
  usage: UsageResult,
  meta: StreamMeta,
  overheadMs: number,
  cacheHit: boolean,
  failure: { value: GatewayError | null; flagged: boolean; detail: string },
): Promise<void> {
  try {
    if (shouldVoid(usage, failure.value !== null)) {
      // No GPU work billed: release the hold rather than settle it (FR-GW-020).
      await deps.rpc("void_reservation", {
        p_txn_id: requestId,
        p_error_code: failure.value?.code ?? "no_tokens_produced",
        p_error_message: failure.value?.message ?? "Stream produced zero tokens.",
      });
      logJson({
        request_id: requestId,
        outcome: failure.value ? "upstream_error" : "voided",
        user_id: resolved.userId,
        model_id: resolved.modelId,
        gateway_overhead_ms: round2(overheadMs),
        cache_hit: cacheHit,
        prompt_tokens: 0,
        completion_tokens: 0,
        cold_start: meta?.coldStart ?? false,
        ttft_ms: meta?.ttftMs ?? null,
        duration_ms: meta?.durationMs ?? null,
        client_disconnected: meta?.clientGone ?? false,
        error_code: failure.value?.code,
        upstream_detail: failure.detail || undefined,
        model_flagged: failure.flagged || undefined,
      });
      return;
    }

    const result = await deps.rpc("deduct_token_cost", {
      p_txn_id: requestId,
      p_prompt_tokens: usage.promptTokens,
      p_completion_tokens: usage.completionTokens,
      p_ttft_ms: meta?.ttftMs ?? null,
      p_duration_ms: meta?.durationMs ?? null,
      p_cold_start: meta?.coldStart ?? false,
      p_usage_estimated: usage.source === "estimated",
      p_client_disconnected: meta?.clientGone ?? false,
    }) as { cost_micro_usd?: number } | null;

    logJson({
      request_id: requestId,
      outcome: "settled",
      user_id: resolved.userId,
      model_id: resolved.modelId,
      gateway_overhead_ms: round2(overheadMs),
      cache_hit: cacheHit,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      cached_prompt_tokens: usage.cachedPromptTokens ?? 0,
      usage_source: usage.source,
      cost_micro_usd: Number(result?.cost_micro_usd ?? 0),
      cold_start: meta?.coldStart ?? false,
      ttft_ms: meta?.ttftMs ?? null,
      duration_ms: meta?.durationMs ?? null,
      client_disconnected: meta?.clientGone ?? false,
    });
  } catch (e) {
    // Settlement must never throw into the stream path.
    logJson({
      request_id: requestId,
      outcome: "settlement_failed",
      user_id: resolved.userId,
      model_id: resolved.modelId,
      error_code: e instanceof GatewayError ? e.code : "internal_error",
    });
  }
}

// ─── GET /v1/models (FR-GW-004) ──────────────────────────────────────────────

async function handleModels(
  req: Request,
  requestId: string,
  deps: GatewayDeps,
): Promise<Response> {
  const apiKey = extractApiKey(req);
  const keyHash = await hashApiKey(apiKey);

  // The key lookup is never cached, so this reuses the resolve executor with a
  // sentinel model that cannot exist; we only need the key half.
  const keyRow = await deps.exec({
    keyHash,
    creatorHandle: "-",
    slug: "-",
    includeModel: false,
  });
  const key = keyRow?.api_key;
  if (!key || key.revoked_at) {
    throw new GatewayError(
      "invalid_api_key",
      "Incorrect API key provided. You can find your API key at " +
        "https://nexus.dev/dashboard/keys.",
    );
  }

  const base = deps.supabaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    select: "slug,created_at,visibility,user_id,profiles!inner(handle)",
    status: "eq.ready",
    deleted_at: "is.null",
    or: `(visibility.eq.public,user_id.eq.${key.user_id})`,
    order: "created_at.desc",
    limit: "1000",
  });

  const res = await deps.fetchImpl(`${base}/rest/v1/custom_models?${params}`, {
    headers: {
      "apikey": deps.serviceRoleKey,
      "authorization": `Bearer ${deps.serviceRoleKey}`,
    },
  });
  if (!res.ok) {
    throw new GatewayError(
      "internal_error",
      "The server encountered an internal error. Please retry.",
    );
  }

  const rows = await res.json() as Array<{
    slug: string;
    created_at: string;
    profiles?: { handle?: string } | Array<{ handle?: string }>;
  }>;

  const data = rows.map((r) => {
    const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    const handle = p?.handle ?? "unknown";
    return {
      id: `${handle}/${r.slug}`,
      object: "model",
      created: Math.floor(new Date(r.created_at).getTime() / 1000),
      owned_by: handle,
    };
  });

  logJson({ request_id: requestId, outcome: "models_listed", user_id: key.user_id });

  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      [REQUEST_ID_HEADER]: requestId,
      ...CORS_HEADERS,
    },
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Matches both `/v1/...` and the deployed `/functions/v1/gateway/v1/...` form. */
function routeOf(pathname: string): string {
  const p = pathname.replace(/\/+$/, "");
  if (p.endsWith("/v1/chat/completions")) return "chat";
  if (p.endsWith("/v1/models")) return "models";
  return "unknown";
}

export async function handleRequest(
  req: Request,
  depsOverride?: GatewayDeps,
): Promise<Response> {
  const t0 = now();
  const requestId = uuidv7(); // FR-GW-005: on EVERY response, including errors

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, [REQUEST_ID_HEADER]: requestId },
    });
  }

  try {
    const route = routeOf(new URL(req.url).pathname);
    const deps = depsOverride ?? await defaultDeps();

    if (route === "chat") {
      if (req.method !== "POST") {
        throw new GatewayError(
          "not_implemented",
          "Method not allowed. Use POST for /v1/chat/completions.",
        );
      }
      return await handleChatCompletions(req, requestId, t0, deps);
    }

    if (route === "models") {
      if (req.method !== "GET") {
        throw new GatewayError(
          "not_implemented",
          "Method not allowed. Use GET for /v1/models.",
        );
      }
      return await handleModels(req, requestId, deps);
    }

    throw new GatewayError(
      "model_not_found",
      "Unrecognized request URL. This gateway serves POST /v1/chat/completions " +
        "and GET /v1/models.",
    );
  } catch (err) {
    const code = err instanceof GatewayError ? err.code : "internal_error";
    logJson({
      request_id: requestId,
      outcome: "rejected",
      error_code: code,
      gateway_overhead_ms: round2(now() - t0),
    });
    return errorResponse(err, requestId);
  }
}

// Only serve when executed as the Edge Function entrypoint; importing this
// module (tests, tooling) must not open a listener.
// deno-lint-ignore no-explicit-any
const _g = globalThis as any;
if (_g.Deno?.serve && import.meta.main) {
  _g.Deno.serve((req: Request) => handleRequest(req));
}
