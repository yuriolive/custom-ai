"use client";

import { Chip } from "@heroui/react";

import { formatMicroUsd, formatMs, formatRate, formatTokens } from "@/lib/format";
import type { TurnMetrics } from "@/lib/types";

/**
 * Per-turn cost footer (FR-PLAY-005), rendered as Chips under the assistant
 * message.
 *
 * Values arrive as UI message metadata from /api/playground. Cost is a
 * placeholder ("—") until the gateway reports settlement — the shape is wired
 * now so that landing the gateway is a data change, not a UI change.
 */
export function CostFooter({ metrics }: { metrics: TurnMetrics | undefined }) {
  if (!metrics) return null;

  const estimated = metrics.usageSource === "estimated";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Chip variant="soft">prompt {formatTokens(metrics.promptTokens)}</Chip>

      <Chip variant="soft">
        completion {formatTokens(metrics.completionTokens)}
        {estimated ? "*" : ""}
      </Chip>

      <Chip
        color={metrics.costMicroUsd == null ? "default" : "accent"}

        title={
          metrics.costMicroUsd == null
            ? "Cost lands when the gateway settles the transaction"
            : "Charged to your wallet"
        }
        variant="soft"
      >
        cost {formatMicroUsd(metrics.costMicroUsd)}
      </Chip>

      <Chip
        color={metrics.coldStart ? "warning" : "default"}

        title="Time to first token"
        variant="soft"
      >
        TTFT {formatMs(metrics.ttftMs)}
      </Chip>

      <Chip variant="soft">{formatRate(metrics.tokensPerSecond)}</Chip>

      {metrics.coldStart ? (
        <Chip color="warning" variant="soft">
          cold start
        </Chip>
      ) : null}

      {estimated ? (
        <span className="text-muted text-xs">
          * upstream sent no usage on the final chunk; completion tokens are counted from the
          stream.
        </span>
      ) : null}
    </div>
  );
}
