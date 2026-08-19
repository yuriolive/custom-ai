"use client";

import { Button, Card, Chip, Modal, Separator } from "@heroui/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatCreditValue } from "@/lib/format";

import {
  formatContext,
  formatPricePerMtoken,
  formatSpeedValue,
  qualityChipLabel,
  qualityLabel,
  qualityNote,
} from "./format";
import { modelHref } from "./routes";
import { SnippetTabs } from "./snippet-tabs";
import type { CatalogModel } from "./types";

/**
 * One catalog entry (FR-MKT-001/002).
 *
 * NO HARDWARE APPEARS HERE, and there is no prop through which it could: the
 * `CatalogModel` type has no GPU field at all (types.ts). Speed is
 * `measuredTokensPerSecond` — the smoke-tested truth (FR-DEP-052), never the
 * solver's prediction.
 *
 * ACCESSIBILITY — the whole card is one keyboard stop, not a small link buried
 * in a corner. The title holds the only navigation link, and that link's
 * `after:absolute after:inset-0` pseudo-element stretches its hit area over the
 * entire card. The footer controls sit in a `relative z-10` layer above it, so
 * they stay independently clickable without being nested inside an anchor
 * (which would be invalid HTML and unreachable by keyboard). `group-has-focus`
 * moves the focus ring to the card, so tabbing is visible.
 *
 * The copy-id button in the title row joins that same `relative z-10` layer for
 * exactly the same reason: it sits physically inside the stretched anchor's hit
 * area, so without the stacking context it would be unclickable — and it must
 * not be nested inside the link.
 *
 * READING ORDER (UI-REDESIGN-PLAN §6): identity → description → the two
 * measured figures → what it costs → what that cost buys → how to call it.
 * Every figure a reader compares down a column of cards is
 * `font-mono tabular-nums`, so the columns line up instead of shimmering as
 * digit widths change.
 */
export function ModelCard({ model, baseUrl }: { model: CatalogModel; baseUrl: string }) {
  const href = modelHref(model.creatorHandle, model.slug);

  return (
    <Card
      // Colour-only hover. `hover:shadow-md` used to live here and was the only
      // drop shadow in the app; it also fought the hairline that `--surface-shadow`
      // now carries, since both land in the same box-shadow slot. Elevation comes
      // from the background step and that hairline, never from a shadow.
      className="has-[a:focus-visible]:ring-accent hover:bg-surface-secondary relative flex h-full flex-col transition-colors has-[a:focus-visible]:ring-2"
      render={(props) => <article {...props} />}
    >
      <Card.Header>
        {/* Nested row rather than a `flex-row` utility on `Card.Header` itself:
            HeroUI ships `.card__header` as unlayered CSS with
            `flex-direction: column`, and unlayered rules outrank Tailwind's
            `@layer utilities`, so the utility loses. Same cascade fight as
            `.card__content` below — nesting sidesteps it instead of reaching
            for `!important`. */}
        <div className="flex items-start gap-2">
          <Card.Title className="min-w-0 flex-1 text-sm">
            <Link
              className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              href={href}
            >
              <span className="font-mono break-all">
                {model.creatorHandle}/{model.slug}
              </span>
            </Link>
          </Card.Title>
          <CopyModelId modelId={model.modelId} />
        </div>

        <Card.Description className="line-clamp-2">
          {model.description ?? model.displayName}
        </Card.Description>
      </Card.Header>

      <Card.Content>
        {/* Nested for the cascade reason above: `.card__content` is pinned to
            `flex-direction: column` with `gap-1` by unlayered CSS. */}
        <div className="flex flex-col gap-4">
          {/* The headline pair. These were two chips, and a chip is the wrong
              container for the numbers a shopper is actually comparing: it sets
              them at label size inside a pill that says nothing. Large mono
              figure, small tracked uppercase unit beneath. */}
          <dl className="grid grid-cols-2 gap-3">
            <Figure
              hint="Measured throughput from the post-deployment smoke test — not an estimate."
              label="tok/s"
              value={formatSpeedValue(model.measuredTokensPerSecond)}
            />
            <Figure
              hint={
                model.contextVerified
                  ? "Context window, verified against the running worker."
                  : "Context window as configured by the creator."
              }
              label="context"
              value={formatContext(model.contextLength)}
            />
          </dl>

          {/* Quality survives as the card's one chip. It is a judgement about
              the artifact rather than a figure to compare, so it does not belong
              in the figure pair — and it carries its meaning entirely in the
              label, never in a status colour (see `qualityChipLabel`). */}
          <div>
            <Chip
              className="font-mono"
              size="sm"
              title={`${qualityLabel(model.qualityTier)} — ${qualityNote(model.qualityTier)}`}
              variant="soft"
            >
              {qualityChipLabel(model.qualityTier)}
            </Chip>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <p className="text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
              Per 1M tokens
            </p>
            <dl className="flex flex-col gap-1 text-sm">
              <PriceRow
                label="Input"
                value={formatPricePerMtoken(model.pricePromptMicroPerMtoken)}
              />
              <PriceRow
                label="Output"
                value={formatPricePerMtoken(model.priceCompletionMicroPerMtoken)}
              />
            </dl>
            {/* The value footer. A per-token price is not a number anyone holds
                in their head; "what does a fiver buy" is. Computed from the two
                integer micro-USD prices in `format.ts`, floored, so it never
                promises tokens a balance cannot pay for. */}
            <p className="text-muted text-xs tabular-nums">
              {formatCreditValue(
                model.pricePromptMicroPerMtoken,
                model.priceCompletionMicroPerMtoken,
              )}
            </p>
          </div>
        </div>
      </Card.Content>

      <Card.Footer className="relative z-10 mt-auto flex-wrap gap-2">
        <Modal>
          <Button size="sm" variant="secondary">
            Code
          </Button>
          <Modal.Backdrop>
            <Modal.Container size="lg">
              <Modal.Dialog>
                <Modal.CloseTrigger />
                <Modal.Header>
                  <Modal.Heading className="font-mono text-sm break-all">
                    {model.modelId}
                  </Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <SnippetTabs baseUrl={baseUrl} modelId={model.modelId} />
                </Modal.Body>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>

        {/* A plain anchor, not a <Button>: HeroUI v3's Button is a React Aria
            <button> and takes no href, and wrapping a Button in a Link nests two
            interactive elements. Styled to match a tertiary Button.

            MVP-0 COUPLING: /playground serves one model, fixed by
            NEXT_PUBLIC_DEFAULT_MODEL, because the PRD's
            /playground/[creator]/[slug] route is deferred and owned elsewhere.
            With exactly one public model that is correct today; when a second
            one lands, this link needs the dynamic playground route. */}
        <Link
          className="text-muted hover:text-foreground focus-visible:ring-accent inline-flex h-8 items-center rounded-field px-3 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
          href="/playground"
        >
          Try it →
        </Link>
      </Card.Footer>
    </Card>
  );
}

