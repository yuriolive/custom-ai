/**
 * Anthropic Messages API surface for the gateway (PRD §4.6, FR-ANTH-001…015).
 *
 * `packages/anthropic-adapter` does the wire translation and knows nothing about
 * this gateway. This file is the glue that the adapter's README lists as the
 * gateway's job: auth-header dialect, model-name policy, SSE re-framing over the
 * already-proxied upstream stream, the Anthropic error envelope, and the
 * `count_tokens` estimator that has no OpenAI equivalent.
 *
 * The inference pipeline itself lives in `index.ts` and is shared byte-for-byte
 * with `/v1/chat/completions` (FR-ANTH-002). Nothing here touches billing.
 *
 * OWNERSHIP: this file, alongside index.ts / auth.ts / resolve.ts / errors.ts.
 */

import {
  anthropicErrorEvent,
  AnthropicAdapterError,
  AnthropicStreamTranslator,
  createSseDecoder,
  formatSseEvent,
  isDoneSentinel,
  translateError,
  translateResponse,
} from "../../../packages/anthropic-adapter/src/index.ts";
import type {
  AnthropicErrorType,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicStreamEvent,
  OpenAIChatResponse,
  OpenAIStreamChunk,
} from "../../../packages/anthropic-adapter/src/types.ts";
import { CORS_HEADERS, GatewayError, REQUEST_ID_HEADER } from "./errors.ts";

/** Anthropic's own dated version header. Claude Code sends `2023-06-01`. */
export const ANTHROPIC_VERSION_HEADER = "anthropic-version";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/**
 * True when the caller is speaking Anthropic rather than OpenAI. Only consulted
 * on `/v1/models`, which both dialects share under the same path but return in
 * incompatible shapes: `{object:"list",data:[{object:"model",created}]}` vs
 * `{data:[{type:"model",created_at}],has_more}`.
 */
export function isAnthropicClient(req: Request): boolean {
  return req.headers.has("x-api-key") || req.headers.has(ANTHROPIC_VERSION_HEADER);
}

// ─── Model-name policy (FR-ANTH-002) ─────────────────────────────────────────

/**
 * Parses `ANTHROPIC_MODEL_MAP`: a JSON object of Anthropic model name -> platform
 * `creator/slug`. Invalid JSON yields an EMPTY map rather than a throw — a typo in
 * one env var must not take the whole gateway down, and the unmapped path already
 * returns a 404 that names the model.
 */
export function parseModelMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.includes("/")) out[k.trim().toLowerCase()] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Anthropic model name -> platform model id.
 *
 * Claude Code sends `claude-opus-4-…` for its main loop and a small `…haiku…`
 * model for background tasks, and neither exists here. Resolution order:
 *
 *   1. a name that is already `creator/slug` passes through untouched;
 *   2. an exact (case-insensitive) key in `ANTHROPIC_MODEL_MAP`;
 *   3. the LONGEST map key that is a substring of the name, so one `"haiku"`
 *      entry covers every dated haiku snapshot without listing them;
 *   4. `ANTHROPIC_DEFAULT_MODEL`.
 *
 * With none of those it is a 404 that names what was asked for. Silently
 * substituting a default model would bill a caller for inference on a model they
 * did not ask for.
 */
export function mapAnthropicModel(
  model: unknown,
  map: Record<string, string>,
  fallback: string | undefined,
): string {
  const raw = typeof model === "string" ? model.trim() : "";
  if (raw === "") {
    throw new GatewayError(
      "invalid_model_format",
      "You must provide a 'model'.",
      { param: "model" },
    );
  }
  if (raw.includes("/")) return raw;

  const lower = raw.toLowerCase();
  const exact = map[lower];
  if (exact) return exact;

  let bestKey = "";
  let bestValue = "";
  for (const [key, value] of Object.entries(map)) {
    if (key.length > bestKey.length && lower.includes(key)) {
      bestKey = key;
      bestValue = value;
    }
  }
  if (bestValue !== "") return bestValue;

  if (fallback && fallback.includes("/")) return fallback;

  throw new GatewayError(
    "model_not_found",
    `Unknown model '${raw}'. Address a model as 'creator-handle/model-slug', or ask ` +
      `the operator to map this name in ANTHROPIC_MODEL_MAP.`,
    { param: "model" },
  );
}

// ─── Responses ───────────────────────────────────────────────────────────────

function anthropicHeaders(requestId: string, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
    // The Anthropic SDKs surface `request-id` on every error they raise; without
    // it a user reporting a failure has no id to give us.
    "request-id": requestId,
    [ANTHROPIC_VERSION_HEADER]: DEFAULT_ANTHROPIC_VERSION,
    ...CORS_HEADERS,
    ...extra,
  };
}

