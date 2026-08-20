"use client";

import { CopyButton } from "@/components/chat/copy-button";
import { splitSegments } from "@/lib/chat/segments";

/**
 * Renders one message's text.
 *
 * Prose is rendered as plain text with preserved line breaks — never as HTML,
 * and never through `dangerouslySetInnerHTML`. The content is produced by a
 * model that a stranger deployed and that anyone can prompt; the only safe
 * default for it is "this is text".
 *
 * Code blocks are the one exception worth the code, because they are the one
 * thing plain text genuinely ruins, and because a snippet nobody can copy is
 * not much of an answer. Everything else Markdown does degrades acceptably.
 */
export function MessageBody({ text }: { text: string }) {
  const segments = splitSegments(text);

  if (segments.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <p key={index} className="text-sm leading-6 whitespace-pre-wrap">
            {segment.text}
          </p>
        ) : (
          <figure
            key={index}
            className="border-border bg-background overflow-hidden rounded-lg border"
          >
            <figcaption className="border-border bg-surface flex items-center justify-between gap-2 border-b px-3 py-1.5">
              <span className="text-muted font-mono text-xs">{segment.language ?? "code"}</span>
              {/* An unterminated fence is still streaming, and copying half a
                  function is a paper cut nobody needs. */}
              {segment.closed ? <CopyButton label="code block" text={segment.code} /> : null}
            </figcaption>
            <pre className="overflow-x-auto px-3 py-3">
              <code className="font-mono text-xs leading-6">{segment.code}</code>
            </pre>
          </figure>
        ),
      )}
    </div>
  );
}
