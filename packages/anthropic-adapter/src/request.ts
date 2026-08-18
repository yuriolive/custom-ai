/**
 * Anthropic Messages request -> OpenAI Chat Completions request.
 *
 * The two hard structural differences:
 *   1. Anthropic `system` is a top-level field; OpenAI wants a leading message.
 *   2. Anthropic keeps tool results inside a *user* message's content array;
 *      OpenAI wants each one as its own `{role:"tool"}` message. One Anthropic
 *      message can therefore fan out into several OpenAI messages.
 */

import { AnthropicAdapterError } from "./errors.ts";
import type {
  AnthropicContentBlock,
  AnthropicMessageParam,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIFunctionTool,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolChoice,
} from "./types.ts";

export interface TranslateRequestOptions {
  /**
   * Replace `model` on the way out (the gateway routes on `creator/slug`, which
   * is not what the Anthropic client necessarily sent).
   */
  model?: string;
  /**
   * Add `stream_options: { include_usage: true }` when `stream` is true.
   * Required for vLLM to report usage at all — see docs/CONTRACTS.md #4.
   * Default: true.
   */
  includeUsage?: boolean;
  /**
   * What to do with `thinking` blocks in the *input* history. Reasoning models
   * regenerate their own chain-of-thought and OpenAI has no field for prior CoT.
   * "drop" (default) omits them; "text" folds them into the assistant text.
   */
  thinkingBlocks?: "drop" | "text";
}

export interface TranslatedRequest {
  request: OpenAIChatRequest;
  /** Non-fatal losses. Surface these; do not swallow them. */
  warnings: string[];
}

function systemToText(system: AnthropicMessagesRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  // Anthropic concatenates system text blocks; "\n\n" matches how the blocks are
  // rendered when a client splits a long prompt purely for cache_control breaks.
  return system
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
}

function imagePartFromBlock(block: Extract<AnthropicContentBlock, { type: "image" }>) {
  const src = block.source;
  if (src.type === "url") return { type: "image_url" as const, image_url: { url: src.url } };
  return {
    type: "image_url" as const,
    image_url: { url: `data:${src.media_type};base64,${src.data}` },
  };
}

/** Flatten a tool_result's content (string, or array of blocks) into a string. */
function toolResultText(block: Extract<AnthropicContentBlock, { type: "tool_result" }>): string {
  const c = block.content;
  if (c === undefined || c === null) return "";
  if (typeof c === "string") return c;
  return c
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") return "[image omitted: OpenAI tool messages are text-only]";
      return `[${b.type} block omitted]`;
    })
    .join("\n");
}

export function translateToolChoice(choice: AnthropicToolChoice): OpenAIToolChoice {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return "auto";
  }
}

export function translateTools(tools: AnthropicTool[]): OpenAIFunctionTool[] {
  return tools.map((t) => {
    const fn: OpenAIFunctionTool["function"] = {
      name: t.name,
      // The JSON Schema body crosses unchanged. Only the field name differs.
      parameters: t.input_schema ?? { type: "object", properties: {} },
    };
    if (t.description !== undefined) fn.description = t.description;
    return { type: "function", function: fn };
  });
}

