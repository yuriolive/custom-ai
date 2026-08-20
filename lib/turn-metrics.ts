import type { TurnMetrics } from "@/lib/types";
import { emptyTurnMetrics } from "@/lib/types";

/**
 * Per-turn metering, shared by `/api/playground` and `/api/chat`.
 *
 * One implementation on purpose. Both routes proxy the same gateway and both
 * report tokens, TTFT and throughput to the user; two copies would drift, and
 * the direction they drift in is always the same — someone fixes the token
 * count on one surface and the other quietly keeps under-reporting.
 *
 * TTFT is measured at the proxy because this is the only place that sees both
 * the moment the request left and the moment the first byte came back.
 */

/** Anything slower than this to first token was a worker waking up, not a slow prompt. */
const COLD_START_TTFT_MS = 10_000;

/**
 * Structurally compatible with the AI SDK's stream part union, without naming
 * it: the SDK's type is a wide discriminated union whose members carry fields
 * this file has no use for, and pinning it here would break the shared meter
 * every time the SDK adds a part type.
 */
type MetadataPart = {
  type: string;
  totalUsage?: { inputTokens?: number; outputTokens?: number };
};

export type TurnMeter = {
  messageMetadata(input: { part: MetadataPart }): TurnMetrics | undefined;
};

export function createTurnMeter(startedAt: number): TurnMeter {
  let ttftMs: number | null = null;
  let firstTokenAt: number | null = null;
  let streamedTokens = 0;

  return {
    messageMetadata({ part }): TurnMetrics | undefined {
      if (part.type === "start") {
        return { ...emptyTurnMetrics };
      }

      if (part.type === "text-delta") {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          ttftMs = firstTokenAt - startedAt;
          return {
            ...emptyTurnMetrics,
            ttftMs,
            coldStart: ttftMs > COLD_START_TTFT_MS,
          };
        }
        streamedTokens += 1; // rough live counter; replaced at finish
        return undefined;
      }

      if (part.type === "finish") {
        const elapsedStreamingMs = firstTokenAt === null ? null : Date.now() - firstTokenAt;
        const inputTokens = part.totalUsage?.inputTokens ?? null;
        const outputTokens = part.totalUsage?.outputTokens ?? null;

        // llama.cpp does not guarantee usage on the final chunk (CONTRACTS.md
        // §Upstream), so fall back to the streamed delta count and label it
        // honestly rather than showing a confident zero.
        const usageSource: TurnMetrics["usageSource"] =
          outputTokens != null ? "upstream" : "estimated";
        const completion = outputTokens ?? streamedTokens;

        return {
          promptTokens: inputTokens,
          completionTokens: completion,
          // Null until the gateway surfaces `cost_micro_usd` from
          // deduct_token_cost to its callers. Until it does, the chat estimates
          // the figure from the model's own published prices and says so; the
          // authoritative charge is on /console/usage.
          costMicroUsd: null,
          ttftMs,
          tokensPerSecond:
            elapsedStreamingMs !== null && elapsedStreamingMs > 0 && completion > 0
              ? (completion / elapsedStreamingMs) * 1_000
              : null,
          coldStart: ttftMs === null ? null : ttftMs > COLD_START_TTFT_MS,
          usageSource,
        };
      }

      return undefined;
    },
  };
}
