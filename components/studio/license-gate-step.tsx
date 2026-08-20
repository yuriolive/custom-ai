"use client";

/**
 * The publish half of the licence gate, at the point of decision (#29 §5.1).
 *
 * It renders next to the visibility switch and nowhere else, because that is the
 * only control it changes the meaning of: everything here is about being LISTED.
 * A private deployment is unaffected by any of it — the creator is spending
 * their own money on their own compute, which is theirs to decide.
 *
 * WHAT IT IS NOT: the verdict. This reads the licence the REPOSITORY declares,
 * and the gate reads the resolved base model's — which is the stricter of the
 * repository's own claim and its ancestors', because a quantization saying
 * `apache-2.0` does not relicense the Llama weights underneath it. So the copy
 * below says what will be asked and why, and never promises an outcome. The
 * server decides, and says what it decided.
 *
 * The acknowledgement is a CHECKBOX and not a click-through modal on purpose: it
 * has to be re-readable while the creator is still deciding, and it has to be
 * possible to deploy without accepting — privately, which is the honest
 * alternative to accepting terms you have not read.
 */

import { Alert, Checkbox } from "@heroui/react";

import { acknowledgementMayBeRequired } from "@/lib/studio/license";
import type { ProbeBaseModel } from "@/lib/studio/types";

/**
 * What the creator will be asked to accept, identified the way `base_models`
 * identifies it: the licence id, since the Hub's cards carry a revision only
 * rarely and `llama3.1` and `llama3.3` are already different documents.
 *
 * Null when the repository states no licence at all — there is nothing to
 * present, and the server will hold the listing for review rather than ask.
 */
export function acknowledgeableTerms(license: ProbeBaseModel["license"]): string | null {
  if (!license) return null;
  return license.id ?? license.name ?? null;
}

export function LicenseGateStep({
  acknowledged,
  isPublic,
  license,
  onAcknowledgedChange,
}: {
  acknowledged: boolean;
  isPublic: boolean;
  license: ProbeBaseModel["license"];
  onAcknowledgedChange: (next: boolean) => void;
}) {
  // Private is not gated, so saying anything here would be noise about a rule
  // that does not apply.
  if (!isPublic) return null;

  const hosting = license?.commercialHosting ?? "unknown";
  const terms = acknowledgeableTerms(license);

  if (acknowledgementMayBeRequired(hosting) && terms !== null) {
    return (
      <Alert status="warning">
        <Alert.Content>
          <Alert.Title>This licence allows commercial hosting with conditions</Alert.Title>
          <Alert.Description>
            <span className="flex flex-col gap-3">
              <span>
                <span className="font-mono">{terms}</span> permits a third party to serve these
                weights for money, subject to obligations that fall on you as well as on us —
                attribution, a derivative-naming rule, an acceptable-use policy, and in the Llama
                family a monthly-active-user threshold.
                {license?.url ? (
                  <>
                    {" "}
                    <a className="underline" href={license.url} rel="noreferrer" target="_blank">
                      Read the terms
                    </a>
                    .
                  </>
                ) : null}
              </span>
              <Checkbox isSelected={acknowledged} onChange={onAcknowledgedChange}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="text-sm">
                    I have read <span className="font-mono">{terms}</span> and accept its conditions
                    for serving this model commercially.
                  </span>
                </Checkbox.Content>
              </Checkbox>
              <span className="text-xs">
                Deploying without accepting is fine — the model is created, callable with your own
                API keys and billed to you, just not listed in the catalog.
              </span>
            </span>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  // Nothing to say about a permissive licence. Without this the fall-through
  // below tells the creator their apache-2.0 model is unclassified and will be
  // held for review, which is the opposite of true.
  if (hosting === "allowed") return null;

  if (hosting === "prohibited") {
    return (
      <Alert status="danger">
        <Alert.Content>
          <Alert.Title>This licence does not permit a public listing</Alert.Title>
          <Alert.Description>
            <span className="font-mono">{terms ?? "The licence on this repository"}</span> forbids a
            third party from serving these weights for money. The deployment goes ahead as a{" "}
            <strong>private</strong> model: callable with your own API keys, metered and billed to
            you at the prices you set. It will not appear in the marketplace.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  return (
    <Alert status="accent">
      <Alert.Content>
        <Alert.Title>This model&apos;s licence has to be established first</Alert.Title>
        <Alert.Description>
          {terms === null
            ? "This repository states no licence, and the base model it resolves to has none on record either."
            : `${terms} is not a licence this platform has classified.`}{" "}
          The deployment goes ahead as a <strong>private</strong> model and joins a review queue. It
          publishes by itself once the terms are established — you do not have to deploy it again.
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

/**
 * What the pipeline actually did, once it is finished.
 *
 * Shown on SUCCESS. A held listing is a working deployment that is not in the
 * catalog, so presenting it as a failure would be wrong twice over: the model
 * serves, and nothing the creator did was invalid.
 */
export function LicenseGateOutcomeAlert({
  hint,
  message,
}: {
  hint: string | null;
  message: string | null;
}) {
  if (message === null) return null;
  return (
    <Alert status="warning">
      <Alert.Content>
        <Alert.Title>Deployed, and not listed</Alert.Title>
        <Alert.Description>
          {message}
          {hint ? ` ${hint}` : ""}
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
