"use client";

/**
 * The ⓘ affordance that puts an explanation behind a Tooltip.
 *
 * Lives at the components root rather than under `studio/` because the
 * marketplace snippet block needs the same affordance for the same reason: the
 * three values a first call depends on each carry a paragraph of caveat, and a
 * paragraph rendered inline is a paragraph nobody reads.
 *
 * The trigger is a real `<button>` rather than a `title` attribute or a bare
 * span: a tooltip that only exists on hover is unreachable by keyboard and
 * invisible on touch. `type="button"` because this lives inside a form and a
 * bare button submits it.
 *
 * This is NOT a HeroUI `Label` — a field's own `Label` is rendered by the
 * caller inside its `TextField`/`Slider`, and nesting two labels for one input
 * gives the field two accessible names.
 */

import { Tooltip } from "@heroui/react";
import type { ReactNode } from "react";

export function LabelHint({
  children,
  /**
   * What the hint is about. Several hints in one list all named "What this
   * means" are indistinguishable in a screen reader's control listing.
   */
  subject,
}: Readonly<{ children: ReactNode; subject?: string }>) {
  return (
    <Tooltip>
      {/* `render` swaps the trigger's default <div> for a real <button>. The
          default is not focusable, so the tooltip would be keyboard-unreachable
          — which is the entire reason this is not a `title` attribute.
          `type="button"` because this lives inside a form, where a bare button
          submits it. */}
      <Tooltip.Trigger<"button">
        aria-label={subject ? `About ${subject}` : "What this means"}
        className="text-muted hover:text-foreground focus-visible:ring-accent inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle transition-colors focus-visible:ring-2 focus-visible:outline-none"
        render={(props) => <button {...props} type="button" />}
      >
        <svg
          aria-hidden="true"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
        </svg>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-64 text-xs">{children}</Tooltip.Content>
    </Tooltip>
  );
}
