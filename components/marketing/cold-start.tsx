import { SNIPPET_TIMEOUT_SECONDS } from "@/components/marketplace/snippets";
import { MEASURED } from "@/lib/measured";

import { Section } from "./section";

/**
 * Section 4 — the tradeoff (docs/UI-REDESIGN-PLAN.md §4, and NON-NEGOTIABLE
 * there).
 *
 * Models scale to zero, so a first request can take up to two minutes. A
 * developer who meets that by surprise — after a snippet appears to hang for
 * ninety seconds — concludes the product is broken and never comes back. That
 * argument was made at length in the `HomeIntro` component this page replaced,
 * and it was right; this section is where it now lives.
 *
 * WHAT CHANGED IS THE FORM, NOT THE HONESTY. It used to be a full-width
 * `Alert status="warning"` above the catalog: an amber banner, six sentences, the
 * loudest element on the front page. Amber is the colour of "something is wrong",
 * and spending it on the property that makes the product cheap framed the pitch
 * as a defect notice. It is now three plain columns under a normal section
 * heading — the number is still stated at its worst (~100 s, not "usually fast"),
 * the timeout is still the explicit instruction, and nothing is softened. Only
 * the alarm is gone.
 *
 * The figures are not duplicated from the proof strip: that strip states the
 * worst case as a headline number, and this section explains it. Changing one
 * without the other is the drift to watch for — and it had already happened once.
 * Both said "well under a second" for the warm case while `docs/HANDOFF.md` had
 * 926 ms recorded as a MISS against the 400 ms target, and both said ~100s for a
 * cold start measured at 115. Both now interpolate `MEASURED` (`lib/measured.ts`)
 * rather than restating it, so the drift is no longer possible.
 */
export function ColdStart() {
  return (
    <Section
      eyebrow="The tradeoff"
      id="cold-start"
      lede="Nothing here runs on an idle GPU waiting for you — which is exactly why a 27B model costs cents instead of dollars an hour. The bill for that is the first call."
      title="Models sleep. The first call wakes one up."
    >
      <div className="border-border grid gap-8 border-y py-10 sm:grid-cols-3">
        <Phase
          figure={`${MEASURED.coldStartSeconds}s`}
          label="Cold, worst case"
          body={`No traffic for a while, so there is no worker. The next request starts one and loads the weights before it can emit a token. That is the measured first-ever start; ${MEASURED.warmVolumeStartSeconds} seconds once the weights are cached.`}
        />
        <Phase
          figure={`${MEASURED.warmTtftMs}ms`}
          label="Warm, first token"
          body={`Measured p50 once a worker is up — under a second, and short of our own 400ms target, which we are recording rather than rounding. It then streams at the measured ${MEASURED.decodeTokensPerSecond} tok/s until it goes idle again.`}
        />
        <Phase figure={`${SNIPPET_TIMEOUT_SECONDS}s`} label="Set your timeout to">
          <span className="block">
            Every snippet on this site already does. Treat the first call of a session as a warm-up
            rather than a benchmark, and the tradeoff never bites.
          </span>
        </Phase>
      </div>
    </Section>
  );
}

function Phase({
  figure,
  label,
  body,
  children,
}: Readonly<{ figure: string; label: string; body?: string; children?: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
        {figure}
      </span>
      <span className="text-muted font-mono text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </span>
      <p className="text-muted max-w-[34ch] text-sm leading-[1.55]">{body}</p>
      {children ? (
        <p className="text-muted max-w-[34ch] text-sm leading-[1.55]">{children}</p>
      ) : null}
    </div>
  );
}
