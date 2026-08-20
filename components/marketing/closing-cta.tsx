import Link from "next/link";

import { MarketingContainer } from "./section";

/**
 * Section 7 — the closing CTA.
 *
 * CENTRED, and it is the only centred block on the page. Every section above it
 * is left-aligned with a `max-w-2xl` header, which is what makes the page read as
 * one document; breaking that alignment exactly once, at the end, is what marks
 * the end. A second centred block anywhere above this would spend the effect.
 *
 * Two destinations because there are two audiences, and the accent goes to the
 * caller's path rather than the creator's: a marketplace with no callers has
 * nothing to pay a creator with.
 *
 * THE GLOW IS A SIBLING OF THE PANEL, NOT A CHILD, AND THAT IS THE WHOLE REASON
 * THE GLASS WORKS HERE. `backdrop-filter` samples what is painted *behind* an
 * element within its stacking context — it cannot see the element's own
 * children. With the wash nested inside, the panel would have been blurring the
 * flat page background: a promoted compositor layer bought for no visible effect,
 * which is exactly the objection `globals.css` answers when it says the filter is
 * spent only on surfaces that sit over varying content. As siblings under one
 * `isolate`, the panel genuinely refracts the gradient, and the wash gets to
 * bleed past the panel's corners instead of being clipped square by them.
 */
export function ClosingCta() {
  return (
    // NO `overflow-x-clip` ANY MORE, and its removal is the fix rather than a
    // relaxation. The wash used to be a rectangle painted with radial gradients
    // and inset −10% horizontally; clipping it at this container's `max-w-6xl`
    // edge sliced the gradient before it had faded, drawing a visible hard-edged
    // box across the page under the creator section. A blurred ellipse has no
    // edge to slice, is positioned entirely inside the container, and spreads
    // only as ink overflow — which never produces a scrollbar. Nothing left to
    // clip.
    // `bg-background` for the same reason the hero has it: `isolate` plus a
    // transparent ground would leave the grain overlay with no backdrop to blend
    // against, and it would draw itself as a box. See `.grain-overlay`.
    <MarketingContainer className="bg-background relative isolate py-16 sm:py-24">
      <div
        aria-hidden
        className="glow-blob pointer-events-none -z-20 h-[18rem] w-[28rem] top-[2rem] right-[6rem]"
      />
      <div aria-hidden className="grain-overlay pointer-events-none -z-10" />

      <div className="glass border-border flex flex-col items-center gap-6 rounded-2xl border px-6 py-14 text-center sm:px-12">
        <h2 className="max-w-2xl text-2xl leading-[1.15] font-semibold tracking-[-0.03em] sm:text-3xl">
          Change two lines and call a model nobody else hosts
        </h2>
        <p className="text-muted max-w-xl text-base leading-[1.6]">
          Prepaid balance, no card to start, and a runaway loop cannot invoice you.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 pt-1">
          <Link
            className="bg-accent text-accent-foreground focus-visible:ring-accent inline-flex h-10 items-center rounded-full px-5 text-sm font-medium transition-opacity duration-[--motion-fast] hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
            href="/signup"
          >
            Get an API key
          </Link>
          <Link
            className="border-border text-foreground hover:bg-surface-tertiary focus-visible:ring-accent inline-flex h-10 items-center rounded-full border px-5 text-sm font-medium transition-colors duration-[--motion-fast] focus-visible:ring-2 focus-visible:outline-none"
            href="/studio/new"
          >
            Deploy a model
          </Link>
        </div>
      </div>
    </MarketingContainer>
  );
}
