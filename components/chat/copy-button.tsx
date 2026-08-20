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
export function CopyButton({
  className,
  label,
  text,
}: {
  className?: string;
  /** What is being copied, for the assistive announcement. */
  label: string;
  text: string;
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
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? `${label} copied` : state === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}
