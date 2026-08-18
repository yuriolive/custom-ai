/**
 * @nexus/anthropic-adapter — bidirectional Anthropic Messages API <-> OpenAI
 * Chat Completions translation.
 *
 * Pure functions and one state machine. No I/O, no runtime dependencies, no
 * imports from the gateway: Deno and Node both load this source directly, with
 * no build step.
 *
 * See README.md for the four known deviations from the Anthropic wire contract.
 */

export {
  translateRequest,
  translateTools,
  translateToolChoice,
  type TranslateRequestOptions,
  type TranslatedRequest,
} from "./request.ts";

export {
  translateResponse,
  translateUsage,
  mapFinishReason,
  mapStopReason,
  detectStopSequence,
  toAnthropicMessageId,
  type TranslateResponseOptions,
  type TranslatedResponse,
} from "./response.ts";

export {
  AnthropicStreamTranslator,
  translateStream,
  translateSseText,
  anthropicErrorEvent,
  type StreamTranslatorOptions,
} from "./stream.ts";

export {
  translateError,
  toOpenAIError,
  statusForAnthropicErrorType,
  AnthropicAdapterError,
} from "./errors.ts";

export {
  formatSseEvent,
  formatSseEvents,
  createSseDecoder,
  isDoneSentinel,
  type SseDecoder,
} from "./sse.ts";

export type * from "./types.ts";
