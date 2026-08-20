import type { UIMessage } from "ai";

/**
 * Per-turn metering attached to each assistant message as UI message metadata
 * (FR-PLAY-005). The gateway is the source of truth; until it lands the route
 * handler fills in what the provider reports and leaves cost null.
 *
 * All money is BIGINT micro-USD (1 unit = $0.000001) per CONTRACTS.md §Money.
 * `costMicroUsd` is an integer number of micro-USD. There are no floats in the
 * monetary path — formatting happens once, at the edge, in `formatMicroUsd`.
 */
export type TurnMetrics = {
  /** Tokens billed as prompt. */
  promptTokens: number | null;
  /** Tokens billed as completion. */
  completionTokens: number | null;
  /** Integer micro-USD charged for this turn. Null until settlement reports. */
  costMicroUsd: number | null;
  /** Time to first token, milliseconds. */
  ttftMs: number | null;
  /** Output tokens per second over the streaming window. */
  tokensPerSecond: number | null;
  /** Whether this turn paid a cold start. */
  coldStart: boolean | null;
  /**
   * Where the usage numbers came from. llama.cpp does not guarantee usage on
   * the final chunk, so consumers must handle both (CONTRACTS.md §Upstream).
   */
  usageSource: "upstream" | "estimated" | null;
};

export const emptyTurnMetrics: TurnMetrics = {
  promptTokens: null,
  completionTokens: null,
  costMicroUsd: null,
  ttftMs: null,
  tokensPerSecond: null,
  coldStart: null,
  usageSource: null,
};

/** The UIMessage shape used across the playground. */
export type PlaygroundUIMessage = UIMessage<TurnMetrics>;

/**
 * The UIMessage shape used across the chat (FR-CHAT-001).
 *
 * Identical metadata to the playground's, and named separately anyway: the two
 * surfaces answer to different requirements and the chat's metering is expected
 * to gain a settled cost before the playground's does. An alias makes that a
 * one-line change instead of a rename across both.
 */
export type ChatUIMessage = UIMessage<TurnMetrics>;

/** Body posted from the playground client to /api/playground. */
export type PlaygroundRequestBody = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
};