/**
 * One headline figure: large mono value over a small tracked uppercase unit.
 *
 * A `<dt>`/`<dd>` pair inside the `<dl>`, so the unit and its value are a real
 * term/definition to a screen reader. The visual order is value-then-label but
 * the markup order must stay `dt` before `dd`, so `flex-col-reverse` flips the
 * paint order without a second DOM node.
 */
function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col-reverse gap-0.5" title={hint}>
      <dt className="text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </dt>
      {/* `break-all` is deliberate: at 375px this column is roughly 130px wide,
          and a long figure must wrap rather than push the card into horizontal
          scroll. */}
      <dd className="font-mono text-xl leading-none font-semibold break-all tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/** One row of the price table: label left, figure right, baselines aligned. */
function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
        {label}
      </dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Copy the platform model id.
 *
 * The highest-frequency action on a catalog card, and until now it required
 * selecting mono text that is deliberately `break-all` across two lines. What
 * lands on the clipboard is `model.modelId` — the platform id, NOT the Hugging
 * Face repo path (CONTRACTS.md); pasting the latter is a 404 and the single
 * most likely reason a copied snippet fails.
 *
 * Confirmation is inline and announced, matching `code-block.tsx`: HeroUI v3's
 * Toast needs a region mounted in the root layout, which this component does
 * not own, and a purely visual state change on the pressed control is invisible
 * to a screen-reader user.
 */
function CopyModelId({ modelId }: { modelId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      // navigator.clipboard is undefined on a non-secure origin and rejects
      // when the document is not focused. Both are reported, not swallowed — a
      // copy button that silently does nothing is worse than no button.
      await navigator.clipboard.writeText(modelId);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2_500);
  }, [modelId]);

  let copyLabel = "Copy id";
  if (state === "copied") copyLabel = "Copied";
  else if (state === "failed") copyLabel = "Failed";

  let announcement = "";
  if (state === "copied") announcement = `${modelId} copied to the clipboard`;
  else if (state === "failed") {
    announcement = "Copy failed. Select the model id and copy it manually.";
  }

  return (
    // `relative z-10` lifts the control out from under the title link's
    // stretched `::after`; `shrink-0` stops a long id squeezing it to nothing
    // at 375px.
    <span className="relative z-10 shrink-0">
      <Button
        aria-label={`Copy the model id ${modelId}`}
        onPress={copy}
        size="sm"
        variant={state === "copied" ? "primary" : "ghost"}
      >
        {copyLabel}
      </Button>
      <span aria-live="polite" className="sr-only" role="status">
        {announcement}
      </span>
    </span>
  );
}
