/**
 * Mock RunPod OpenAI-compatible serverless upstream.
 *
 * Impersonates:
 *   POST /v2/{endpointId}/openai/v1/chat/completions
 *
 * Zero runtime dependencies (node:http only). See README.md for the full control
 * surface. Written in TypeScript that runs unmodified under Node's native type
 * stripping (node >= 22.18) and under Deno — no build step, no emitted JS.
 *
 * Every behaviour is controllable per-request via `x-mock-*` headers or
 * `?<snake_case>` query params. Precedence:
 *   header  >  query param  >  setDefaults()  >  built-in default
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

// ─── Public types ────────────────────────────────────────────────────────────

export type UsageMode = "full" | "basic" | "none";
export type UsagePlacement = "auto" | "separate" | "final";
export type FailMode = "none" | "500" | "429" | "404" | "drop" | "hang" | "malformed";

export interface MockOptions {
  /** ms to withhold the first byte (headers included). Default 0. */
  coldStartMs: number;
  /** ms between token frames. Default 0. */
  tokenDelayMs: number;
  /** number of content tokens to emit. Default 8. */
  tokens: number;
  /** full = vLLM (cached_tokens), basic = llama.cpp best case, none = no usage at all. Default "full". */
  usage: UsageMode;
  /**
   * vLLM semantics. When true, a STREAMING response emits usage only if the request
   * body carries `stream_options: { include_usage: true }`; otherwise no usage at all,
   * whatever `usage` says. Default false. Non-streaming responses are unaffected.
   */
  honorIncludeUsage: boolean;
  /** separate = extra chunk with choices:[], final = usage on the finish chunk. Default "auto". */
  usagePlacement: UsagePlacement;
  fail: FailMode;
  /** tokens emitted before fail=drop kills the socket. Default 3. */
  dropAfter: number;
  /** token index before which fail=malformed injects a bad frame. Default 2. */
  malformedAfter: number;
  promptTokens: number;
  cachedTokens: number;
  /** override the emitted token text. Default null (built-in lorem). */
  tokenText: string | null;
  finishReason: string;
  /** override the echoed model name. Default null (echo request body `model`). */
  model: string | null;
  /**
   * Number of tool calls to emit (FR-TOOL-004). Default 0 = none.
   *
   * With this set the stream ends in `finish_reason: "tool_calls"` unless
   * `finishReason` was overridden, because that is what every real worker does
   * and a mock that says "stop" while emitting calls tests the wrong thing.
   */
  toolCalls: number;
  /** Function name for the emitted calls; `_2`, `_3`… are appended after the first. */
  toolName: string;
  /**
   * How many fragments each call's `arguments` string is split into. Default 3.
   * The splits are by CHARACTER COUNT, so they land mid-key and mid-value — the
   * boundaries that break a consumer which concatenates without reassembling.
   */
  toolArgFragments: number;
}

export interface RecordedRequest {
  at: string;
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  endpointId: string | null;
  headers: Record<string, string | string[] | undefined>;
  authorization: string | null;
  rawBody: string;
  body: any;
  bodyParseError: string | null;
  stream: boolean | undefined;
  streamOptions: unknown;
  model: string | undefined;
  messages: unknown;
  /** Forwarded tool parameters, so a test can assert the gateway relayed them. */
  tools: unknown;
  toolChoice: unknown;
  options: MockOptions;
}

export interface MockUpstream {
  /** e.g. "http://127.0.0.1:53211" — use as UPSTREAM_BASE_URL. */
  url: string;
  port: number;
  server: Server;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  lastRequest(): RecordedRequest | undefined;
  reset(): void;
  setDefaults(next?: Partial<MockOptions>): MockOptions;
  getDefaults(): MockOptions;
  close(): Promise<void>;
}

export interface MockUpstreamConfig {
  port?: number;
  host?: string;
  defaults?: Partial<MockOptions>;
  log?: boolean;
}

// ─── Control surface ─────────────────────────────────────────────────────────

export type ControlKind = "int" | "bool" | "enum" | "string";

export interface ControlSpec {
  header: string;
  query: string;
  kind: ControlKind;
  def: string | number | boolean | null;
  values?: readonly string[];
}

