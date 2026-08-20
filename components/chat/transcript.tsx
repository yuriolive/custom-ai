"use client";

import { CopyButton } from "@/components/chat/copy-button";
import { MessageBody } from "@/components/chat/message-body";
import type { CatalogModel } from "@/components/marketplace/types";
import { formatMicroUsd, formatRate, formatTokens } from "@/lib/format";
import type { ChatUIMessage, TurnMetrics } from "@/lib/types";

export function messageText(message: ChatUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * What this turn will cost, from the model's own prices.
 *
 * The gateway does not yet surface the settled figure to its callers, so this
 * is an ESTIMATE and is labelled as one everywhere it appears. It is computed
 * the same way the ledger computes the real charge — integer micro-USD, CEIL on
 * each side, a one-microdollar floor (CONTRACTS.md §Money) — so it errs in the
 * same direction as the bill rather than under-quoting it.
 *
 * Returns null rather than 0 when there is nothing to price: a confident $0.00
 * on a request that did engage a GPU is the one number this must never show.
 */
export function estimateTurnMicroUsd(
  metrics: TurnMetrics | undefined,
  model: CatalogModel | null,
): number | null {
  if (!metrics || !model) return null;
  if (metrics.promptTokens == null && metrics.completionTokens == null) return null;

  const prompt = Math.ceil(((metrics.promptTokens ?? 0) * model.pricePromptMicroPerMtoken) / 1e6);
  const completion = Math.ceil(
    ((metrics.completionTokens ?? 0) * model.priceCompletionMicroPerMtoken) / 1e6,
  );
  return Math.max(1, prompt + completion);
}

function TurnFooter({
  metrics,
  model,
}: {
  metrics: TurnMetrics | undefined;
  model: CatalogModel | null;
}) {
  if (!metrics || metrics.completionTokens == null) return null;

  const estimate = estimateTurnMicroUsd(metrics, model);
  const tokens = (metrics.promptTokens ?? 0) + (metrics.completionTokens ?? 0);

  return (
    <p className="text-muted mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
      {estimate !== null ? (
        <span title="Estimated from this model's published prices. The exact charge is on your usage page.">
          ≈{formatMicroUsd(estimate)}
        </span>
      ) : null}
      <span>{formatTokens(tokens)} tokens</span>
      {metrics.tokensPerSecond ? <span>{formatRate(metrics.tokensPerSecond)}</span> : null}
      {metrics.coldStart ? <span>started a worker</span> : null}
    </p>
  );
}

/**
 * The transcript (FR-CHAT-001).
 *
 * The empty case belongs to the page, not here: its suggestions have to write
 * into the composer, which lives up there.
 */
export function Transcript({
  messages,
  isStreaming,
  modelForMessage,
}: {
  messages: ChatUIMessage[];
  isStreaming: boolean;
  /** The model that produced a given assistant message — threads may switch. */
  modelForMessage: (messageId: string) => CatalogModel | null;
}) {
  const lastIndex = messages.length - 1;

  return (
    <ol className="flex flex-col gap-6">
      {messages.map((message, index) => {
        const isUser = message.role === "user";
        const isLive = isStreaming && index === lastIndex && !isUser;
        const text = messageText(message);

        if (isUser) {
          return (
            <li key={message.id} className="flex justify-end">
              <div className="bg-accent text-accent-foreground max-w-[46rem] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap">
                {text}
              </div>
            </li>
          );
        }

        return (
          <li key={message.id} className="group flex flex-col">
            <div
              className={[
                "text-foreground max-w-[52rem] min-w-0",
                isLive ? "streaming-caret" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <MessageBody text={text} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <TurnFooter metrics={message.metadata} model={modelForMessage(message.id)} />
              {/* Only once the reply is finished: a copy button on a half-written
                  answer copies half an answer. */}
              {!isLive && text.length > 0 ? (
                <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <CopyButton label="reply" text={text} />
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
