"use client";

import { Button } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with inline confirmation.
 *
 * Same shape as `components/marketplace/code-block.tsx` and for the same
 * reasons: no Toast (HeroUI v3's needs a region mounted in the root layout), and
 * the failure case is reported rather than swallowed — `navigator.clipboard` is
 * undefined on a non-secure origin and rejects when the document is not
 * focused, and a copy button that silently does nothing is worse than none.
 *
 * The state change is announced: a purely visual change on the control the user
 * just pressed is invisible to a screen reader.
 */
type CopyState = "idle" | "copied" | "failed";

const BUTTON_LABEL: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

export function CopyButton({
  className,
  label,
  text,
}: Readonly<{
  className?: string;
  /** What is being copied, for the assistive announcement. */
  label: string;
  text: string;
}>) {
  const [state, setState] = useState<CopyState>("idle");
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
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2_000);
  }, [text]);

  return (
    <>
      <Button
        aria-label={`Copy ${label}`}
        className={className}
        size="sm"
        variant="ghost"
        onPress={() => void copy()}
      >
        {BUTTON_LABEL[state]}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "idle" ? "" : `${label}: ${BUTTON_LABEL[state]}`}
      </span>
    </>
  );
}