/** name -> { header, query, kind, def }. */
export const CONTROLS = {
  coldStartMs: { header: "x-mock-cold-start-ms", query: "cold_start_ms", kind: "int", def: 0 },
  tokenDelayMs: { header: "x-mock-token-delay-ms", query: "token_delay_ms", kind: "int", def: 0 },
  tokens: { header: "x-mock-tokens", query: "tokens", kind: "int", def: 8 },
  usage: {
    header: "x-mock-usage",
    query: "usage",
    kind: "enum",
    def: "full",
    values: ["full", "basic", "none"],
  },
  honorIncludeUsage: {
    header: "x-mock-honor-include-usage",
    query: "honor_include_usage",
    kind: "bool",
    def: false,
  },
  usagePlacement: {
    header: "x-mock-usage-placement",
    query: "usage_placement",
    kind: "enum",
    def: "auto",
    values: ["auto", "separate", "final"],
  },
  fail: {
    header: "x-mock-fail",
    query: "fail",
    kind: "enum",
    def: "none",
    values: ["none", "500", "429", "404", "drop", "hang", "malformed"],
  },
  dropAfter: { header: "x-mock-drop-after", query: "drop_after", kind: "int", def: 3 },
  malformedAfter: {
    header: "x-mock-malformed-after",
    query: "malformed_after",
    kind: "int",
    def: 2,
  },
  promptTokens: { header: "x-mock-prompt-tokens", query: "prompt_tokens", kind: "int", def: 11 },
  cachedTokens: { header: "x-mock-cached-tokens", query: "cached_tokens", kind: "int", def: 0 },
  tokenText: { header: "x-mock-token-text", query: "token_text", kind: "string", def: null },
  finishReason: {
    header: "x-mock-finish-reason",
    query: "finish_reason",
    kind: "string",
    def: "stop",
  },
  model: { header: "x-mock-model", query: "model", kind: "string", def: null },
  toolCalls: { header: "x-mock-tool-calls", query: "tool_calls", kind: "int", def: 0 },
  toolName: {
    header: "x-mock-tool-name",
    query: "tool_name",
    kind: "string",
    def: "get_weather",
  },
  toolArgFragments: {
    header: "x-mock-tool-arg-fragments",
    query: "tool_arg_fragments",
    kind: "int",
    def: 3,
  },
} satisfies Record<keyof MockOptions, ControlSpec>;

export const BUILTIN_DEFAULTS: MockOptions = Object.fromEntries(
  Object.entries(CONTROLS).map(([k, v]) => [k, v.def]),
) as unknown as MockOptions;

const LOREM = [
  "Hello",
  " there",
  "!",
  " This",
  " is",
  " a",
  " mock",
  " token",
  " stream",
  " from",
  " the",
  " fake",
  " RunPod",
  " worker",
  ".",
  " It",
  " keeps",
  " going",
  " until",
  " the",
  " configured",
  " token",
  " budget",
  " runs",
  " out",
  ".",
];

type Coerced = string | number | boolean | undefined;

