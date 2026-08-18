/**
 * OpenAI SSE stream -> Anthropic SSE stream.
 *
 * Anthropic's stream is a *stateful* event sequence, not a flat list of chunks:
 *
 *   message_start
 *     ( content_block_start  content_block_delta*  content_block_stop )*
 *   message_delta
 *   message_stop
 *
 * with `ping` events allowed anywhere. Every content block owns an `index` that
 * is its position in the final `content` array, so text, thinking and tool_use
 * blocks all share one sequential index space. OpenAI has no notion of blocks at
 * all — it just interleaves `delta.content`, `delta.reasoning_content` and
 * `delta.tool_calls[]` — so the block boundaries are entirely ours to invent.
 *
 * The translator is a pure state machine: feed it parsed OpenAI chunks with
 * `push()`, then call `finish()`. It never performs I/O and never throws on
 * malformed upstream data; problems land in `warnings`.
 */

import type {
  AnthropicErrorType,
  AnthropicMessage,
  AnthropicStopReason,
  AnthropicStreamEvent,
  AnthropicUsage,
  OpenAIFinishReason,
  OpenAIStreamChunk,
  OpenAIUsage,
} from "./types.ts";
import {
  detectStopSequence,
  mapFinishReason,
  toAnthropicMessageId,
  translateUsage,
} from "./response.ts";
import { createSseDecoder, formatSseEvent, isDoneSentinel } from "./sse.ts";

export interface StreamTranslatorOptions {
  /** Overrides the id from the upstream chunks. */
  messageId?: string;
  /** Overrides the model name echoed to the client. */
  model?: string;
  /** The originating request's `stop_sequences`, for stop_reason detection. */
  stopSequences?: string[];
  /**
   * Emit a `ping` every N content deltas. 0 disables. Default 25.
   * A ping is always emitted immediately after the first content_block_start,
   * mirroring Anthropic's own stream.
   */
  pingEveryDeltas?: number;
  /**
   * `input_tokens` for `message_start`, when the caller already knows it (e.g.
   * from its own prompt-token estimate). Default 0 — see README deviations.
   */
  inputTokens?: number;
}

type BlockKind = "text" | "thinking" | "tool_use";

interface OpenBlock {
  kind: BlockKind;
  index: number;
  /** For tool_use: the `index` inside OpenAI's `delta.tool_calls[]`. */
  toolIndex: number;
  /** For tool_use: whether a name was present when the block was opened. */
  named: boolean;
}

const DEFAULT_PING_EVERY = 25;

export class AnthropicStreamTranslator {
  readonly warnings: string[] = [];

  #opts: StreamTranslatorOptions;
  #started = false;
  #finished = false;
  #nextIndex = 0;
  #open: OpenBlock | null = null;
  #deltasSincePing = 0;
  #pingedFirstBlock = false;

  #id: string | null = null;
  #model: string | null = null;
  #text = "";
  #finishReason: OpenAIFinishReason = null;
  #choiceStopReason: string | number | null = null;
  #usage: OpenAIUsage | undefined = undefined;
  #sawUsage = false;
  #generatedToolIds = 0;

  constructor(options: StreamTranslatorOptions = {}) {
    this.#opts = options;
  }

  /** Feed one parsed OpenAI stream chunk. Returns the Anthropic events it produced. */
  push(chunk: OpenAIStreamChunk): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    if (this.#finished) {
      this.warnings.push("push() called after finish(); chunk ignored.");
      return events;
    }

