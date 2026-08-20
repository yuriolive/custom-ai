/**
 * The words the `official` badge is allowed to say (GitHub #30).
 *
 * Copy lives here rather than beside the component for one reason: it is the
 * part of this feature that can go wrong without anything failing. A badge that
 * over-claims is a working badge that misleads, and `npm test` reaches `lib/`
 * while it does not reach `components/`. The assertions in
 * `provenance.test.ts` are what stop a well-meaning edit turning a statement
 * about a REPOSITORY into a statement about WEIGHTS.
 *
 * ── The two states are peers ───────────────────────────────────────────────
 * `official` and `third-party` are the same pill in the same colour at the same
 * size, and the copy for neither one apologises. Third-party hosting is the
 * normal condition of a marketplace that works — a catalog where every listing
 * is served by its author is a catalog with six entries in it. The neutral state
 * is named out loud precisely so that its absence of a badge reads as a fact
 * rather than as a missing endorsement.
 *
 * ── The limit, stated in the UI's own terms ────────────────────────────────
 * Hugging Face sign-in proves control of an HF ACCOUNT. It does not prove
 * authorship: any member of an org can push a repo they did not train. So the
 * copy says "owns the repository" and never "made", "trained", "verified
 * author", or anything that would let a reader treat the badge as a quality or
 * trust signal. It is not one, and it never feeds a price, a rank or a payout.
 */

export type ProvenanceState = "official" | "third-party";

export function provenanceState(isOfficial: boolean): ProvenanceState {
  return isOfficial ? "official" : "third-party";
}

/**
 * The pill label. Lowercase, because it sits in the same outline-pill row as the
 * capability chips (DESIGN.md §3.2) and title case there reads as a heading.
 */
export function provenanceLabel(isOfficial: boolean): string {
  return isOfficial ? "official" : "third-party";
}

/**
 * The hover/`title` sentence, and the accessible description.
 *
 * Both halves name the same fact — who owns the upstream repository — so a
 * reader comparing two cards is comparing one axis, not a badge against a
 * shrug. The official half carries the limit inline, because the tooltip is the
 * only place a card-sized surface can carry it at all.
 */
export function provenanceDescription(isOfficial: boolean): string {
  return isOfficial
    ? "Official — this creator's Hugging Face account owns the upstream repository. " +
        "Hugging Face sign-in proves control of that account, not authorship of the weights."
    : "Third-party host — served by a creator who doesn't own the upstream Hugging Face " +
        "repository. Normal for a marketplace, and not a quality signal either way.";
}

/**
 * The longer form for the model page, where there is room to say what the badge
 * is worth and, more importantly, what it is not worth.
 */
export function provenanceNote(isOfficial: boolean): string {
  return isOfficial
    ? "The Hugging Face account behind this listing owns the repository the weights come " +
        "from. That is a fact about a Hugging Face account, not about who trained the " +
        "model: an organisation member can publish a repository they had no hand in. It " +
        "affects nothing about how this model is priced, ranked or paid out."
    : "This model is hosted by a creator who doesn't own the upstream Hugging Face " +
        "repository. That is the ordinary way a marketplace works, and it changes nothing " +
        "about what you get: the same measured throughput, the same context window, the " +
        "same prices, listed under the same rules.";
}