function coerce(spec: ControlSpec, raw: unknown): Coerced {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).trim();
  if (spec.kind === "bool") {
    if (["1", "true", "yes", "on"].includes(s.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(s.toLowerCase())) return false;
    return undefined;
  }
  if (spec.kind === "int") {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  if (spec.kind === "enum") return spec.values?.includes(s) ? s : undefined;
  return s;
}

/** Resolve the effective options for one request. */
function resolveOptions(
  req: IncomingMessage,
  url: URL,
  defaults: Partial<MockOptions>,
): MockOptions {
  const out: Record<string, Coerced | null> = {};
  for (const [name, spec] of Object.entries(CONTROLS) as [keyof MockOptions, ControlSpec][]) {
    const fromHeader = coerce(spec, req.headers[spec.header]);
    const fromQuery = coerce(spec, url.searchParams.get(spec.query));
    const fromDefaults = coerce(spec, defaults[name]);
    out[name] =
      fromHeader !== undefined
        ? fromHeader
        : fromQuery !== undefined
          ? fromQuery
          : fromDefaults !== undefined
            ? fromDefaults
            : spec.def;
  }
  return out as unknown as MockOptions;
}

function tokenAt(i: number, opts: MockOptions): string {
  if (opts.tokenText) return i === 0 ? opts.tokenText : ` ${opts.tokenText}`;
  return LOREM[i % LOREM.length] as string;
}

/**
 * The arguments JSON for call `i`. A real object, so a consumer that reassembles
 * the fragments correctly ends up with something `JSON.parse`-able and a
 * consumer that drops one does not.
 */
function toolArgsFor(i: number): string {
  return JSON.stringify({ location: `city-${i}`, unit: "celsius", detailed: i % 2 === 0 });
}

function toolNameFor(i: number, opts: MockOptions): string {
  return i === 0 ? opts.toolName : `${opts.toolName}_${i + 1}`;
}

/** Split a string into `n` near-equal slices, by character count. */
function fragment(s: string, n: number): string[] {
  const count = Math.max(1, Math.min(n, s.length));
  const size = Math.ceil(s.length / count);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length > 0 ? out : [""];
}

/** Fully-assembled tool calls, for the non-streaming shape. */
function assembledToolCalls(opts: MockOptions, id: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < opts.toolCalls; i++) {
    out.push({
      id: `call_${id.slice(-8)}_${i}`,
      type: "function",
      function: { name: toolNameFor(i, opts), arguments: toolArgsFor(i) },
    });
  }
  return out;
}

interface UsageObject {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

function usageObject(opts: MockOptions, completionTokens: number): UsageObject | null {
  if (opts.usage === "none") return null;
  const base: UsageObject = {
    prompt_tokens: opts.promptTokens,
    completion_tokens: completionTokens,
    total_tokens: opts.promptTokens + completionTokens,
  };
  if (opts.usage === "full") {
    base.prompt_tokens_details = { cached_tokens: opts.cachedTokens };
    base.completion_tokens_details = { reasoning_tokens: 0 };
  }
  return base;
}

/** "separate" = vLLM (extra chunk with choices:[]). "final" = llama.cpp (on the finish chunk). */
function placementFor(opts: MockOptions): Exclude<UsagePlacement, "auto"> {
  if (opts.usagePlacement !== "auto") return opts.usagePlacement;
  return opts.usage === "full" ? "separate" : "final";
}

interface ErrorBody {
  error: { message: string; type: string; param: null; code: string };
}

function errorBody(status: number): ErrorBody {
  const map: Record<number, [string, string, string]> = {
    500: ["internal server error", "server_error", "internal_error"],
    429: ["rate limit exceeded", "rate_limit_error", "rate_limit_exceeded"],
    404: ["endpoint not found", "invalid_request_error", "not_found"],
    405: ["method not allowed", "invalid_request_error", "method_not_allowed"],
    400: ["invalid request body", "invalid_request_error", "invalid_request"],
  };
  const [message, type, code] = map[status] ?? ["error", "server_error", "error"];
  return { error: { message, type, param: null, code } };
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        return reject(new Error("aborted"));
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    }
  });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the mock upstream. */
