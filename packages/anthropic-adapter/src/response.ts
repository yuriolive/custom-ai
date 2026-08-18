/**
 * OpenAI Chat Completions response (non-streaming) -> Anthropic Message.
 */

import type {
  AnthropicMessage,
  AnthropicResponseBlock,
  AnthropicStopReason,
  AnthropicUsage,
  OpenAIChatResponse,
  OpenAIChoice,
  OpenAIFinishReason,
  OpenAIUsage,
} from "./types.ts";

export interface TranslateResponseOptions {
  /** The `stop_sequences` from the originating request, for stop_reason detection. */
  stopSequences?: string[];
  /** Overrides the model name echoed back to the client. */
  model?: string;
  /** Overrides the message id. Default: derived from the OpenAI `id`. */
  messageId?: string;
}

export interface TranslatedResponse {
  message: AnthropicMessage;
  /** Non-fatal problems (e.g. tool arguments that were not valid JSON). */
  warnings: string[];
}

/**
 * OpenAI `finish_reason` -> Anthropic `stop_reason`.
 *
 * `stop` is ambiguous: OpenAI uses it both for a natural end of turn and for a
 * stop-sequence hit. Disambiguation needs request context, so it happens in
 * {@link translateResponse}; this function reports the natural reading.
 */
export function mapFinishReason(reason: OpenAIFinishReason): AnthropicStopReason | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case null:
    case undefined:
      return null;
    default:
      return "end_turn";
  }
}

/** Anthropic `stop_reason` -> OpenAI `finish_reason`, for the reverse direction. */
export function mapStopReason(reason: AnthropicStopReason | null): OpenAIFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case "pause_turn":
      return "stop";
    default:
      return null;
  }
}

/**
 * Which stop sequence, if any, terminated this text.
 *
 * Two sources, in order of trust:
 *   1. `choice.stop_reason` — a vLLM extension carrying the matched string.
 *   2. A suffix match on the emitted text, for servers that leave the sequence in.
 *
 * llama.cpp strips the stop sequence and reports nothing, so neither source
 * fires there and we correctly fall back to `end_turn`.
 */
export function detectStopSequence(
  text: string,
  stopSequences: string[] | undefined,
  choiceStopReason?: string | number | null,
): string | null {
  if (typeof choiceStopReason === "string" && choiceStopReason.length > 0) {
    return choiceStopReason;
  }
  if (!stopSequences || stopSequences.length === 0) return null;
  for (const seq of stopSequences) {
    if (seq.length > 0 && text.endsWith(seq)) return seq;
  }
  return null;
}

/**
 * `prompt_tokens` -> `input_tokens`, `completion_tokens` -> `output_tokens`.
 * Anthropic has no `total_tokens`; we do not invent one.
 */
export function translateUsage(usage: OpenAIUsage | undefined): AnthropicUsage {
  const out: AnthropicUsage = {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  };
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") out.cache_read_input_tokens = cached;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number") out.output_tokens_details = { thinking_tokens: reasoning };
  return out;
}

/** Anthropic ids are `msg_`-prefixed; OpenAI's are `chatcmpl-`-prefixed. */
export function toAnthropicMessageId(openaiId: string | undefined): string {
  if (!openaiId || openaiId.length === 0) return `msg_${Date.now().toString(36)}`;
  if (openaiId.startsWith("msg_")) return openaiId;
  return `msg_${openaiId.replace(/^chatcmpl[-_]/, "")}`;
}

export function translateResponse(
  resp: OpenAIChatResponse,
  options: TranslateResponseOptions = {},
): TranslatedResponse {
  const warnings: string[] = [];
  const choice: OpenAIChoice | undefined = resp.choices?.[0];

  if (resp.choices && resp.choices.length > 1) {
    warnings.push(
      `Upstream returned ${resp.choices.length} choices; Anthropic Messages has no n>1 shape, so only choice[0] was translated.`,
    );
  }

  const content: AnthropicResponseBlock[] = [];

  // Reasoning first: it precedes the answer in the model's own ordering, and it
  // is billed output — dropping it would under-report tokens (CONTRACTS.md).
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    content.push({ type: "thinking", thinking: reasoning, signature: "" });
  }

  let text = typeof choice?.message?.content === "string" ? choice.message.content : "";

  const matchedStop = detectStopSequence(text, options.stopSequences, choice?.stop_reason);
  // Anthropic excludes the stop sequence from the returned text.
  if (matchedStop && text.endsWith(matchedStop)) {
    text = text.slice(0, text.length - matchedStop.length);
  }

  if (text.length > 0) content.push({ type: "text", text });

  for (const call of choice?.message?.tool_calls ?? []) {
    const raw = call.function?.arguments ?? "";
    let input: Record<string, unknown> = {};
    if (raw.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        } else {
          warnings.push(
            `Tool call ${call.id}: arguments parsed to a non-object (${typeof parsed}); using {} instead. Raw: ${raw}`,
          );
        }
      } catch {
        // Report, never throw: a malformed argument string is an upstream defect
        // and must not take down a response that is otherwise fully usable.
        warnings.push(
          `Tool call ${call.id}: arguments were not valid JSON; using {} instead. Raw: ${raw}`,
        );
      }
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "",
      input,
    });
  }

  // An assistant turn with no blocks at all is not a legal Anthropic Message.
  if (content.length === 0) content.push({ type: "text", text: "" });

  let stopReason = mapFinishReason(choice?.finish_reason ?? null);
  if (stopReason === "end_turn" && matchedStop) stopReason = "stop_sequence";
  // Some servers report `stop` alongside tool calls; the tool calls win.
  if (stopReason === "end_turn" && (choice?.message?.tool_calls?.length ?? 0) > 0) {
    stopReason = "tool_use";
  }

  const message: AnthropicMessage = {
    id: options.messageId ?? toAnthropicMessageId(resp.id),
    type: "message",
    role: "assistant",
    content,
    model: options.model ?? resp.model ?? "",
    stop_reason: stopReason,
    stop_sequence: stopReason === "stop_sequence" ? matchedStop : null,
    usage: translateUsage(resp.usage),
  };

  if (resp.usage === undefined) {
    warnings.push(
      "Upstream reported no usage; input_tokens/output_tokens are 0. Do not bill from this.",
    );
  }

  return { message, warnings };
}
