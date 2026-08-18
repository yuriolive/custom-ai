"use client";

import { Button, Card, Chip, Modal } from "@heroui/react";
import Link from "next/link";

import {
  formatContext,
  formatPricePerMtoken,
  formatSpeed,
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
        <Card.Title className="text-sm">
          <Link
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            href={href}
          >
            <span className="font-mono break-all">
              {model.creatorHandle}/{model.slug}
            </span>
          </Link>
        </Card.Title>
        <Card.Description className="line-clamp-2">
          {model.description ?? model.displayName}
        </Card.Description>
      </Card.Header>

      {/* Every figure here is mono and tabular-nums, so a column of cards lines
          its numbers up instead of shimmering as digit widths change. Exactly one
          chip in this row is accent-coloured — the measured figure that is the
          card's headline. The rest carry their meaning in the label.

          The row lives in its own div rather than on `Card.Content`. HeroUI ships
          `.card__content` as unlayered CSS with `flex-direction: column`, and
          unlayered rules outrank Tailwind's `@layer utilities`, so a `flex-row`
          utility on the slot loses and the chips stack one per line. Nesting
          sidesteps the cascade fight instead of reaching for `!important`. */}
      <Card.Content>
        <div className="flex flex-wrap gap-2">
          <Chip
            className="font-mono tabular-nums"
            color="accent"
            title="Measured throughput from the post-deployment smoke test — not an estimate."
            variant="soft"
          >
            {formatSpeed(model.measuredTokensPerSecond)}
          </Chip>
          <Chip
            className="font-mono tabular-nums"
            title={
              model.contextVerified
                ? "Context window, verified against the running worker."
                : "Context window as configured by the creator."
            }
            variant="soft"
          >
            {formatContext(model.contextLength)} context
          </Chip>
          <Chip
            className="font-mono"
            title={`${qualityLabel(model.qualityTier)} — ${qualityNote(model.qualityTier)}`}
            variant="soft"
          >
            {qualityChipLabel(model.qualityTier)}
          </Chip>
          <Chip
            className="font-mono tabular-nums"
            title="Price per 1M input tokens"
            variant="secondary"
          >
            {formatPricePerMtoken(model.pricePromptMicroPerMtoken)}/M in
          </Chip>
          <Chip
            className="font-mono tabular-nums"
            title="Price per 1M output tokens"
            variant="secondary"
          >
            {formatPricePerMtoken(model.priceCompletionMicroPerMtoken)}/M out
          </Chip>
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