export async function startMockUpstream(config: MockUpstreamConfig = {}): Promise<MockUpstream> {
  const { port = 0, host = "127.0.0.1", log = false } = config;
  let defaults: Partial<MockOptions> = { ...BUILTIN_DEFAULTS, ...config.defaults };

  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const shutdown = new AbortController();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const rawBody = await readBody(req).catch(() => "");

    let body: any = null;
    let bodyParseError: string | null = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch (e) {
        bodyParseError = String(e instanceof Error ? e.message : e);
      }
    }

    const m = /^\/v2\/([^/]+)\/openai\/v1\/chat\/completions$/.exec(url.pathname);
    const opts = resolveOptions(req, url, defaults);
    const isObject = body !== null && typeof body === "object";

    const record: RecordedRequest = {
      at: new Date().toISOString(),
      method: req.method ?? "",
      url: req.url ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      endpointId: m?.[1] ? decodeURIComponent(m[1]) : null,
      headers: { ...req.headers },
      authorization: req.headers.authorization ?? null,
      rawBody,
      body,
      bodyParseError,
      stream: isObject ? body.stream : undefined,
      streamOptions: isObject ? body.stream_options : undefined,
      model: isObject ? body.model : undefined,
      messages: isObject ? body.messages : undefined,
      tools: isObject ? body.tools : undefined,
      toolChoice: isObject ? body.tool_choice : undefined,
      options: opts,
    };
    requests.push(record);
    if (log) {
      console.error(
        `[mock-upstream] ${req.method} ${url.pathname} endpoint=${record.endpointId} ` +
          `stream=${record.stream} opts=${JSON.stringify(opts)}`,
      );
    }

    if (req.method !== "POST") return sendJson(res, 405, errorBody(405));
    if (!m) return sendJson(res, 404, errorBody(404));
    if (bodyParseError) return sendJson(res, 400, errorBody(400));

    try {
      await handle(req, res, {
        opts,
        body,
        model: opts.model ?? body?.model ?? "mock-model",
        signal: shutdown.signal,
      });
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === "aborted") {
        try {
          res.destroy();
        } catch {
          /* socket already gone */
        }
        return;
      }
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {
          /* socket already gone */
        }
      } else {
        sendJson(res, 500, errorBody(500));
      }
    }
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    server,
    requests,
    lastRequest: () => requests.at(-1),
    reset() {
      requests.length = 0;
    },
    setDefaults(next: Partial<MockOptions> = {}) {
      defaults = { ...defaults, ...next };
      return { ...defaults } as MockOptions;
    },
    getDefaults: () => ({ ...defaults }) as MockOptions,
    async close() {
      shutdown.abort();
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* socket already gone */
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(payload.length),
  };
  if (status === 429) headers["retry-after"] = "1";
  res.writeHead(status, headers);
  res.end(payload);
}

interface HandleCtx {
  opts: MockOptions;
  body: any;
  model: string;
  signal: AbortSignal;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleCtx): Promise<void> {
  const { opts, body, model, signal } = ctx;

  // ── Immediate HTTP failures: RunPod answers before any cold start work ──
  if (opts.fail === "500" || opts.fail === "429" || opts.fail === "404") {
    const status = Number(opts.fail);
    return sendJson(res, status, errorBody(status));
  }

  // ── Cold start: withhold EVERY byte, including response headers ──
  if (opts.coldStartMs > 0) await sleep(opts.coldStartMs, signal);

  // ── Hang: never write anything, hold the socket open forever ──
  if (opts.fail === "hang") {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      req.on("close", () => reject(new Error("aborted")));
    });
    return;
  }

  // absent => stream (RunPod default is false, but the gateway always sends true)
  const streaming = body?.stream !== false;

  // ── vLLM semantics: a streaming response only carries usage when the caller
  // asked for it. Off by default; when on, a gateway that forgets to inject
  // stream_options.include_usage silently loses usage exactly like production.
  let effectiveOpts = opts;
  if (opts.honorIncludeUsage && streaming && body?.stream_options?.include_usage !== true) {
    effectiveOpts = { ...opts, usage: "none" };
  }
  const id = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // stream_options is a streaming-only field, so non-streaming responses are unaffected.
  if (!streaming) return nonStreaming(res, { opts, id, created, model, signal });
  return streamingResponse(res, { opts: effectiveOpts, id, created, model, signal });
}

interface RenderCtx {
  opts: MockOptions;
  id: string;
  created: number;
  model: string;
  signal: AbortSignal;
}

async function nonStreaming(res: ServerResponse, ctx: RenderCtx): Promise<void> {
  const { opts, id, created, model, signal } = ctx;
  let content = "";
  for (let i = 0; i < opts.tokens; i++) {
    if (opts.tokenDelayMs > 0) await sleep(opts.tokenDelayMs, signal);
    content += tokenAt(i, opts);
  }
  const calls = assembledToolCalls(opts, id);
  const message: Record<string, unknown> = calls.length > 0
    // A real worker sends `content: null` on a tool-only turn.
    ? {
      role: "assistant",
      content: content.length > 0 ? content : null,
      tool_calls: calls,
    }
    : { role: "assistant", content };

  const payload: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReasonFor(opts),
      },
    ],
  };
  const usage = usageObject(opts, completionTokensFor(opts));
  if (usage) payload.usage = usage;
  return sendJson(res, 200, payload);
}

