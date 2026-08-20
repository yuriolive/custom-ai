/**
 * The measured facts the UI is allowed to print.
 *
 * IN `lib/`, NOT `components/marketing/`, because it stopped being a marketing
 * concern the moment a second component tree needed it: `snippet-tabs.tsx` makes
 * the same cold-start and warm-latency claims on the model card and the model
 * detail page. Importing marketing into marketplace would be the wrong dependency
 * direction — marketplace is what marketing is built on.
 *
 * ONE PLACE, so the hero, the proof strip, the cold-start section and the snippet
 * notes cannot disagree with each other. They had already drifted: three of them
 * said warm calls answer "well under a second" while `docs/HANDOFF.md` recorded
 * 926 ms as a MISS against NFR-CS-002's 400 ms target, and two quoted "~100s" for
 * a cold start measured at 115.
 *
 * SOURCE IS `docs/HANDOFF.md` — its "measured facts worth not re-deriving" table
 * and its "known-open, deliberately" list. Nothing here is rounded in our favour,
 * and two of these are deliberately worse than the copy they replaced:
 *
 *  - The cold start is 115 s, the first-ever start of a model with a cold weights
 *    Volume. 23 s is what it costs once that Volume is warm, and it is stated too
 *    — leaving it out would be pessimistic in the other direction. Quoting the
 *    smaller number as the worst case is the exact mistake that makes a visitor
 *    who meets the real one conclude the product is broken.
 *  - Warm TTFT p50 is 926 ms and HANDOFF is explicit about it: "recorded as a
 *    miss, not restated to match what we measured". So the page says "under a
 *    second" and never "instantly".
 *  - Decode is 14 tok/s on the measured tier.
 *
 * A figure changed here must be changed in HANDOFF first, not the other way round.
 */
export const MEASURED = {
  /** Seconds, first-ever start of a model with a cold weights Volume. */
  coldStartSeconds: 115,
  /** Seconds, start when the weights Volume is already warm. */
  warmVolumeStartSeconds: 23,
  /** Milliseconds, warm time-to-first-token, p50. A known NFR-CS-002 miss. */
  warmTtftMs: 926,
  /** Output tokens per second, measured over the decode window. */
  decodeTokensPerSecond: 14,
  /** Input tokens per second during prefill. */
  prefillTokensPerSecond: 133,
} as const;