export function anthropicJsonResponse(
  body: unknown,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: anthropicHeaders(requestId, extra),
  });
}

/**
 * Maps one gateway-originated error envelope.
 *
 * The adapter's precedence is `type`, then `code`, then HTTP status — correct for
 * a third-party OpenAI server, wrong for OUR envelopes: this gateway's `type` is
 * the coarse OpenAI bucket (`api_error`) while its `code` is the precise cause
 * (`model_unavailable`). Passing both makes every 503 land on `api_error/500`
 * instead of `overloaded_error/529`, and every 404/401 on a flat 400. So the
 * `type` is dropped whenever a `code` is present, and the gateway's own status is
 * only consulted when the code maps to nothing.
 */
function translateGatewayEnvelope(
  error: { message?: string; type?: string; param?: string | null; code?: string },
  gatewayStatus?: number,
): { status: number; body: { type: "error"; error: { type: string; message: string } } } {
  const hasCode = typeof error.code === "string" && error.code !== "";
  const payload = {
    error: hasCode ? { ...error, type: undefined } : error,
  };

  const first = translateError(payload);
  if (first.body.error.type !== "api_error" || gatewayStatus === undefined) return first;
  // Unmapped code: let the HTTP status speak rather than reporting api_error/500.
  return translateError(payload, gatewayStatus);
}

/**
 * Renders any thrown failure as `{type:"error",error:{type,message}}`.
 *
 * The status comes from the ANTHROPIC type, not from the gateway's OpenAI status:
 * `model_unavailable` is a 503 to an OpenAI client and a **529 overloaded_error**
 * to an Anthropic one (FR-ANTH-013), and SDK retry policy keys off exactly that.
 */
export function anthropicErrorResponse(err: unknown, requestId: string): Response {
  if (err instanceof AnthropicAdapterError) {
    return new Response(JSON.stringify(err.toResponseBody()), {
      status: err.status,
      headers: anthropicHeaders(requestId),
    });
  }

  const ge = err instanceof GatewayError
    ? err
    : new GatewayError("internal_error", "The server encountered an internal error. Please retry.");

  const translated = translateGatewayEnvelope(ge.toEnvelope().error, ge.status);
  return new Response(JSON.stringify(translated.body), {
    status: translated.status,
    headers: anthropicHeaders(requestId, ge.extraHeaders),
  });
}

/** The assembled-completion shape `index.ts` recovers from a buffered stream. */
export interface AssembledForAnthropic {
  content: string;
  reasoningContent: string;
  /** `type` is widened to `string` because that is what the assembler produces:
   * it echoes whatever the worker sent and defaults to "function". */
  toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  finishReason: string | null;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
  created: number;
}

/**
 * Non-streaming `/v1/messages` (FR-ANTH-015): the gateway always streams upstream,
 * so the message is rebuilt from the assembled completion rather than from a
 * native non-streaming response the upstream never produced.
 */
export function anthropicMessageFrom(
  assembled: AssembledForAnthropic,
  opts: { model: string; messageId: string; stopSequences?: string[]; inputTokens: number },
): AnthropicMessage {
  const response: OpenAIChatResponse = {
    id: opts.messageId,
    model: opts.model,
    created: assembled.created,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: assembled.content,
          reasoning_content: assembled.reasoningContent === ""
            ? null
            : assembled.reasoningContent,
          tool_calls: assembled.toolCalls.length > 0
            ? assembled.toolCalls.map((c) => ({ ...c, type: "function" as const }))
            : undefined,
        },
        finish_reason: (assembled.finishReason ??
          (assembled.toolCalls.length > 0 ? "tool_calls" : "stop")) as never,
        stop_reason: assembled.stopReason,
      },
    ],
    usage: assembled.usage as OpenAIChatResponse["usage"],
  };

  const { message } = translateResponse(response, {
    model: opts.model,
    messageId: opts.messageId,
    stopSequences: opts.stopSequences,
  });

  // Upstream reported nothing at all (llama.cpp builds without usage): fall back
  // to the same estimate that sized the authorization hold, so a client that
  // budgets on `usage` is not told the turn was free.
  if (message.usage.input_tokens === 0 && opts.inputTokens > 0) {
    message.usage.input_tokens = opts.inputTokens;
  }
  return message;
}

// ─── Streaming re-framing (FR-ANTH-015) ──────────────────────────────────────

const encoder = new TextEncoder();
const decoderFactory = () => new TextDecoder();

export interface AnthropicSseOptions {
  messageId: string;
  model: string;
  stopSequences?: string[];
  /** Prompt-token estimate, reported in `message_start` (README deviation 1). */
  inputTokens?: number;
}

