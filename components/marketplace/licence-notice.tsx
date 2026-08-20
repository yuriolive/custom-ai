"use client";

import { Alert, Chip } from "@heroui/react";

import {
  licenceLabel,
  licenceObligations,
  licencePostureLabel,
  licencePostureNote,
} from "./licence";
import type { BaseModelInfo } from "./types";

/**
 * The licence notice a model owes its upstream (§5.1).
 *
 * ── Why this is content and not a checkbox ──────────────────────────────────
 * A checkbox that acknowledges an obligation the UI then fails to discharge is
 * worse than no checkbox, because it documents that we knew. If the platform
 * records that a creator accepted the Llama community licence and then serves the
 * model on a page that never displays "Built with Llama", the record is evidence
 * against us, not protection. So the attribution string is RENDERED — visibly, on
 * the page that makes the weights available — and the conditions that pass
 * through to a caller are spelled out beside it.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * It is not the GATE. Whether an `unknown` or `prohibited` licence may be
 * published at all is #29's decision and lives on the write path. This section
 * reports what the columns say, including when what they say is "nobody has
 * checked" — which is the honest reading of `unknown` and the one a developer
 * choosing weights for a commercial product actually needs.
 *
 * It is also not legal advice, and the copy never implies it is. Every notice
 * points at the licence text as the authority: a developer who relies on our
 * paraphrase is worse off than one we sent to the source.
 *
 * Rendered for EVERY model with a licence posture, not only for `conditional`.
 * Showing the section only when something is owed makes its absence ambiguous —
 * a permissive licence and an unread one would both render as nothing, and they
 * are opposite facts.
 */
export function LicenceNotice({ model }: { model: BaseModelInfo }) {
  const obligations = licenceObligations(model);
  const label = licenceLabel(model);

  return (
    <section aria-labelledby="licence" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold" id="licence">
          Licence
        </h2>
        {/* Soft chip, no status colour. The four postures are not a severity
            ladder — `prohibited` is a fact about the weights, not an error the
            reader caused — and colouring them would make `unknown` look safe
            or `conditional` look broken. */}
        <Chip size="sm" variant="soft">
          {licencePostureLabel(model.commercialHosting)}
        </Chip>
      </div>

      <p className="text-muted max-w-3xl text-sm">{licencePostureNote(model.commercialHosting)}</p>

      {/* THE ATTRIBUTION, discharged rather than promised. Its own line, at the
          page's text size rather than in muted small print, because the licence
          asks for it prominently and a notice tucked into a footnote is a notice
          we can be said to have hidden. */}
      {obligations?.attribution ? (
        <p className="text-base font-medium">{obligations.attribution}</p>
      ) : null}

      {obligations && obligations.passThrough.length > 0 ? (
        <Alert status="default">
          <Alert.Content>
            <Alert.Title>What this licence asks of you</Alert.Title>
            <Alert.Description>
              <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm">
                {obligations.passThrough.map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {/* The derivative-naming rule is called out as its own item
                    rather than folded into the list above, because it is the
                    obligation a fine-tuner breaks by accident: it binds the NAME
                    of a model that does not exist yet, so nothing in the deploy
                    flow will ever prompt for it. */}
                {obligations.derivativeNaming ? (
                  <li className="font-medium">{obligations.derivativeNaming}</li>
                ) : null}
              </ul>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {label ? (
        <p className="text-muted text-sm">
          {model.licenseUrl ? (
            <>
              {/* An external anchor, not a `Link`: the licence text is the
                  authority and it does not live here. `rel="noreferrer"` because
                  a licence host has no business knowing which model page sent
                  the reader. */}
              <a
                className="text-accent hover:underline"
                href={model.licenseUrl}
                rel="noreferrer"
                target="_blank"
              >
                {label}
              </a>{" "}
              — the licence text, which is what governs.
            </>
          ) : (
            <>{label} — the platform holds no link to this licence&rsquo;s text.</>
          )}
        </p>
      ) : (
        <p className="text-muted text-sm">
          No licence has been recorded for these weights. Check the upstream repository.
        </p>
      )}
    </section>
  );
}