/**
 * Tool calls end a turn with `finish_reason: "tool_calls"`. Derived rather than
 * configured, because "stop" is the control's default and a caller who asks for
 * tool calls is not asking for the wrong finish reason with them.
 */
function finishReasonFor(opts: MockOptions): string {
  if (opts.toolCalls > 0 && opts.finishReason === "stop") return "tool_calls";
  return opts.finishReason;
}

/**
 * FR-TOOL-006: tool tokens are ordinary completion tokens and a real worker
 * counts them inside `usage.completion_tokens`. One token per emitted frame —
 * crude, but it makes the count differ from `tokens`, which is the property a
 * gateway test needs in order to catch a consumer that ignores tool output.
 */
function completionTokensFor(opts: MockOptions): number {
  if (opts.toolCalls <= 0) return opts.tokens;
  let frames = 0;
  for (let i = 0; i < opts.toolCalls; i++) {
    frames += 1 + fragment(toolArgsFor(i), opts.toolArgFragments).length;
  }
  return opts.tokens + frames;
}

async function streamingResponse(res: ServerResponse, ctx: RenderCtx): Promise<void> {
  const { opts, id, created, model, signal } = ctx;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  const frame = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const flushed = () => new Promise<void>((resolve) => res.write("", () => resolve()));
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices,
    ...extra,
  });

  // role-priming chunk (vLLM & llama.cpp both emit one)
  frame(
    chunk([
      { index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null },
    ]),
  );

  for (let i = 0; i < opts.tokens; i++) {
    if (opts.tokenDelayMs > 0) await sleep(opts.tokenDelayMs, signal);

    if (opts.fail === "drop" && i >= opts.dropAfter) {
      // Make sure everything written so far actually reaches the wire, then
      // yank the socket: the client sees N good tokens and then a truncated
      // stream with no [DONE].
      await flushed();
      await sleep(20, signal);
      res.destroy();
      return;
    }
    if (opts.fail === "malformed" && i === opts.malformedAfter) {
      // truncated JSON payload — a valid SSE frame carrying invalid JSON
      res.write(
        `data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"\n\n`,
      );
    }

    frame(
      chunk([
        { index: 0, delta: { content: tokenAt(i, opts) }, logprobs: null, finish_reason: null },
      ]),
    );
  }

  // ── tool calls, as INCREMENTAL fragments (FR-TOOL-004) ───────────────────
  // The opening frame of a call carries `id`, `type` and `function.name` with an
  // EMPTY arguments string; every frame after it carries only a fragment of
  // `function.arguments`, keyed by the same `index`. Calls are emitted one after
  // another rather than interleaved, which is what llama.cpp does.
  for (let i = 0; i < opts.toolCalls; i++) {
    if (opts.tokenDelayMs > 0) await sleep(opts.tokenDelayMs, signal);
    frame(
      chunk([{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            id: `call_${id.slice(-8)}_${i}`,
            type: "function",
            function: { name: toolNameFor(i, opts), arguments: "" },
          }],
        },
        logprobs: null,
        finish_reason: null,
      }]),
    );
    for (const piece of fragment(toolArgsFor(i), opts.toolArgFragments)) {
      if (opts.tokenDelayMs > 0) await sleep(opts.tokenDelayMs, signal);
      frame(
        chunk([{
          index: 0,
          delta: { tool_calls: [{ index: i, function: { arguments: piece } }] },
          logprobs: null,
          finish_reason: null,
        }]),
      );
    }
  }

  const usage = usageObject(opts, completionTokensFor(opts));
  const placement = placementFor(opts);

  const finishChunk = chunk(
    [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReasonFor(opts) }],
    usage && placement === "final" ? { usage } : {},
  );
  frame(finishChunk);

  if (usage && placement === "separate") frame(chunk([], { usage }));

  res.write("data: [DONE]\n\n");
  res.end();
}

export default startMockUpstream;