function translateMessage(
  msg: AnthropicMessageParam,
  warnings: string[],
  opts: TranslateRequestOptions,
): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const blocks = Array.isArray(msg.content) ? msg.content : [];

  // tool_result blocks become standalone `{role:"tool"}` messages. OpenAI requires
  // them to PRECEDE any further user content in the same turn, which is also the
  // order Claude Code produces them in.
  const toolMessages: OpenAIMessage[] = [];
  const parts: OpenAIContentPart[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image":
        parts.push(imagePartFromBlock(block));
        break;
      case "tool_result":
        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block),
        });
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            // OpenAI wants a JSON *string*; Anthropic gave us an object.
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case "thinking":
        if (opts.thinkingBlocks === "text") {
          parts.push({ type: "text", text: block.thinking });
        } else {
          warnings.push(
            "Dropped a `thinking` block from the input history: OpenAI Chat Completions has no field for prior reasoning.",
          );
        }
        break;
      case "redacted_thinking":
        warnings.push("Dropped a `redacted_thinking` block from the input history.");
        break;
      default:
        warnings.push(
          `Dropped an unrecognized content block of type "${(block as { type: string }).type}".`,
        );
    }
  }

  const out: OpenAIMessage[] = [...toolMessages];

  const hasParts = parts.length > 0;
  const hasCalls = toolCalls.length > 0;

  if (hasParts || hasCalls) {
    // Collapse a lone text part back to a plain string: some OpenAI-compatible
    // servers (llama.cpp among them) handle the array form inconsistently.
    const onlyText = parts.every((p) => p.type === "text");
    const content: OpenAIMessage["content"] = hasParts
      ? onlyText
        ? parts.map((p) => (p as { text: string }).text).join("")
        : parts
      : null;

    const message: OpenAIMessage = { role: msg.role, content };
    if (hasCalls) message.tool_calls = toolCalls;
    out.push(message);
  } else if (out.length === 0) {
    // An empty content array is legal Anthropic but drops the turn otherwise.
    out.push({ role: msg.role, content: "" });
  }

  return out;
}

/**
 * Translate a full Anthropic Messages request.
 *
 * Throws {@link AnthropicAdapterError} (400 `invalid_request_error`) when the
 * request is not representable — most importantly when `max_tokens` is missing.
 * We refuse rather than substituting a default: a silently invented cap would
 * truncate output and, under docs/CONTRACTS.md, mis-size the authorization hold.
 */
export function translateRequest(
  req: AnthropicMessagesRequest,
  options: TranslateRequestOptions = {},
): TranslatedRequest {
  const warnings: string[] = [];

  if (req === null || typeof req !== "object") {
    throw new AnthropicAdapterError("invalid_request_error", "Request body must be an object.");
  }
  if (typeof req.model !== "string" || req.model.length === 0) {
    throw new AnthropicAdapterError("invalid_request_error", "`model` is required.");
  }
  if (!Array.isArray(req.messages)) {
    throw new AnthropicAdapterError("invalid_request_error", "`messages` must be an array.");
  }
  if (typeof req.max_tokens !== "number" || !Number.isInteger(req.max_tokens)) {
    throw new AnthropicAdapterError(
      "invalid_request_error",
      "`max_tokens` is required and must be an integer.",
    );
  }
  if (req.max_tokens < 1) {
    throw new AnthropicAdapterError("invalid_request_error", "`max_tokens` must be >= 1.");
  }

  const messages: OpenAIMessage[] = [];

  const systemText = systemToText(req.system);
  if (systemText.length > 0) messages.push({ role: "system", content: systemText });

  for (const msg of req.messages) {
    messages.push(...translateMessage(msg, warnings, options));
  }

  const out: OpenAIChatRequest = {
    model: options.model ?? req.model,
    messages,
    max_tokens: req.max_tokens,
  };

  if (req.tools !== undefined && req.tools.length > 0) out.tools = translateTools(req.tools);
  if (req.tool_choice !== undefined) {
    if (req.tool_choice.type !== "none" && req.tool_choice.disable_parallel_tool_use) {
      warnings.push(
        "`tool_choice.disable_parallel_tool_use` has no OpenAI Chat Completions equivalent and was dropped.",
      );
    }
    out.tool_choice = translateToolChoice(req.tool_choice);
  }
  if (req.stop_sequences !== undefined && req.stop_sequences.length > 0) {
    out.stop = [...req.stop_sequences];
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  // top_k is not in the OpenAI spec, but llama.cpp and vLLM both honour it.
  if (req.top_k !== undefined) out.top_k = req.top_k;
  if (req.stream !== undefined) out.stream = req.stream;

  if (req.stream === true && options.includeUsage !== false) {
    out.stream_options = { include_usage: true };
  }

  if (req.thinking !== undefined) {
    warnings.push(
      "`thinking` config has no OpenAI Chat Completions equivalent and was dropped; the upstream model decides on its own whether to emit reasoning_content.",
    );
  }
  if (req.metadata !== undefined) {
    warnings.push("`metadata` has no OpenAI Chat Completions equivalent and was dropped.");
  }

  return { request: out, warnings };
}
