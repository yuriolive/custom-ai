"use client";

/**
 * "Which model is this?" — the confirm step of the resolution cascade (#25 §2).
 *
 * It renders in one of two modes, and which one is not a style choice:
 *
 *   DECLARED. The repository named its own parent, in its card data or in its
 *   GGUF header. That is an answer, so the creator is TOLD it, not asked. A
 *   confirmation dialog over a fact the repository already stated teaches people
 *   to click past the question, which is exactly the habit the other mode needs
 *   them not to have.
 *
 *   UNDECLARED. Nothing declared a parent, and an architecture fingerprint plus
 *   a normalized name have produced candidates. Both signals match a fine-tune
 *   against its parent perfectly — same layers, same heads, same vocab, and a
 *   name that contains the parent's — so neither may link on its own. Hence two
 *   options per candidate: these weights ARE that model, or they are DERIVED
 *   from it. Nothing is preselected, and leaving it unanswered is allowed: the
 *   listing stays its own card and is recorded as unresolved, which is honest,
 *   where a preselected default would be a grouping nobody read.
 */

import { Label, Radio, RadioGroup } from "@heroui/react";

import type { BaseModelChoice, ProbeBaseModel } from "@/lib/studio/types";

/** How many candidates are offered. Each contributes two options. */
const MAX_OFFERED = 3;

const HOSTING_NOTE: Record<NonNullable<ProbeBaseModel["license"]>["commercialHosting"], string> = {
  allowed: "Permissive — commercial hosting is allowed.",
  conditional: "Commercial hosting is allowed with conditions somebody has to read.",
  prohibited: "This licence does not permit a third party to serve these weights for money.",
  unknown: "Not a licence this platform recognises, so it counts as unknown.",
};

/** `existing:<uuid>` | `child:<uuid>` | `none` — and back. */
function encode(choice: BaseModelChoice): string {
  if (choice.kind === "existing") return `existing:${choice.baseModelId}`;
  if (choice.kind === "child") return `child:${choice.parentBaseModelId}`;
  return "none";
}

export function decodeBaseModelChoice(value: string | null): BaseModelChoice | null {
  if (value === null || value.length === 0) return null;
  if (value === "none") return { kind: "none" };
  const [kind, id] = value.split(":");
  if (!id) return null;
  if (kind === "existing") return { kind: "existing", baseModelId: id };
  if (kind === "child") return { kind: "child", parentBaseModelId: id };
  return null;
}

export function BaseModelStep({
  baseModel,
  onChange,
  value,
}: {
  baseModel: ProbeBaseModel;
  onChange: (next: string) => void;
  value: string | null;
}) {
  const license = baseModel.license;
  const licenceLine = license ? (
    <p className="text-muted text-sm">
      Licence: <span className="font-mono">{license.id ?? license.name ?? "unstated"}</span>.{" "}
      {HOSTING_NOTE[license.commercialHosting]}
      {license.url ? (
        <>
          {" "}
          <a className="underline" href={license.url} rel="noreferrer" target="_blank">
            Read the terms
          </a>
          .
        </>
      ) : null}
    </p>
  ) : (
    <p className="text-muted text-sm">
      This repository states no licence. The terms that apply are the base model&apos;s, and until
      one is established they count as unknown.
    </p>
  );

  if (baseModel.declared) {
    const { repoSlug, relation, source } = baseModel.declared;
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold tracking-tight">Which model this is</h2>
        <p className="text-sm">
          The repository declares <span className="font-mono">{repoSlug}</span> as its base model
          {relation ? ` (${relation})` : ""}, read from{" "}
          {source === "card_data" ? "its model card" : "the GGUF header"}. The catalog groups this
          listing accordingly — nothing to choose.
        </p>
        {licenceLine}
      </section>
    );
  }

  const offered = baseModel.suggestions.slice(0, MAX_OFFERED);
  if (offered.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold tracking-tight">Which model this is</h2>
        <p className="text-muted text-sm">
          This repository declares no base model, and nothing in the catalog resembles it. The
          listing will be its own entry.
        </p>
        {licenceLine}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">Which model this is</h2>
        <p className="text-muted text-sm">
          This repository does not say what it was built from. These candidates match on
          architecture and on name — and a fine-tune matches its parent on both — so this one is
          yours to answer. Leave it unanswered and the listing stands on its own.
        </p>
      </div>

      <RadioGroup aria-label="Which model this is" onChange={onChange} value={value ?? ""}>
        {offered.flatMap((candidate) => [
          <Radio
            key={`existing:${candidate.baseModelId}`}
            value={encode({ kind: "existing", baseModelId: candidate.baseModelId })}
          >
            <Radio.Content>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <Label>{candidate.displayName}</Label>
            </Radio.Content>
            <span data-slot="description">
              These are the same weights, repackaged. Groups under the existing{" "}
              <span className="font-mono">{candidate.slug}</span>.
            </span>
          </Radio>,
          <Radio
            key={`child:${candidate.baseModelId}`}
            value={encode({ kind: "child", parentBaseModelId: candidate.baseModelId })}
          >
            <Radio.Content>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <Label>A fine-tune of {candidate.displayName}</Label>
            </Radio.Content>
            <span data-slot="description">
              Its own model, with {candidate.displayName} as its parent — its output is not that
              model&apos;s output.
            </span>
          </Radio>,
        ])}
        <Radio value="none">
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <Label>Something else</Label>
          </Radio.Content>
          <span data-slot="description">A model of its own, with no parent in the catalog.</span>
        </Radio>
      </RadioGroup>

      {licenceLine}
    </section>
  );
}
