"use client";

import { Button } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Grammar } from "./highlight";
import { tokenClassName, tokenize } from "./highlight";

/**
 * A highlighted, copyable code block.
 *
 * Tokens are rendered as React children, never as `dangerouslySetInnerHTML`, so
 * no amount of odd content in a snippet can inject markup.
 *
 * Copy confirmation is inline rather than a Toast. HeroUI v3's toast needs a
 * region mounted in the root layout, which this agent does not own — and an
 * inline "Copied" on the button the user just pressed is the confirmation they
 * were looking for anyway. It is also announced: `aria-live="polite"` on a
 * status node, because a purely visual state change on the pressed control is
 * invisible to a screen-reader user.
 */
export function CodeBlock({
  code,
  grammar,
  label,
}: {
  code: string;
  grammar: Grammar;
  /** What was copied, for the assistive announcement. */
  label: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      // navigator.clipboard is undefined on a non-secure origin, and rejects
      // when the document is not focused. Both are reported, not swallowed —
      // a copy button that silently does nothing is worse than no button.
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2_500);
  }, [code]);

  const tokens = tokenize(code, grammar);

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <Button
          aria-label={`Copy the ${label} snippet`}
          onPress={copy}
          size="sm"
          variant={state === "copied" ? "primary" : "secondary"}
        >
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
        </Button>
      </div>

      {/* tabIndex on <pre> so a keyboard user can scroll a long snippet
          horizontally without a mouse; the code itself is not interactive. */}
      <pre
        className="border-muted/25 bg-surface text-surface-foreground max-w-full overflow-x-auto rounded-[var(--radius)] border p-4 pt-12 text-[0.8125rem] leading-relaxed"
        tabIndex={0}
      >
        <code className="font-mono">
          {tokens.map((token, index) =>
            token.kind === "plain" ? (
              token.text
            ) : (
              // The token list is derived from an immutable string, so the
              // position IS the identity — there is nothing more stable to key on.
              <span className={tokenClassName(token.kind)} key={index}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>

      <p aria-live="polite" className="sr-only" role="status">
        {state === "copied"
          ? `${label} snippet copied to the clipboard`
          : state === "failed"
            ? "Copy failed. Select the code and copy it manually."
            : ""}
      </p>
    </div>
  );
}
