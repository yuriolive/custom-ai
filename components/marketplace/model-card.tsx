"use client";

import { Button, Card, Chip, Modal } from "@heroui/react";
import Link from "next/link";

import {
  formatContext,
  formatPricePerMtoken,
  formatSpeed,
  qualityChipColor,
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
      className="has-[a:focus-visible]:ring-accent relative flex h-full flex-col transition-shadow has-[a:focus-visible]:ring-2 hover:shadow-md"
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

      <Card.Content className="flex flex-wrap gap-2">
        <Chip
          color="accent"
          size="sm"
          title="Measured throughput from the post-deployment smoke test — not an estimate."
          variant="soft"
        >
          {formatSpeed(model.measuredTokensPerSecond)}
        </Chip>
        <Chip
          size="sm"
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
          color={qualityChipColor(model.qualityTier)}
          size="sm"
          title={`${qualityLabel(model.qualityTier)} — ${qualityNote(model.qualityTier)}`}
          variant="soft"
        >
          {qualityChipLabel(model.qualityTier)}
        </Chip>
        <Chip size="sm" title="Price per 1M input tokens" variant="secondary">
          {formatPricePerMtoken(model.pricePromptMicroPerMtoken)}/M in
        </Chip>
        <Chip size="sm" title="Price per 1M output tokens" variant="secondary">
          {formatPricePerMtoken(model.priceCompletionMicroPerMtoken)}/M out
        </Chip>
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
          className="text-muted hover:text-foreground focus-visible:ring-accent inline-flex h-8 items-center rounded-[calc(var(--radius)/1.5)] px-3 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
          href="/playground"
        >
          Try it →
        </Link>
      </Card.Footer>
    </Card>
  );
}
