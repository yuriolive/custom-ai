import Link from "next/link";

import { HeroTerminal } from "./hero-terminal";
import { MarketingContainer } from "./section";

/**
 * The landing hero (docs/UI-REDESIGN-PLAN.md §4, section 1).
 *
 * SHAPE is Resend's — announcement pill, left-aligned display heading, a two-line
 * subhead, one filled CTA beside one plain text link, then a line of microcopy,
 * with the artifact in a second column. SCALE is not: theirs is 96px in a licensed
 * serif (`domaine`), and `DESIGN.md` §4 item 1 rules out both the face and a
 * lookalike. Ours is Inter at weight 500 with tracking pulled to −0.035em, which
 * is where a single well-set face gets its character. `clamp()` tops out at 4rem —
 * past that, Inter at 500 starts to look like a heading that wanted to be
 * something else.
 *
 * THE HEADING FADES rather than being coloured. Resend's does the same thing, and
 * it is the cheapest way to give a grotesque some presence at display size:
 * `bg-clip-text` over a `--foreground` → `--muted` ramp. Colouring half the
 * heading accent-green — Modal's move — would put a second green element in the
 * viewport beside the CTA, and the CTA is the one that has to win.
 *
 * THE SUBHEAD IS TWO LINES BECAUSE THAT IS THE BUDGET. This hero previously ran to
 * three sentences and the page it opened carried four more paragraphs plus a
 * full-width warning banner above the catalog — the "muito texto" the refresh was
 * asked for. Everything cut from here still exists: the split moved to the
 * microcopy line, the cold start to its own section, and the how-it-works steps to
 * the creator section. Do not grow this back.
 *
 * THE ARTIFACT IS A RUNNING REQUEST, and it took four candidates to get there.
 * The first was a 3D cube lattice, which this page's own rules already forbade:
 * `DESIGN.md` §4 item 4 bans decoration and `UI-REDESIGN-PLAN.md` §2.5 asks every
 * section for "a **product artifact**. Never an illustration." A wake-curve chart,
 * a typographic endpoint specimen and an artifact-free centred hero were built and
 * compared alongside it; the terminal won because it is the only one that shows
 * the whole product at once — an OpenAI-compatible call, the cold start stated
 * rather than hidden, tokens streaming, and one usage row settling with the split.
 *
 * Server Component except for the artifact: `HeroTerminal` is the only client
 * component in here, so the heading — the largest text on the site — is always in
 * the initial HTML.
 */
export function Hero({
  modelCount,
  baseUrl,
}: Readonly<{ modelCount: number | null; baseUrl: string }>) {
  return (
    // `overflow-x-clip`, not `overflow-x-hidden`: `clip` does not create a scroll
    // container, so it contains the glow layers' deliberate overhang past 100vw
    // without turning every ancestor-relative `sticky` below it into a no-op —
    // which is exactly what putting `hidden` on the layout root did to the nav.
    // `-x-` only, so nothing vertical is cut.
    //
    // `bg-background` IS LOAD-BEARING, not a repeat of the page colour for its own
    // sake. `isolate` makes this a stacking context, and the `.grain-overlay`
    // below blends against whatever is painted beneath it INSIDE that context —
    // which, with a transparent ground, is nothing, so the grain would paint its
    // own mid-grey as a visible rectangle. Painting the ground here gives the
    // blend something to work on.
    <div className="bg-background relative isolate overflow-x-clip">
      <div aria-hidden className="hero-grid pointer-events-none -z-20" />
      {/* Blurred ellipses rather than a gradient-filled rectangle. The rectangle
          version drew a visible hard edge wherever it was clipped by a narrower
          container — see the `.glow-blob` note in `globals.css`. Here the overhang
          is past the VIEWPORT edge, so the wrapper's `overflow-x-clip` is what
          stops it becoming a horizontal scrollbar. */}
      <div
        aria-hidden
        className="glow-blob pointer-events-none -z-20 h-[30rem] w-[44rem] top-[-10rem] right-[-8rem]"
      />
      <div
        aria-hidden
        className="glow-blob pointer-events-none -z-20 h-[22rem] w-[30rem] top-[-6rem] left-[-10rem] opacity-60"
      />
      {/* Grain over the washes, at `-z-10` so it sits above them and below the
          copy. Graining the type as well would cost legibility for nothing — the
          banding this fixes is in the gradients, and they are all below this. */}
      <div aria-hidden className="grain-overlay pointer-events-none -z-10" />

      <MarketingContainer className="pt-14 pb-10 sm:pt-20 sm:pb-16">
        {/* `grid-cols-[minmax(0,1fr)]` on the BASE breakpoint, not only at `lg:`.
            Without it the sub-`lg` single column is an `auto` track, an `auto`
            track is at least `min-content` wide, and this grid's `min-content` is
            set by the terminal's longest unbreakable line — the gateway base URL.
            `minmax(0, …)` is what lets a track be narrower than its content and
            hands the overflow back to the panel, which scrolls internally. */}
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-10">
          <div className="flex max-w-2xl flex-col items-start gap-6">
            {/* The announcement pill. A real link, not a decorative chip — a pill
                that looks pressable and is not is a small lie that costs trust on
                the first thing a visitor sees. */}
            <Link
              className="glass border-border text-muted hover:text-foreground focus-visible:ring-accent inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              href="/models"
            >
              <span className="bg-accent size-1.5 rounded-full" />
              OpenAI-compatible · pay per token
              <span aria-hidden>›</span>
            </Link>

            <h1 className="from-foreground to-muted bg-gradient-to-br bg-clip-text text-[clamp(2.25rem,6vw,4rem)] leading-[1.05] font-medium tracking-[-0.035em] text-transparent">
              Run the open models nobody else hosts
            </h1>

            <p className="text-muted max-w-xl text-lg leading-[1.6]">
              Quantized, uncensored, fine-tuned — whatever the big providers will not carry, behind
              one endpoint your OpenAI client already knows how to call.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-1">
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
              No card to start · pay per token · 80% of every bill goes to the model’s creator
            </p>
          </div>

          <HeroTerminal baseUrl={baseUrl} />
        </div>
      </MarketingContainer>
    </div>
  );
}
