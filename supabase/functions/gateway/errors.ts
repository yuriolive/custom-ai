/**
 * OpenAI-shaped error envelopes + upstream error mapping/sanitization.
 * See docs/CONTRACTS.md "Gateway wire contract" and PRD FR-GW-003, 033, 034.
 *
 * No imports beyond the shared type module (FR-GW-051: nothing heavy on the hot path).
 */

import type {
  GatewayErrorCode,
  OpenAIErrorEnvelope,
} from "../../../packages/shared/types.ts";

export const REQUEST_ID_HEADER = "x-nexus-request-id";
export const BALANCE_HEADER = "x-nexus-balance-micro-usd";

/**
 * The single source of truth for HTTP status + OpenAI `error.type` per code.
 * `type` values are OpenAI's own strings so SDK error-class mapping still works.
 */
const CODE_TABLE: Record<GatewayErrorCode, { status: number; type: string }> = {
  invalid_model_format: { status: 400, type: "invalid_request_error" },
  unsupported_parameter: { status: 400, type: "invalid_request_error" },
  invalid_api_key: { status: 401, type: "invalid_request_error" },
  revoked_api_key: { status: 401, type: "invalid_request_error" },
  insufficient_balance: { status: 402, type: "insufficient_quota" },
  account_suspended: { status: 403, type: "invalid_request_error" },
  model_not_found: { status: 404, type: "invalid_request_error" },
  rate_limit_exceeded: { status: 429, type: "rate_limit_error" },
  internal_error: { status: 500, type: "api_error" },
  not_implemented: { status: 501, type: "invalid_request_error" },
  model_unavailable: { status: 503, type: "api_error" },
  cold_start_timeout: { status: 504, type: "api_error" },
  stream_timeout: { status: 504, type: "api_error" },
};

export function statusForCode(code: GatewayErrorCode): number {
  return CODE_TABLE[code]?.status ?? 500;
}

export function typeForCode(code: GatewayErrorCode): string {
  return CODE_TABLE[code]?.type ?? "api_error";
}

export function errorEnvelope(
  code: GatewayErrorCode,
  message: string,
  param: string | null = null,
): OpenAIErrorEnvelope {
  return { error: { message, type: typeForCode(code), param, code } };
}

/**
 * A thrown gateway failure. Carries everything needed to render the response,
 * so the pipeline can `throw` at any depth and the top-level handler renders it.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly param: string | null;
  readonly status: number;
  readonly extraHeaders: Record<string, string>;

  constructor(
    code: GatewayErrorCode,
    message: string,
    opts: {
      param?: string | null;
      status?: number;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.param = opts.param ?? null;
    this.status = opts.status ?? statusForCode(code);
    this.extraHeaders = opts.headers ?? {};
  }

  toEnvelope(): OpenAIErrorEnvelope {
    return errorEnvelope(this.code, this.message, this.param);
  }
}

/** CORS for browser-direct calls (PRD §4.2.1: POST, GET, OPTIONS). */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-nexus-request-id",
  "access-control-expose-headers":
    "x-nexus-request-id, x-nexus-balance-micro-usd, x-nexus-cold-start, x-nexus-ttft-ms, retry-after",
  "access-control-max-age": "86400",
};

/** Renders any error as an OpenAI envelope. `x-nexus-request-id` is always set (FR-GW-005). */
export function errorResponse(
  err: unknown,
  requestId: string,
  extra?: Record<string, string>,
): Response {
  const ge = err instanceof GatewayError
    ? err
    : new GatewayError(
      "internal_error",
      "The server encountered an internal error. Please retry.",
    );

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
    ...CORS_HEADERS,
    ...ge.extraHeaders,
    ...(extra ?? {}),
  };

  return new Response(JSON.stringify(ge.toEnvelope()), {
    status: ge.status,
    headers,
  });
}

// ─── Upstream sanitization (FR-GW-034) ───────────────────────────────────────

/**
 * Scrubs anything that could identify our infrastructure out of a text blob.
 * Applied to upstream bodies BEFORE they are used in a message or a log line.
 *
 * Removed: URLs, RunPod endpoint ids (`/v2/{id}/`), bare hostnames, IPv4
 * literals, filesystem paths, and stack frames.
 */
