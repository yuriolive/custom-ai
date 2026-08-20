import { MEASURED } from "./measured";
import { MarketingContainer } from "./section";

/**
 * The proof strip (docs/UI-REDESIGN-PLAN.md §4, section 2).
 *
 * Shape is orcarouter.ai's: a row of figures, each with a muted label and a
 * smaller caption underneath that qualifies it. The caption is what makes the
 * pattern honest rather than decorative — a bare "75.5%" asserts something a
 * reader cannot check, and a caption that says what it was measured against
 * turns it into a claim someone can argue with.
 *
 * EVERY FIGURE HERE IS MEASURED OR CONTRACTUAL, AND THE CAPTION SAYS WHICH.
 *
 * THE COLD START WAS WRONG AND IS NOW RIGHT. This strip claimed "~100s" and said
 * warm calls answer "well under a second". `docs/HANDOFF.md` measured 115 s for a
 * first-ever start and records warm TTFT p50 at 926 ms as a MISS against
 * NFR-CS-002's 400 ms target — "recorded as a miss, not restated to match what we
 * measured". 926 ms is not well under a second, and 100 is not the worst case.
 * Both are now stated as measured, which is the only version of this strip worth
 * having: the whole argument below is that a figure a reader cannot check is
 * worthless, and a figure that flatters us is worse than worthless.
 * The numbers come from `docs/HANDOFF.md` ("measured facts worth not
 * re-deriving") and from the 80/20 split the schema enforces. Nothing on this
 * strip is aspirational, and nothing rounds in our favour — the cold start is
 * stated at its worst, not its best, because a visitor who meets it by surprise
 * concludes the product is broken (the argument the replaced `HomeIntro` made at
 * length, and it is right).
 *
 * NO HARDWARE VOCABULARY (DESIGN.md §4 item 8). "Idle" and "worker", never a
 * GPU name — this is a consumer surface.
 */

type Figure = Readonly<{ value: string; label: string; caption: string }>;

const FIGURES: readonly Figure[] = [
  {
    value: "80%",
    label: "To the creator",
    caption: "of every bill, settled per request — not a revenue-share paid out quarterly.",
  },
  {
    value: "$0",
    label: "While idle",
    caption: "models scale to zero, so nothing accrues between your requests.",
  },
  {
    value: "2 lines",
    label: "To switch",
    caption: "the base URL and the model id in the OpenAI client you already have.",
  },
  {
    // Read from `MEASURED`, not typed here. The comment above promises these
    // figures are measured; interpolating them is what makes that true rather
    // than aspirational, and it is why this strip and the cold-start section can
    // no longer drift apart.
    value: `${MEASURED.coldStartSeconds}s`,
    label: "First call, worst case",
    caption: `the measured first-ever start of a sleeping model — ${MEASURED.warmVolumeStartSeconds}s once its weights are cached, then under a second warm.`,
  },
] as const;

export function ProofStrip() {
  return (
    <MarketingContainer>
      <dl className="border-border grid gap-8 border-y py-10 sm:grid-cols-2 lg:grid-cols-4">
        {FIGURES.map((figure) => (
          <div className="flex flex-col gap-1.5" key={figure.label}>
            {/* `tabular-nums` on every figure so the row does not shimmer if one
                of these ever becomes live data. */}
            <dd className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
              {figure.value}
            </dd>
            <dt className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
              {figure.label}
            </dt>
            <p className="text-muted max-w-[26ch] text-sm leading-[1.5]">{figure.caption}</p>
          </div>
        ))}
      </dl>
    </MarketingContainer>
  );
}