    if (chunk.id && !this.#id) this.#id = chunk.id;
    if (chunk.model && !this.#model) this.#model = chunk.model;

    // The final usage-only chunk (`stream_options.include_usage`) carries no
    // choices. Capture it and emit nothing.
    if (chunk.usage !== undefined && chunk.usage !== null) {
      this.#usage = chunk.usage;
      this.#sawUsage = true;
    }

    if (!this.#started) events.push(this.#start());

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    if (chunk.choices && chunk.choices.length > 1) {
      this.warnings.push(
        "Upstream streamed more than one choice; only choice[0] was translated.",
      );
    }

    const delta = choice.delta ?? {};

    // Reasoning before answer: that is the model's own ordering, and it is billed
    // output. Silently dropping it under-counts tokens (docs/CONTRACTS.md).
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push(...this.#ensureBlock("thinking", -1, undefined, undefined));
      events.push({
        type: "content_block_delta",
        index: this.#open!.index,
        delta: { type: "thinking_delta", thinking: reasoning },
      });
      events.push(...this.#tickPing());
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push(...this.#ensureBlock("text", -1, undefined, undefined));
      this.#text += delta.content;
      events.push({
        type: "content_block_delta",
        index: this.#open!.index,
        delta: { type: "text_delta", text: delta.content },
      });
      events.push(...this.#tickPing());
    }

    for (const tc of delta.tool_calls ?? []) {
      const toolIndex = typeof tc.index === "number" ? tc.index : 0;
      const name = tc.function?.name;
      events.push(...this.#ensureBlock("tool_use", toolIndex, tc.id, name));

      if (name && this.#open && this.#open.kind === "tool_use" && !this.#open.named) {
        // Anthropic pins the tool name into content_block_start, so a name that
        // arrives in a later fragment cannot be represented. Report it.
        this.warnings.push(
          `Tool call at index ${toolIndex}: function.name arrived after content_block_start was emitted; the block was opened with an empty name.`,
        );
        this.#open.named = true;
      }

      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        // OpenAI's argument fragments are arbitrary substrings of the JSON — they
        // split mid-token routinely. Anthropic's `partial_json` has exactly the
        // same contract, so they pass through untouched: no parsing, no buffering.
        events.push({
          type: "content_block_delta",
          index: this.#open!.index,
          delta: { type: "input_json_delta", partial_json: args },
        });
        events.push(...this.#tickPing());
      }
    }

    if (choice.finish_reason) {
      this.#finishReason = choice.finish_reason;
      if (choice.stop_reason !== undefined) this.#choiceStopReason = choice.stop_reason;
    }

    return events;
  }

  /** Close any open block and emit `message_delta` + `message_stop`. */
  finish(): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    if (this.#finished) return events;

    if (!this.#started) events.push(this.#start());
    this.#finished = true;

    if (this.#open) {
      events.push({ type: "content_block_stop", index: this.#open.index });
      this.#open = null;
    }

    // A message with zero content blocks is not a legal Anthropic Message; open
    // and immediately close an empty text block so accumulating clients agree.
    if (this.#nextIndex === 0) {
      events.push({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      events.push({ type: "content_block_stop", index: 0 });
      this.#nextIndex = 1;
    }

    const matchedStop = detectStopSequence(
      this.#text,
      this.#opts.stopSequences,
      this.#choiceStopReason,
    );

    let stopReason: AnthropicStopReason | null = mapFinishReason(this.#finishReason);
    if (stopReason === "end_turn" && matchedStop) stopReason = "stop_sequence";

    if (!this.#sawUsage) {
      this.warnings.push(
        "Upstream never reported usage; message_delta.usage is 0. Do not bill from this stream.",
      );
    }

    const usage: AnthropicUsage = translateUsage(this.#usage);
    // message_start could only claim input_tokens we did not have yet; this is
    // where the real number lands. Anthropic itself puts input_tokens in
    // message_delta for server-tool turns, so the field is contract-legal here.
    if (usage.input_tokens === 0 && this.#opts.inputTokens) {
      usage.input_tokens = this.#opts.inputTokens;
    }

    events.push({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: stopReason === "stop_sequence" ? matchedStop : null },
      usage,
    });
    events.push({ type: "message_stop" });
    return events;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #start(): AnthropicStreamEvent {
    this.#started = true;
    const message: AnthropicMessage = {
      id: this.#opts.messageId ?? toAnthropicMessageId(this.#id ?? undefined),
      type: "message",
      role: "assistant",
      content: [],
      model: this.#opts.model ?? this.#model ?? "",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: this.#opts.inputTokens ?? 0, output_tokens: 0 },
    };
    return { type: "message_start", message };
  }

  /**
   * Make `kind` (and, for tool_use, `toolIndex`) the currently open block,
   * closing whatever was open before. This is the whole of the index bookkeeping:
   * indices only ever advance, and every kind draws from the same counter.
   */
  #ensureBlock(
    kind: BlockKind,
    toolIndex: number,
    toolId: string | undefined,
    toolName: string | undefined,
  ): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];
    const cur = this.#open;

    const sameBlock =
      cur !== null &&
      cur.kind === kind &&
      (kind !== "tool_use" || cur.toolIndex === toolIndex);
    if (sameBlock) return events;

    if (cur) events.push({ type: "content_block_stop", index: cur.index });

    const index = this.#nextIndex++;
    if (kind === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
    } else if (kind === "thinking") {
      // `signature` is opaque and Anthropic-minted; we have none and must not
      // fabricate one. Empty string keeps the block shape valid. See README.
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
    } else {
      const id = toolId ?? `toolu_stream_${this.#generatedToolIds++}`;
      if (!toolId) {
        this.warnings.push(
          `Tool call at index ${toolIndex}: upstream sent no id; generated "${id}".`,
        );
      }
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name: toolName ?? "", input: {} },
      });
    }

    this.#open = { kind, index, toolIndex, named: kind !== "tool_use" || Boolean(toolName) };

    if (!this.#pingedFirstBlock) {
      this.#pingedFirstBlock = true;
      this.#deltasSincePing = 0;
      events.push({ type: "ping" });
    }
    return events;
  }

  #tickPing(): AnthropicStreamEvent[] {
    const every = this.#opts.pingEveryDeltas ?? DEFAULT_PING_EVERY;
    if (every <= 0) return [];
    this.#deltasSincePing++;
    if (this.#deltasSincePing < every) return [];
    this.#deltasSincePing = 0;
    return [{ type: "ping" }];
  }
}

/**
 * Build a mid-stream `error` frame. Anthropic delivers errors *inside* the SSE
 * body once headers have flushed — which, per docs/CONTRACTS.md #1, is always
 * the case by the time the gateway learns the upstream failed.
 */
export function anthropicErrorEvent(
  type: AnthropicErrorType,
  message: string,
): AnthropicStreamEvent {
  return { type: "error", error: { type, message } };
}

/**
 * Convenience wrapper: parsed OpenAI chunks in, Anthropic events out.
 * Stops feeding the translator at the `[DONE]` sentinel (the caller filters it).
 */
export async function* translateStream(
  chunks: AsyncIterable<OpenAIStreamChunk>,
  options: StreamTranslatorOptions = {},
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  const t = new AnthropicStreamTranslator(options);
  for await (const chunk of chunks) {
    for (const e of t.push(chunk)) yield e;
  }
  for (const e of t.finish()) yield e;
}

/**
 * Full pipeline: raw OpenAI SSE body text in, Anthropic SSE frame text out.
 *
 * `warnings` is the same live array as the underlying translator's, so a caller
 * that wants it must read it *after* the generator is exhausted.
 */
export async function* translateSseText(
  source: AsyncIterable<string>,
  options: StreamTranslatorOptions = {},
  warnings?: string[],
): AsyncGenerator<string, void, undefined> {
  const t = new AnthropicStreamTranslator(options);
  const decoder = createSseDecoder();

  const handle = function* (payloads: string[]): Generator<string, void, undefined> {
    for (const payload of payloads) {
      if (isDoneSentinel(payload)) continue;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIStreamChunk;
      } catch {
        t.warnings.push(`Skipped an upstream SSE frame that was not valid JSON: ${payload}`);
        continue;
      }
      for (const e of t.push(chunk)) yield formatSseEvent(e);
    }
  };

  for await (const text of source) yield* handle(decoder.push(text));
  yield* handle(decoder.flush());
  for (const e of t.finish()) yield formatSseEvent(e);
  if (warnings) warnings.push(...t.warnings);
}
