import Link from "next/link";

import { MarketingContainer } from "./section";

/**
 * The landing hero (docs/UI-REDESIGN-PLAN.md §4, section 1).
 *
 * SHAPE is Resend's — announcement pill, left-aligned display heading, a
 * two-line subhead, one filled CTA beside one plain text link, then a line of
 * microcopy. SCALE is not: theirs is 96px in a licensed serif (`domaine`), and
 * `DESIGN.md` §4 item 1 rules out both the face and a lookalike. Ours is Inter
 * at weight 500 with tracking pulled to −0.035em, which is where a single
 * well-set face gets its character. `clamp()` tops out at 4rem — past that,
 * Inter at 500 starts to look like a heading that wanted to be something else.
 *
 * Server Component, plain markup: no `@heroui/react` (PRD §4.1.0), so the
 * largest text on the site is in the initial HTML.
 */
export function Hero({ modelCount }: Readonly<{ modelCount: number | null }>) {
  return (
    <MarketingContainer className="pt-16 pb-8 sm:pt-24 sm:pb-12">
      <div className="flex max-w-3xl flex-col items-start gap-6">
        {/* The announcement pill. A real link, not a decorative chip — a pill
            that looks pressable and is not is a small lie that costs trust on
            the first thing a visitor sees. */}
        <Link
          className="border-border bg-surface-secondary text-muted hover:text-foreground focus-visible:ring-accent inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          href="/models"
        >
          <span className="bg-accent size-1.5 rounded-full" />
          OpenAI-compatible · pay per token
          <span aria-hidden>›</span>
        </Link>

        <h1 className="text-[clamp(2.25rem,6vw,4rem)] leading-[1.05] font-medium tracking-[-0.035em]">
          Run the open models nobody else hosts
        </h1>

        <p className="text-muted max-w-2xl text-lg leading-[1.6]">
          Quantized, uncensored, fine-tuned — whatever the big providers will not carry. Every model
          answers at one endpoint your OpenAI client already knows how to call. You pay per token,
          with no hourly bill and no minimum.
        </p>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          {/* Anchors, not Buttons: HeroUI v3's Button is a React Aria <button>
              and takes no href (DESIGN.md §6 item 15). */}
          <Link
            className="bg-accent text-accent-foreground focus-visible:ring-accent inline-flex h-10 items-center rounded-full px-5 text-sm font-medium transition-opacity duration-[--motion-fast] hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
            href="/signup"
          >
            Get an API key
          </Link>
          <Link
            className="text-foreground hover:text-accent focus-visible:ring-accent rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            href="/models"
          >
            {/* The count is real or the phrase is generic. A hardcoded "200+"
                on a catalog holding three rows is the first thing a developer
                checks and the first thing that loses them. */}
            {modelCount && modelCount > 0
              ? `Browse ${modelCount} ${modelCount === 1 ? "model" : "models"} →`
              : "Browse the catalog →"}
          </Link>
        </div>

        <p className="text-muted text-sm">
          Prepaid balance · no card to start · 80% of every bill goes to the model’s creator
        </p>
      </div>
    </MarketingContainer>
  );
}
