/**
 * The publish half of the licence gate (#29, §5.1) — pure, and deliberately
 * separate from the schema half.
 *
 * The SCHEMA is what makes the rule true: `custom_models_public_needs_license`
 * refuses a public listing whose weights have no established terms, on every
 * write, from every code path. This module exists because a constraint
 * violation is not an answer a creator can act on. It decides the same question
 * one step earlier so the deploy pipeline can leave the listing private, say
 * which of the four cases it is in, and say what would change it.
 *
 * The two must agree. If they ever disagree the CHECK wins — which is the right
 * failure mode, but it surfaces as `insert_failed` with a constraint name in it,
 * so the pgTAP file asserts the predicate on both sides.
 *
 * PURE, like card.ts: no clock, no client, no `server-only`. The form imports it
 * to decide whether to ask for an acknowledgement at all.
 */

import type { CommercialHosting } from "@nexus/hf-probe";

/** Why a listing the creator asked to publish was left private. */
export type LicenseHold =
  /** Conditional terms, and nothing was acknowledged. */
  | "acknowledgement_required"
  /** Something was acknowledged, and it was not the text in force. */
  | "acknowledgement_stale"
  /** The weights may not be served commercially by a third party at all. */
  | "hosting_prohibited"
  /** Nobody has established what these weights permit. */
  | "terms_unknown";

export interface LicenseGateInput {
  /** `custom_models.license_hosting` — the STRICTEST reading over the base model and its ancestors. */
  hosting: CommercialHosting;
  /** `custom_models.license_terms_version` — the identity of the licence text in force. */
  termsVersion: string | null;
  /** The creator asked for a public listing. */
  wantsPublic: boolean;
  /**
   * The terms identity the creator was SHOWN and accepted, or null if they were
   * not asked or did not accept. Compared against `termsVersion` rather than
   * trusted: an acknowledgement of a document other than the one in force is
   * not an acknowledgement, and the form learns the licence from the repository
   * while the gate reads it from the resolved base model — the two can differ
   * precisely when a quant repo's card disagrees with the weights underneath it.
   */
  acknowledgedVersion: string | null;
}

export interface LicenseGateDecision {
  publish: boolean;
  /**
   * What to record in `license_ack_version` — the version the platform can
   * prove was in force, never the string the client sent.
   */
  ackVersion: string | null;
  hold: LicenseHold | null;
  /** One sentence for the creator. Null when nothing is being held. */
  message: string | null;
  /** What would change the answer. Null when nothing is being held. */
  hint: string | null;
}

const PRIVATE_BY_REQUEST: LicenseGateDecision = {
  publish: false,
  ackVersion: null,
  hold: null,
  message: null,
  hint: null,
};

/**
 * Decide whether this listing may be published, and record what was
 * acknowledged if it may.
 *
 * A creator who did not ask for a public listing is never held: a private
 * deployment of prohibited weights is the creator spending their own money on
 * their own compute, which §5.1 permits explicitly, and reporting a licence
 * problem to somebody who never tried to publish is noise.
 */
export function evaluateLicenseGate(input: LicenseGateInput): LicenseGateDecision {
  if (!input.wantsPublic) return PRIVATE_BY_REQUEST;

  switch (input.hosting) {
    case "allowed":
      return { publish: true, ackVersion: null, hold: null, message: null, hint: null };

    case "conditional": {
      if (input.termsVersion === null) {
        // A conditional verdict with no licence recorded is a conclusion with
        // no premise. Fail closed: there is nothing a creator could accept.
        return {
          publish: false,
          ackVersion: null,
          hold: "terms_unknown",
          message:
            "These weights are hosted under conditions, but no licence document is on record for them.",
          hint: "The listing is deployed and private. It will publish once the licence in force is recorded.",
        };
      }
      if (input.acknowledgedVersion === null) {
        return {
          publish: false,
          ackVersion: null,
          hold: "acknowledgement_required",
          message: `This model's licence (${input.termsVersion}) permits commercial hosting subject to conditions you have to accept.`,
          hint: "The listing is deployed and private. Accept the licence conditions to publish it.",
        };
      }
      if (input.acknowledgedVersion !== input.termsVersion) {
        return {
          publish: false,
          ackVersion: null,
          hold: "acknowledgement_stale",
          message: `You accepted ${input.acknowledgedVersion}, and the licence in force for these weights is ${input.termsVersion}.`,
          hint: "The listing is deployed and private. Re-read the licence that actually governs the weights and accept that one.",
        };
      }
      return {
        publish: true,
        ackVersion: input.termsVersion,
        hold: null,
        message: null,
        hint: null,
      };
    }

    case "prohibited":
      return {
        publish: false,
        ackVersion: null,
        hold: "hosting_prohibited",
        message:
          "This model's licence does not permit a third party to serve it commercially, so it cannot be listed in the marketplace.",
        hint: "The listing is deployed and private: it is callable with your own API keys, metered and billed to you at the prices you set.",
      };

    case "unknown":
      return {
        publish: false,
        ackVersion: null,
        hold: "terms_unknown",
        message:
          "We could not establish what this model's licence permits, so it is not listed yet.",
        hint: "The listing is deployed and private, and is queued for review. It publishes by itself once the terms are established.",
      };
  }
}

/**
 * The same hold, said to somebody looking at a listing that already exists.
 *
 * `evaluateLicenseGate`'s hints are written for the deploy form, where the
 * acknowledgement checkbox is on screen and "accept the conditions" names a
 * control the creator can see. On the My Models page there is no such control:
 * `license_ack_*` is platform-written and pinned out of the creator's RLS
 * policy, and no post-deploy acceptance surface exists yet. Saying "accept the
 * conditions" there would point at nothing, so this says what is actually true.
 */
export function holdHintForListing(hold: LicenseHold): string {
  switch (hold) {
    case "acknowledgement_required":
      return "The licence conditions are accepted as part of deploying, and there is no post-deploy acceptance yet — re-deploying this repository with the box ticked is what publishes it.";
    case "acknowledgement_stale":
      return "The licence in force has been revised since it was accepted. Re-deploying against the current text is what publishes it.";
    case "hosting_prohibited":
      return "It stays callable with your own API keys, metered and billed to you. It cannot be listed.";
    case "terms_unknown":
      return "It is queued for review and publishes by itself once the terms are established.";
  }
}

/**
 * Whether the form should ask for an acknowledgement, from what the PROBE saw.
 *
 * Approximate on purpose, and the asymmetry matters: the probe reads the
 * repository's own card and the gate reads the resolved base model, so this can
 * ask for an acknowledgement the gate does not need (harmless — the pipeline
 * ignores it) but it can also miss one the gate does need (the listing deploys
 * private and says why). Presenting the form's reading as the verdict is what
 * would be wrong.
 */
export function acknowledgementMayBeRequired(
  hosting: CommercialHosting | null | undefined,
): boolean {
  return hosting === "conditional";
}
