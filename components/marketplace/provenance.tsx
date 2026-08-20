"use client";

import { Chip } from "@heroui/react";

import { provenanceDescription, provenanceLabel } from "@/lib/marketplace/provenance";

/**
 * Who owns the upstream repository (GitHub #30).
 *
 * ── Why both states render ─────────────────────────────────────────────────
 * The tempting version shows a pill for `official` and nothing otherwise. It is
 * worse: absence still reads as a signal, but an unexplained one, and a shopper
 * scanning a grid infers the harshest available meaning for it. Naming the
 * neutral state out loud is what makes it neutral.
 *
 * ── Why it is not coloured ─────────────────────────────────────────────────
 * `color="default" variant="tertiary"` — the outline pill DESIGN.md §3.2
 * reserves for capabilities, identical in both states. Status colour on this
 * card is spent on live status and nothing else (§3.2's chip table), and a green
 * `official` beside a grey `third-party` would encode a health judgement the
 * platform has not made and cannot make: Hugging Face sign-in proves control of
 * an account, not authorship of weights. Same pill, different word, no hierarchy
 * of colour.
 *
 * The description reaches a screen reader through `<title>`-equivalent text
 * rather than `title` alone, because a `title` attribute is not announced by
 * every screen reader and is unreachable by touch. The visible label is short;
 * the sentence that qualifies it must not be visual-only.
 */
export function ProvenanceChip({ isOfficial }: Readonly<{ isOfficial: boolean }>) {
  const description = provenanceDescription(isOfficial);

  return (
    <Chip
      className="font-mono text-[0.6875rem] tracking-[0.04em]"
      color="default"
      size="sm"
      title={description}
      variant="tertiary"
    >
      {provenanceLabel(isOfficial)}
      <span className="sr-only"> — {description}</span>
    </Chip>
  );
}
