"use client";

import { CostFooter } from "@/components/playground/cost-footer";
import type { PlaygroundUIMessage } from "@/lib/types";

function textOf(message: PlaygroundUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * The transcript. The empty case is owned by `chat.tsx` (the seed prompts have
 * to write into the composer, which lives there), so this component only ever
 * renders a non-empty list.
 */
export function MessageList({
  messages,
  isStreaming,
}: {
  messages: PlaygroundUIMessage[];
  isStreaming: boolean;
}) {
  const lastIndex = messages.length - 1;

  return (
    <ol className="flex flex-col gap-5">
      {messages.map((message, index) => {
        const isUser = message.role === "user";
        const isLive = isStreaming && index === lastIndex && !isUser;

        return (
          <li key={message.id} className="flex flex-col">
            <span className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">
              {isUser ? "You" : "Assistant"}
            </span>

            <div
              className={[
                "w-fit max-w-[52rem] whitespace-pre-wrap rounded-xl px-4 py-3 text-sm leading-6",
                isUser
                  ? "bg-accent text-accent-foreground self-end"
                  : "bg-surface text-surface-foreground border-border border",
                isLive ? "streaming-caret" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {textOf(message)}
            </div>

            {!isUser ? <CostFooter metrics={message.metadata} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
