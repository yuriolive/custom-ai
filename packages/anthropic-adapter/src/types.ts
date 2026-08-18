/**
 * Wire types for both sides of the translation.
 *
 * Types only — no runtime values live in this file, so it erases to nothing.
 * Shapes are transcribed from the current published contracts:
 *   Anthropic Messages API  https://platform.claude.com/docs/en/api/messages
 *   Anthropic streaming     https://platform.claude.com/docs/en/build-with-claude/streaming
 *   OpenAI Chat Completions https://platform.openai.com/docs/api-reference/chat
 *
 * Both sides are deliberately typed permissively at the edges (`[k: string]: unknown`
 * escape hatches, optional fields) because we translate traffic we did not author:
 * Claude Code sends fields we do not model, and llama.cpp / vLLM add non-standard
 * fields (`choice.stop_reason`, `delta.reasoning_content`) that we must not drop.
 */

// ─── Anthropic: request ──────────────────────────────────────────────────────

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
  citations?: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** String, or an array of blocks (Claude Code sends text blocks here). */
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  cache_control?: unknown;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Opaque integrity signature. We cannot mint a real one; see README. */
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  /** JSON Schema. Renamed to `function.parameters` on the OpenAI side, body untouched. */
  input_schema: Record<string, unknown>;
  type?: string;
  cache_control?: unknown;
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface AnthropicThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
  display?: string;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessageParam[];
  /** REQUIRED by Anthropic. Optional in OpenAI — we carry it, never invent it. */
  max_tokens: number;
  /** TOP-LEVEL in Anthropic; becomes a leading `{role:"system"}` OpenAI message. */
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  thinking?: AnthropicThinkingConfig;
  metadata?: { user_id?: string; [k: string]: unknown };
  [k: string]: unknown;
}

// ─── Anthropic: response ─────────────────────────────────────────────────────

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens: number };
}

export type AnthropicResponseBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicResponseBlock[];
  model: string;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ─── Anthropic: streaming events ─────────────────────────────────────────────

/**
 * `message_start.message` carries the same shape as a non-streaming Message but
 * with `content: []`. Anthropic reports a small non-zero `output_tokens` here;
 * we report 0 (see README "Known deviations").
 */
export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: AnthropicMessage;
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, never> };
}

export type AnthropicStreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: AnthropicStreamDelta;
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: AnthropicStopReason | null; stop_sequence: string | null };
  /** Cumulative for the message, per the streaming spec. */
  usage: AnthropicUsage;
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

export interface AnthropicPingEvent {
  type: "ping";
}

export interface AnthropicErrorEvent {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent;

// ─── Anthropic: errors ───────────────────────────────────────────────────────

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error"
  | "billing_error"
  | "timeout_error";

export interface AnthropicErrorResponse {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
}

// ─── OpenAI: request ─────────────────────────────────────────────────────────

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** The Anthropic `input_schema` body, unchanged. */
    parameters: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  tools?: OpenAIFunctionTool[];
  tool_choice?: OpenAIToolChoice;
  stop?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  [k: string]: unknown;
}

// ─── OpenAI: response ────────────────────────────────────────────────────────

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "function_call"
  | "content_filter"
  | null;

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Anthropic has no equivalent — deliberately not carried across. */
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAIResponseMessage {
  role: "assistant";
  content?: string | null;
  /** Non-standard, emitted by reasoning models (our MVP target does). */
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIResponseMessage;
  finish_reason: OpenAIFinishReason;
  /** vLLM extension: the matched stop string when finish_reason === "stop". */
  stop_reason?: string | number | null;
}

export interface OpenAIChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

// ─── OpenAI: streaming ───────────────────────────────────────────────────────

export interface OpenAIStreamToolCallDelta {
  /** Position of this tool call in the message. Advancing it opens a NEW call. */
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenAIStreamDelta {
  role?: "assistant";
  content?: string | null;
  /** Reasoning models stream chain-of-thought here. Billed output — never drop. */
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAIStreamToolCallDelta[];
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: OpenAIFinishReason;
  stop_reason?: string | number | null;
}

export interface OpenAIStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
}

// ─── OpenAI: errors ──────────────────────────────────────────────────────────

export interface OpenAIErrorBody {
  message?: string;
  type?: string;
  param?: string | null;
  code?: string | null;
}

export interface OpenAIErrorResponse {
  error: OpenAIErrorBody;
}