export function sanitizeUpstreamText(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).slice(0, 4096);

  // RunPod endpoint ids, in path form and as bare tokens after known keys.
  s = s.replace(/\/v2\/[A-Za-z0-9_-]{4,}\b/g, "/v2/[redacted]");
  s = s.replace(
    /\b(endpoint[_-]?id|endpointId|pod[_-]?id|worker[_-]?id)\b\s*[:=]\s*"?[A-Za-z0-9_-]{4,}"?/gi,
    "$1: [redacted]",
  );
  // Absolute URLs and bare hostnames.
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[redacted-url]");
  s = s.replace(
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:runpod|internal|local|svc|cluster|amazonaws|supabase)\b[^\s"'<>)]*/gi,
    "[redacted-host]",
  );
  // IPv4 literals.
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted-ip]");
  // Stack frames and filesystem paths.
  s = s.replace(/^\s*(?:at\s+|File\s+").*$/gim, "");
  s = s.replace(/(?:\/[\w.@-]+){2,}\.(?:py|ts|js|rs|c|cc|cpp|so)\b(?::\d+)?/g, "[redacted-path]");
  s = s.replace(/[A-Za-z]:\\[^\s"'<>)]+/g, "[redacted-path]");
  s = s.replace(/\bTraceback \(most recent call last\):/gi, "");

  return s.replace(/\s+/g, " ").trim().slice(0, 500);
}

const OOM_PATTERN =
  /out of memory|outofmemory|\boom\b|cuda error: out of memory|failed to allocate|cannot allocate memory|ggml_backend_.*alloc.*failed|killed process .* score/i;

export function looksLikeOom(bodyText: string | null | undefined): boolean {
  return !!bodyText && OOM_PATTERN.test(bodyText);
}

export interface UpstreamFailure {
  error: GatewayError;
  /** True when the model should be flagged for creator attention (FR-GW-033, OOM). */
  flagModel: boolean;
  /** Sanitized upstream detail — safe for our structured logs, never for the client. */
  logDetail: string;
}

/**
 * Maps an upstream (RunPod / worker) HTTP failure onto a client-safe gateway error.
 *
 * FR-GW-033:
 *   401/403 -> 500 internal   (platform credential fault; never the caller's fault)
 *   404     -> 503 model_unavailable
 *   429     -> 429 + Retry-After
 *   OOM     -> 500 + "hardware tier too small" hint, model flagged
 */
export function mapUpstreamError(
  status: number,
  bodyText?: string | null,
  responseHeaders?: Headers | Record<string, string> | null,
): UpstreamFailure {
  const logDetail = sanitizeUpstreamText(bodyText);

  // OOM is detected from the body regardless of the status the worker chose.
  if (looksLikeOom(bodyText)) {
    return {
      error: new GatewayError(
        "internal_error",
        "The model failed to run: the hardware tier selected for this model is too " +
          "small for the requested context length. The model owner has been notified.",
      ),
      flagModel: true,
      logDetail,
    };
  }

  if (status === 401 || status === 403) {
    // Our credential, not theirs. Leak nothing.
    return {
      error: new GatewayError(
        "internal_error",
        "The server encountered an internal error. Please retry.",
      ),
      flagModel: false,
      logDetail,
    };
  }

  if (status === 404) {
    return {
      error: new GatewayError(
        "model_unavailable",
        "The model is not currently available. Please try again shortly.",
      ),
      flagModel: false,
      logDetail,
    };
  }

  if (status === 429) {
    const retryAfter = readHeader(responseHeaders, "retry-after") ?? "1";
    return {
      error: new GatewayError(
        "rate_limit_exceeded",
        "Rate limit reached for this model. Please retry after a short delay.",
        { headers: { "retry-after": retryAfter } },
      ),
      flagModel: false,
      logDetail,
    };
  }

  if (status === 408 || status === 504) {
    return {
      error: new GatewayError(
        "cold_start_timeout",
        "The model worker did not respond within the cold-start budget.",
      ),
      flagModel: false,
      logDetail,
    };
  }

  if (status >= 500) {
    return {
      error: new GatewayError(
        "model_unavailable",
        "The model worker returned an error. Please try again shortly.",
      ),
      flagModel: false,
      logDetail,
    };
  }

  return {
    error: new GatewayError(
      "internal_error",
      "The server encountered an internal error. Please retry.",
    ),
    flagModel: false,
    logDetail,
  };
}

function readHeader(
  h: Headers | Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const rec = h as Record<string, string>;
  const hit = Object.keys(rec).find((k) => k.toLowerCase() === name);
  return hit ? rec[hit] : null;
}

/** A terminating SSE error frame, for failures after headers have flushed (FR-GW-047). */
export function sseErrorFrame(code: GatewayErrorCode, message: string): string {
  return `data: ${JSON.stringify(errorEnvelope(code, message))}\n\ndata: [DONE]\n\n`;
}
