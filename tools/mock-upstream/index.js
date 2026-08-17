/**
 * Mock RunPod OpenAI-compatible serverless upstream.
 *
 * Impersonates:
 *   POST /v2/{endpointId}/openai/v1/chat/completions
 *
 * Zero dependencies (node:http only). See README.md for the full control surface.
 *
 * Every behaviour is controllable per-request via `x-mock-*` headers or
 * `?<snake_case>` query params. Precedence:
 *   header  >  query param  >  setDefaults()  >  built-in default
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

// ─── Control surface ─────────────────────────────────────────────────────────
// name -> { header, query, kind, default }
const CONTROLS = {
  coldStartMs: { header: "x-mock-cold-start-ms", query: "cold_start_ms", kind: "int", def: 0 },
  tokenDelayMs: { header: "x-mock-token-delay-ms", query: "token_delay_ms", kind: "int", def: 0 },
  tokens: { header: "x-mock-tokens", query: "tokens", kind: "int", def: 8 },
  usage: { header: "x-mock-usage", query: "usage", kind: "enum", def: "full", values: ["full", "basic", "none"] },
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
  malformedAfter: { header: "x-mock-malformed-after", query: "malformed_after", kind: "int", def: 2 },
  promptTokens: { header: "x-mock-prompt-tokens", query: "prompt_tokens", kind: "int", def: 11 },
  cachedTokens: { header: "x-mock-cached-tokens", query: "cached_tokens", kind: "int", def: 0 },
  tokenText: { header: "x-mock-token-text", query: "token_text", kind: "string", def: null },
  finishReason: { header: "x-mock-finish-reason", query: "finish_reason", kind: "string", def: "stop" },
  model: { header: "x-mock-model", query: "model", kind: "string", def: null },
};

const BUILTIN_DEFAULTS = Object.fromEntries(
  Object.entries(CONTROLS).map(([k, v]) => [k, v.def]),
);

const LOREM = [
  "Hello", " there", "!", " This", " is", " a", " mock", " token", " stream",
  " from", " the", " fake", " RunPod", " worker", ".", " It", " keeps", " going",
  " until", " the", " configured", " token", " budget", " runs", " out", ".",
];

function coerce(spec, raw) {
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
  if (spec.kind === "enum") return spec.values.includes(s) ? s : undefined;
  return s;
}

/** Resolve the effective options for one request. */
function resolveOptions(req, url, defaults) {
  const out = {};
  for (const [name, spec] of Object.entries(CONTROLS)) {
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
  return out;
}

function tokenAt(i, opts) {
  if (opts.tokenText) return i === 0 ? opts.tokenText : ` ${opts.tokenText}`;
  return LOREM[i % LOREM.length];
}

function usageObject(opts, completionTokens) {
  if (opts.usage === "none") return null;
  const base = {
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
function placementFor(opts) {
  if (opts.usagePlacement !== "auto") return opts.usagePlacement;
  return opts.usage === "full" ? "separate" : "final";
}

function errorBody(status) {
  const map = {
    500: ["internal server error", "server_error", "internal_error"],
    429: ["rate limit exceeded", "rate_limit_error", "rate_limit_exceeded"],
    404: ["endpoint not found", "invalid_request_error", "not_found"],
    405: ["method not allowed", "invalid_request_error", "method_not_allowed"],
    400: ["invalid request body", "invalid_request_error", "invalid_request"],
  };
  const [message, type, code] = map[status] ?? ["error", "server_error", "error"];
  return { error: { message, type, param: null, code } };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the mock upstream.
 * @param {{port?: number, host?: string, defaults?: object, log?: boolean}} [config]
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>,
 *   setDefaults:(d:object)=>object, requests:Array, reset:()=>void, lastRequest:()=>any, server:import('node:http').Server}>}
 */
export async function startMockUpstream(config = {}) {
  const { port = 0, host = "127.0.0.1", log = false } = config;
  let defaults = { ...BUILTIN_DEFAULTS, ...(config.defaults ?? {}) };

  /** @type {Array<any>} */
  const requests = [];
  const sockets = new Set();
  const shutdown = new AbortController();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const rawBody = await readBody(req).catch(() => "");

    let body = null;
    let bodyParseError = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch (e) {
        bodyParseError = String(e && e.message);
      }
    }

    const m = url.pathname.match(/^\/v2\/([^/]+)\/openai\/v1\/chat\/completions$/);
    const opts = resolveOptions(req, url, defaults);

    const record = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      endpointId: m ? decodeURIComponent(m[1]) : null,
      headers: { ...req.headers },
      authorization: req.headers.authorization ?? null,
      rawBody,
      body,
      bodyParseError,
      stream: body && typeof body === "object" ? body.stream : undefined,
      streamOptions: body && typeof body === "object" ? body.stream_options : undefined,
      model: body && typeof body === "object" ? body.model : undefined,
      messages: body && typeof body === "object" ? body.messages : undefined,
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
      await handle(req, res, { opts, body, model: opts.model ?? body?.model ?? "mock-model", signal: shutdown.signal });
    } catch (err) {
      if (String(err && err.message) === "aborted") {
        try { res.destroy(); } catch {}
        return;
      }
      if (!res.headersSent) sendJson(res, 500, errorBody(500));
      else try { res.destroy(); } catch {}
    }
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    server,
    requests,
    lastRequest: () => requests[requests.length - 1],
    reset() {
      requests.length = 0;
    },
    setDefaults(next = {}) {
      defaults = { ...defaults, ...next };
      return { ...defaults };
    },
    getDefaults: () => ({ ...defaults }),
    async close() {
      shutdown.abort();
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendJson(res, status, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const headers = {
    "content-type": "application/json",
    "content-length": String(payload.length),
  };
  if (status === 429) headers["retry-after"] = "1";
  res.writeHead(status, headers);
  res.end(payload);
}

async function handle(req, res, ctx) {
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
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      req.on("close", () => reject(new Error("aborted")));
    });
    return;
  }

  const streaming = body?.stream !== false; // absent => stream (RunPod default is false, but the gateway always sends true)

  // ── vLLM semantics: a streaming response only carries usage when the caller
  // asked for it. Off by default; when on, a gateway that forgets to inject
  // stream_options.include_usage silently loses usage exactly like production.
  let effectiveOpts = opts;
  if (opts.honorIncludeUsage && streaming && body?.stream_options?.include_usage !== true) {
    effectiveOpts = { ...opts, usage: "none" };
  }
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // stream_options is a streaming-only field, so non-streaming responses are unaffected.
  if (!streaming) return nonStreaming(res, { opts, id, created, model, signal });
  return streamingResponse(res, { opts: effectiveOpts, id, created, model, signal });
}

