/**
 * What a `conditional` licence asks of the platform and of the caller — as
 * CONTENT, not as a checkbox.
 *
 * The distinction is the whole point of this module. A checkbox that
 * acknowledges an obligation the UI then fails to discharge is worse than no
 * checkbox, because it documents that we knew: the record says the obligation
 * was read, and the page it was read on never showed the notice the licence
 * asked for. So the attribution string below is RENDERED, prominently, on the
 * page that serves the weights — and the obligations that pass through to
 * whoever calls the model are spelled out beside it in the words the licence
 * uses.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────
 * It is NOT the gate. Whether a licence may publish at all — `unknown` never
 * auto-publishing, `prohibited` never listing, the stale-ack comparison against
 * `base_models.license_version` — is #29's decision, on the write path. This is
 * a read: it renders what the columns say, and says plainly when they say
 * nothing.
 *
 * It is also NOT legal advice, and the copy never implies it is. Every notice
 * points at the licence text as the authority, because a summary that reads as
 * definitive is the failure mode here: a developer who relies on our paraphrase
 * instead of the licence is worse off than one we sent to the source.
 *
 * Pure and dependency-free so `node --test` can load it; `.ts` extensions on the
 * relative imports for that reason (see the header of `format.ts`).
 */

import type { BaseModelInfo, CommercialHosting } from "./types.ts";

/**
 * The licence families whose obligations are specific enough to state.
 *
 * Two, and adding a third is a deliberate act of reading a licence — not a
 * pattern match. Everything else `conditional` falls to the generic notice,
 * which says honestly that there are conditions and points at the text. A guess
 * dressed as a specific obligation is the one output this module must never
 * produce: naming the wrong attribution string is a licence breach performed
 * confidently.
 */
type LicenceFamily = "llama" | "gemma";

/**
 * Family from the licence's OWN fields, never from the model's name.
 *
 * A fine-tune called `my-llama-experiment` under Apache-2.0 owes Meta nothing,
 * and a Llama derivative renamed to hide its lineage owes exactly as much as one
 * that did not. `license_id` is the Hugging Face licence slug (`llama3.1`,
 * `gemma`), and `license_name` is the human string; both are checked because a
 * repo routinely fills one and not the other.
 */
export function licenceFamily(model: {
  licenseId: string | null;
  licenseName: string | null;
}): LicenceFamily | null {
  const haystack = `${model.licenseId ?? ""} ${model.licenseName ?? ""}`.toLowerCase();
  if (haystack.includes("llama")) return "llama";
  if (haystack.includes("gemma")) return "gemma";
  return null;
}

/**
 * The four postures, in one honest sentence each.
 *
 * `unknown` is the interesting one and it is deliberately not reassuring: the
 * platform genuinely has not read the licence, and a shopper choosing weights
 * for a commercial product needs to know that rather than to be told nothing.
 */
const POSTURE_NOTE: Readonly<Record<CommercialHosting, string>> = {
  allowed:
    "This licence permits a third party to serve these weights commercially, with no " +
    "conditions attached to your use of the output.",
  conditional:
    "This licence permits commercial hosting, but it attaches conditions that pass " +
    "through to you. They are listed below; the licence itself is the authority.",
  prohibited:
    "This licence does not permit a third party to serve these weights for money. It " +
    "is listed here because the platform has not yet acted on that — do not build on " +
    "this listing.",
  unknown:
    "The platform has not resolved this model's licence. Nobody has checked whether " +
    "these weights may be served commercially, so read the upstream repository before " +
    "you depend on this listing.",
};

export function licencePostureNote(hosting: CommercialHosting): string {
  return POSTURE_NOTE[hosting];
}

/** The short label beside the heading. */
const POSTURE_LABEL: Readonly<Record<CommercialHosting, string>> = {
  allowed: "Commercial use permitted",
  conditional: "Commercial use with conditions",
  prohibited: "Commercial use not permitted",
  unknown: "Licence unresolved",
};

export function licencePostureLabel(hosting: CommercialHosting): string {
  return POSTURE_LABEL[hosting];
}

/**
 * The obligations a `conditional` licence attaches, as renderable content.
 *
 * `attribution` is the string the licence requires be DISPLAYED — the page shows
 * it verbatim, which is the platform discharging its own half. `derivativeNaming`
 * and `passThrough` are what the licence hands to whoever calls the model, and
 * they are stated because a caller who learns about them after shipping learns
 * about them from a lawyer.
 */
export type LicenceObligations = {
  /** Verbatim attribution the licence requires on display, or null. */
  attribution: string | null;
  /** The derivative-naming rule, in the licence's terms. Null where none exists. */
  derivativeNaming: string | null;
  /** Conditions that pass through to a caller of this model. */
  passThrough: string[];
};

/**
 * Obligations for a model, or null when there are none to state.
 *
 * Null covers two different situations and the UI must not conflate them: a
 * permissive licence (nothing is owed) and an unresolved one (nothing is KNOWN).
 * `licencePostureNote` is what separates them, and the section renders it either
 * way.
 */
export function licenceObligations(model: BaseModelInfo): LicenceObligations | null {
  if (model.commercialHosting !== "conditional") return null;

  switch (licenceFamily(model)) {
    case "llama":
      return {
        // The licence asks for this string, prominently, on anything that makes
        // the model available. Serving it over an API is making it available, so
        // it is our line to display and not only the caller's.
        attribution: "Built with Llama",
        derivativeNaming:
          'If you train a new model on this one\'s output, its name must begin with "Llama".',
        passThrough: [
          'Display "Built with Llama" wherever you make a product built on this model available.',
          "Pass the Llama licence and Meta's Acceptable Use Policy on to anyone you " +
            "redistribute the model or a derivative to.",
          "If your product had more than 700 million monthly active users on the licence's " +
            "effective date, you must request a separate licence from Meta before using it.",
        ],
      };
    case "gemma":
      return {
        attribution: "Gemma",
        derivativeNaming: null,
        passThrough: [
          "Pass the Gemma Terms of Use on to anyone you distribute the model or a " +
            "derivative to, and include the same use restrictions.",
          "Google's Gemma Prohibited Use Policy applies to your use of the output.",
          "State that the model has been modified if you distribute a modified version.",
        ],
      };
    default:
      return {
        attribution: null,
        derivativeNaming: null,
        // Deliberately one line, and deliberately not a paraphrase: the platform
        // knows the licence attaches conditions (that is what `conditional`
        // means) and does not know which. Inventing them would be the failure
        // this module's header names.
        passThrough: [
          "This licence attaches conditions the platform has not itemised. Read it before " +
            "you build on this model — the obligations are yours as well as ours.",
        ],
      };
  }
}

/**
 * "Llama 3.1 Community License (rev. 3.1)" — name, or id, plus the revision.
 *
 * The version is in the label rather than in a footnote because it is the thing
 * that makes an acknowledgement meaningful: the Llama community licence has been
 * revised more than once, and a page citing "the Llama licence" with no revision
 * cites whichever one the reader remembers.
 */
export function licenceLabel(model: BaseModelInfo): string | null {
  const name = model.licenseName ?? model.licenseId;
  if (!name) return null;
  return model.licenseVersion ? `${name} (rev. ${model.licenseVersion})` : name;
}
