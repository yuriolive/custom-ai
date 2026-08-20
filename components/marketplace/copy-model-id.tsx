"use client";

import { Button } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy the platform model id.
 *
 * The highest-frequency action on a catalog card, and it used to require
 * selecting mono text that is deliberately `break-all` across two lines.
 *
 * WHAT LANDS ON THE CLIPBOARD is `creator-handle/model-slug` — the platform id
 * of the listing the card quotes. NOT the Hugging Face repo path, and NOT
 * `base_models.slug`: `qwen/qwen3-8b` looks exactly like a platform id and
 * resolves to nothing, because its first half is a weights publisher rather than
 * a creator handle (CONTRACTS.md, top). Pasting either is a 404, and it is the
 * single most likely reason a copied snippet fails.
 *
 * Confirmation is inline and announced, matching `code-block.tsx`: HeroUI v3's
 * Toast needs a region mounted in the root layout, which this component does not
 * own, and a purely visual state change on the pressed control is invisible to a
 * screen-reader user.
 *
 * Its own file, not a private function inside the card, because two surfaces need
 * it and the second copy would be the one that stops announcing.
 */
export function CopyModelId({ modelId }: { modelId: string }) {
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
      // navigator.clipboard is undefined on a non-secure origin and rejects when
      // the document is not focused. Both are reported, not swallowed — a copy
      // button that silently does nothing is worse than no button.
      await navigator.clipboard.writeText(modelId);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2_500);
  }, [modelId]);

  let copyLabel = "Copy id";
  if (state === "copied") copyLabel = "Copied";
  else if (state === "failed") copyLabel = "Failed";

  let announcement = "";
  if (state === "copied") announcement = `${modelId} copied to the clipboard`;
  else if (state === "failed") {
    announcement = "Copy failed. Select the model id and copy it manually.";
  }

  return (
    // `relative z-10` lifts the control out from under the title link's stretched
    // `::after`; `shrink-0` stops a long id squeezing it to nothing at 375px.
    <span className="relative z-10 shrink-0">
      <Button
        aria-label={`Copy the model id ${modelId}`}
        onPress={copy}
        size="sm"
        variant={state === "copied" ? "primary" : "ghost"}
      >
        {copyLabel}
      </Button>
      <span aria-live="polite" className="sr-only" role="status">
        {announcement}
      </span>
    </span>
  );
}
