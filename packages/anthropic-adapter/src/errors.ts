/**
 * Error translation, both directions, plus the typed error this library throws
 * for requests it refuses to translate.
 */

import type {
  AnthropicErrorResponse,
  AnthropicErrorType,
  OpenAIErrorResponse,
} from "./types.ts";

/** HTTP status Anthropic uses for each error type. */
const STATUS_FOR_TYPE: Record<AnthropicErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  timeout_error: 504,
  api_error: 500,
  overloaded_error: 529,
};

export function statusForAnthropicErrorType(type: AnthropicErrorType): number {
  return STATUS_FOR_TYPE[type] ?? 500;
}

/**
 * Thrown when an Anthropic request cannot be represented as an OpenAI request.
 * Carries a ready-to-serialize Anthropic error envelope and its HTTP status so
 * the gateway can respond without re-deriving either.
 */
export class AnthropicAdapterError extends Error {
  readonly anthropicType: AnthropicErrorType;
  readonly status: number;

  constructor(anthropicType: AnthropicErrorType, message: string) {
    super(message);
    this.name = "AnthropicAdapterError";
    this.anthropicType = anthropicType;
    this.status = statusForAnthropicErrorType(anthropicType);
  }

  toResponseBody(): AnthropicErrorResponse {
    return { type: "error", error: { type: this.anthropicType, message: this.message } };
  }
}

/**
 * OpenAI error `type` strings we have seen in the wild, mapped to Anthropic types.
 * OpenAI-compatible servers are inconsistent here, so `code` and the HTTP status
 * are both consulted as fallbacks.
 */
const TYPE_MAP: Record<string, AnthropicErrorType> = {
  invalid_request_error: "invalid_request_error",
  invalid_api_key: "authentication_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  permission_denied_error: "permission_error",
  insufficient_quota: "billing_error",
  not_found_error: "not_found_error",
  rate_limit_error: "rate_limit_error",
  rate_limit_exceeded: "rate_limit_error",
  requests: "rate_limit_error",
  tokens: "rate_limit_error",
  server_error: "api_error",
  api_error: "api_error",
  internal_server_error: "api_error",
  overloaded_error: "overloaded_error",
  service_unavailable: "overloaded_error",
  timeout: "timeout_error",
  timeout_error: "timeout_error",
};

/**
 * Gateway `code` values from docs/CONTRACTS.md plus the common OpenAI ones.
 * Consulted when `type` is missing or unrecognized.
 */
const CODE_MAP: Record<string, AnthropicErrorType> = {
  invalid_model_format: "invalid_request_error",
  invalid_api_key: "authentication_error",
  revoked_api_key: "authentication_error",
  insufficient_balance: "billing_error",
  insufficient_quota: "billing_error",
  model_not_found: "not_found_error",
  model_unavailable: "overloaded_error",
  cold_start_timeout: "timeout_error",
  stream_timeout: "timeout_error",
  context_length_exceeded: "invalid_request_error",
  rate_limit_exceeded: "rate_limit_error",
  string_above_max_length: "invalid_request_error",
};

const STATUS_MAP: Record<number, AnthropicErrorType> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  408: "timeout_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  504: "timeout_error",
  529: "overloaded_error",
};

/**
 * OpenAI `{error:{message,type,param,code}}` -> Anthropic `{type:"error",error:{type,message}}`.
 *
 * Precedence: explicit `type`, then `code`, then HTTP status, then `api_error`.
 * `param` and `code` have no Anthropic home, so they are appended to the message
 * rather than dropped — losing "which field was invalid" makes 400s undebuggable.
 */
export function translateError(
  body: OpenAIErrorResponse | unknown,
  httpStatus?: number,
): { status: number; body: AnthropicErrorResponse } {
  const err =
    typeof body === "object" && body !== null && "error" in body
      ? ((body as OpenAIErrorResponse).error ?? {})
      : {};

  const rawType = typeof err.type === "string" ? err.type : undefined;
  const rawCode = typeof err.code === "string" ? err.code : undefined;

  const type: AnthropicErrorType =
    (rawType ? TYPE_MAP[rawType] : undefined) ??
    (rawCode ? CODE_MAP[rawCode] : undefined) ??
    (httpStatus !== undefined ? STATUS_MAP[httpStatus] : undefined) ??
    "api_error";

  let message =
    typeof err.message === "string" && err.message.length > 0
      ? err.message
      : "Upstream returned an error with no message.";

  const notes: string[] = [];
  if (rawCode) notes.push(`code=${rawCode}`);
  if (typeof err.param === "string" && err.param.length > 0) notes.push(`param=${err.param}`);
  if (notes.length > 0) message = `${message} (${notes.join(", ")})`;

  return {
    status: httpStatus ?? statusForAnthropicErrorType(type),
    body: { type: "error", error: { type, message } },
  };
}

/**
 * Anthropic error envelope -> OpenAI error envelope. Used when something on the
 * Anthropic-facing side must be reported to an OpenAI-shaped client.
 */
export function toOpenAIError(body: AnthropicErrorResponse): OpenAIErrorResponse {
  const reverse: Record<AnthropicErrorType, string> = {
    invalid_request_error: "invalid_request_error",
    authentication_error: "invalid_request_error",
    billing_error: "insufficient_quota",
    permission_error: "invalid_request_error",
    not_found_error: "invalid_request_error",
    request_too_large: "invalid_request_error",
    rate_limit_error: "rate_limit_error",
    timeout_error: "server_error",
    api_error: "server_error",
    overloaded_error: "server_error",
  };
  return {
    error: {
      message: body.error.message,
      type: reverse[body.error.type] ?? "server_error",
      param: null,
      code: body.error.type,
    },
  };
}