/**
 * Re-frames the gateway's already-proxied OpenAI SSE body into Anthropic events.
 *
 * This runs DOWNSTREAM of `proxyStream`, which is what makes contract rule 3
 * survivable here: the verbatim-forwarding tee, the keepalive timer, the
 * timeouts, the disconnect handling and the usage accumulator all still run on
 * the OpenAI bytes exactly as they do for `/v1/chat/completions`. Only the client
 * -facing framing changes, so settlement is unaffected and is never derived from
 * the translator.
 *
 * Two frames that are not chunks must survive the transform:
 *   - `: keepalive` comments, forwarded as-is (SSE comments are legal in the
 *     Anthropic stream too, and dropping them re-opens the cold-start timeout
 *     that the keepalive exists to prevent);
 *   - a terminating `data: {"error":…}` frame, which becomes an Anthropic
 *     `event: error` — the only way a post-headers failure can reach the client.
 */
function emit(events: AnthropicStreamEvent[], out: string[]): void {
  for (const event of events) out.push(formatSseEvent(event));
}

export function toAnthropicSse(sse: Response, opts: AnthropicSseOptions): Response {
  const translator = new AnthropicStreamTranslator({
    messageId: opts.messageId,
    model: opts.model,
    stopSequences: opts.stopSequences,
    inputTokens: opts.inputTokens ?? 0,
  });
  const decoder = createSseDecoder();

  let ended = false;
  const finish = (out: string[]): void => {
    if (ended) return;
    ended = true;
    emit(translator.finish(), out);
  };

  const handlePayloads = (payloads: string[], out: string[]): void => {
    for (const payload of payloads) {
      if (ended) return;
      if (isDoneSentinel(payload)) {
        finish(out);
        continue;
      }
      let chunk: OpenAIStreamChunk & { error?: { message?: string; code?: string } };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // Never let one malformed frame kill a billable stream.
      }
      if (chunk.error) {
        // Rendered by errors.ts / stream.ts as an OpenAI envelope; map it, then stop.
        const mapped = translateGatewayEnvelope(chunk.error);
        emit([
          anthropicErrorEvent(
            mapped.body.error.type as AnthropicErrorType,
            mapped.body.error.message,
          ),
        ], out);
        ended = true;
        return;
      }
      emit(translator.push(chunk), out);
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = sse.body?.getReader();
      const textDecoder = decoderFactory();
      const push = (out: string[]) => {
        for (const frame of out) controller.enqueue(encoder.encode(frame));
      };

      try {
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = textDecoder.decode(value, { stream: true });
            const out: string[] = [];
            // Comment frames carry no `data:` line, so the decoder drops them;
            // forward them separately to keep the socket warm during cold start.
            for (const line of text.split("\n")) {
              if (line.startsWith(":")) out.push(`${line}\n\n`);
            }
            handlePayloads(decoder.push(text), out);
            push(out);
          }
        }
        const tail: string[] = [];
        handlePayloads(decoder.flush(), tail);
        finish(tail);
        push(tail);
      } catch (err) {
        const message = err instanceof Error ? err.message : "The stream failed.";
        push([formatSseEvent(anthropicErrorEvent("api_error", message))]);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    }),
  });
}

// ─── count_tokens (FR-ANTH-014) ──────────────────────────────────────────────

/**
 * Characters that will be rendered into the prompt: system, messages (text,
 * tool_use input, tool_result content) and the tool DEFINITIONS.
 *
 * Deliberately not a tokenizer. Claude Code calls `count_tokens` to decide when
 * to compact its context, so the number must be conservative — under-reporting
 * makes it overflow the window — but shipping a real BPE tokenizer into an Edge
 * Function to answer a question whose true answer depends on the served model's
 * own vocabulary would be false precision.
 */
export function countTokensChars(body: AnthropicMessagesRequest): number {
  let total = 0;
  const addBlockish = (value: unknown): void => {
    if (typeof value === "string") {
      total += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) addBlockish(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      const block = value as Record<string, unknown>;
      if (typeof block.text === "string") total += block.text.length;
      if (typeof block.thinking === "string") total += block.thinking.length;
      if (block.input !== undefined) total += safeJsonLength(block.input);
      if (block.content !== undefined) addBlockish(block.content);
      if (typeof block.name === "string") total += block.name.length;
    }
  };

  addBlockish(body?.system);
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      total += 8; // per-turn chat-template overhead
      addBlockish((message as { content?: unknown })?.content);
    }
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    total += safeJsonLength(body.tools);
  }
  return total;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** `{ input_tokens }` — the only field Anthropic's count_tokens returns. */
export function countTokensEstimate(
  body: AnthropicMessagesRequest,
  estimate: (chars: number) => number,
): { input_tokens: number } {
  return { input_tokens: estimate(countTokensChars(body)) };
}