async function nonStreaming(res, { opts, id, created, model, signal }) {
  let content = "";
  for (let i = 0; i < opts.tokens; i++) {
    if (opts.tokenDelayMs > 0) await sleep(opts.tokenDelayMs, signal);
    content += tokenAt(i, opts);
  }
  const payload = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        logprobs: null,
        finish_reason: opts.finishReason,
      },
    ],
  };
  const usage = usageObject(opts, opts.tokens);
  if (usage) payload.usage = usage;
  return sendJson(res, 200, payload);
}

async function streamingResponse(res, { opts, id, created, model, signal }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const flushed = () => new Promise((resolve) => res.write("", resolve));
  const chunk = (choices, extra = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices,
    ...extra,
  });

  // role-priming chunk (vLLM & llama.cpp both emit one)
  frame(chunk([{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }]));

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
      res.write(`data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"\n\n`);
    }

    frame(chunk([{ index: 0, delta: { content: tokenAt(i, opts) }, logprobs: null, finish_reason: null }]));
  }

  const usage = usageObject(opts, opts.tokens);
  const placement = placementFor(opts);

  const finishChunk = chunk(
    [{ index: 0, delta: {}, logprobs: null, finish_reason: opts.finishReason }],
    usage && placement === "final" ? { usage } : {},
  );
  frame(finishChunk);

  if (usage && placement === "separate") frame(chunk([], { usage }));

  res.write("data: [DONE]\n\n");
  res.end();
}

export { CONTROLS, BUILTIN_DEFAULTS };
export default startMockUpstream;
