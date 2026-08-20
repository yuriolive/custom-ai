"use client";

import { Button, Card, Chip, Modal, Separator } from "@heroui/react";
import Link from "next/link";

import { formatCreditValue } from "@/lib/format";

import { CopyModelId } from "./copy-model-id";
import {
  categoryLabel,
  formatContext,
  formatListingCount,
  formatPricePerMtoken,
  formatServedBy,
  formatSpeedValue,
  qualityChipLabel,
  qualityLabel,
  qualityNote,
  weightsPublisher,
} from "./format";
import { modelHref } from "./routes";
import { SnippetTabs } from "./snippet-tabs";
import type { CatalogGroup } from "./types";

/**
 * ONE CATALOG CARD, and it is a MODEL (#26).
 *
 * It used to be a deployment, which is what made six quantizations of Qwen3-8B
 * six unrelated cards. The card now speaks for a group of listings, and the whole
 * design problem is that a group has no single price, speed or context — so every
 * aggregate on it is a BEST CASE and every one is labelled as such. An unlabelled
 * max reads as a promise the median listing does not keep, which is worse than
 * showing nothing.
 *
 * Three kinds of number appear here and they are visually separated on purpose:
 *
 *  - `BEST TOK/S` / `MAX CONTEXT` — the best any matching listing achieves.
 *  - `FROM /1M OUT` — the cheapest matching listing's completion price.
 *  - the price table below the rule — BOTH prices of that same cheapest
 *    listing, which is the listing this card links to and copies. So the `from`
 *    figure is a price the visitor can actually pay on the page the card opens,
 *    rather than a min-of-each-column pair that no listing offers.
 *
 * THE PROVENANCE LINE is not decoration. Without "weights by qwen · served by
 * alice", a creator who did nothing but run a deploy reads as the author of the
 * model — and after grouping that misreading is worse, because the card is now
 * titled with the model's name rather than the creator's slug.
 *
 * NO HARDWARE APPEARS HERE, and there is no prop through which it could:
 * `CatalogGroup` has no GPU field at all (types.ts). Speed is measured
 * throughput from the smoke test (FR-DEP-052), never the solver's prediction.
 *
 * ACCESSIBILITY — the whole card is one keyboard stop. The title holds the only
 * navigation link and its `after:absolute after:inset-0` pseudo-element stretches
 * the hit area over the card; the copy button and the footer sit in a
 * `relative z-10` layer above it so they stay independently clickable without
 * being nested inside an anchor (invalid HTML, and unreachable by keyboard).
 */
export function GroupCard({ group, baseUrl }: { group: CatalogGroup; baseUrl: string }) {
  const href = modelHref(group.creatorHandle, group.slug);
  const publisher = weightsPublisher(group.baseSlug);

  return (
    <Card
      // Colour-only hover. Elevation comes from the background step and the
      // `--surface-shadow` hairline, never from a drop shadow (DESIGN.md §3.2).
      className="has-[a:focus-visible]:ring-accent hover:bg-surface-secondary relative flex h-full flex-col transition-colors has-[a:focus-visible]:ring-2"
      render={(props) => <article {...props} />}
    >
      <Card.Header>
        {/* Nested row rather than a `flex-row` utility on `Card.Header` itself:
            HeroUI ships `.card__header` as unlayered CSS with
            `flex-direction: column`, and unlayered rules outrank Tailwind's
            `@layer utilities`, so the utility loses. Same cascade fight as
            `.card__content` below — nesting sidesteps it instead of reaching for
            `!important`. */}
        <div className="flex items-start gap-2">
          <Card.Title className="min-w-0 flex-1 text-sm">
            <Link
              className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              href={href}
            >
              {/* The MODEL's name, not the listing slug. `break-words`, not
                  `break-all`: this is prose now, and mid-word breaks in a
                  display name read as corruption rather than as an identifier. */}
              <span className="break-words">{group.displayName}</span>
            </Link>
          </Card.Title>
          {/* `N listings` is the card's one structural fact and belongs beside
              the title, where it explains why the figures below are ranges. */}
          <span className="text-muted shrink-0 text-xs tabular-nums">
            {formatListingCount(group.listingCount)}
          </span>
        </div>

        {/* THE PROVENANCE LINE. Two clauses, and the first is omitted rather
            than guessed: until #25's cascade resolves a base model the platform
            genuinely does not know who published the weights, and inventing a
            publisher from the creator's handle would print the exact claim this
            line exists to prevent. */}
        <p className="text-muted text-xs">
          {publisher ? (
            <>
              weights by <span className="text-foreground">{publisher}</span>
              {" · "}
            </>
          ) : null}
          served by{" "}
          <span className="text-foreground">
            {formatServedBy(group.creatorHandle, group.creatorCount)}
          </span>
        </p>

        <Card.Description className="line-clamp-2">
          {group.description ?? group.displayName}
        </Card.Description>
      </Card.Header>

      <Card.Content>
        {/* Nested for the cascade reason above: `.card__content` is pinned to
            `flex-direction: column` with `gap-1` by unlayered CSS. */}
        <div className="flex flex-col gap-4">
          {/* The headline trio. Three columns rather than two because the `from`
              price is the third thing a shopper compares down a column of cards,
              and burying it below the rule made two cards at the same speed look
              identical. Each LABEL carries the qualifier — `BEST`, `MAX`,
              `FROM` — because the figure alone would over-promise. */}
          <dl className="grid grid-cols-3 gap-2">
            <Figure
              hint="The fastest of this model's listings — measured by the post-deployment smoke test, not estimated. Slower listings of the same model exist."
              label="best tok/s"
              value={formatSpeedValue(group.bestTokensPerSecond)}
            />
            <Figure
              hint={
                group.bestContextVerified
                  ? "The largest context window any listing of this model offers, verified against the running worker."
                  : "The largest context window any listing of this model offers, as configured by its creator."
              }
              label="max context"
              value={formatContext(group.bestContextLength)}
            />
            <Figure
              hint="The cheapest listing's price per 1M output tokens. Other listings of this model cost more."
              label="from /1M out"
              value={formatPricePerMtoken(group.fromPriceCompletionMicroPerMtoken)}
            />
          </dl>

          {/* What the model is FOR, from the base model's closed `use_cases`
              vocabulary — the same values the counted tabs above the grid filter
              on, so a chip and a tab always agree. Outline pills, visually
              distinct from the soft quality chip beside them: the soft one is a
              judgement about the artifact, the outline ones are what it accepts
              (DESIGN.md §3.2). */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              className="font-mono"
              size="sm"
              title={`${qualityLabel(group.qualityTier)} — ${qualityNote(group.qualityTier)}`}
              variant="soft"
            >
              {qualityChipLabel(group.qualityTier)}
            </Chip>
            {group.categories.slice(0, CATEGORY_CHIP_LIMIT).map((category) => (
              <Chip className={CATEGORY_CHIP} key={category} size="sm" variant="tertiary">
                {categoryLabel(category)}
              </Chip>
            ))}
            {group.categories.length > CATEGORY_CHIP_LIMIT ? (
              <Chip
                className={CATEGORY_CHIP}
                size="sm"
                title={group.categories.slice(CATEGORY_CHIP_LIMIT).map(categoryLabel).join(", ")}
                variant="tertiary"
              >
                +{group.categories.length - CATEGORY_CHIP_LIMIT}
              </Chip>
            ) : null}
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            {/* The eyebrow names WHICH listing the table is about. Without it
                the two rows read as the model's price, and the model does not
                have one. */}
            <p className="text-muted text-[0.6875rem] font-medium tracking-[0.08em] uppercase">
              {group.listingCount > 1 ? "Cheapest listing · per 1M" : "Per 1M tokens"}
            </p>
            <dl className="flex flex-col gap-1 text-sm">
              <PriceRow
                label="Input"
                value={formatPricePerMtoken(group.fromPricePromptMicroPerMtoken)}
              />
              <PriceRow
                label="Output"
                value={formatPricePerMtoken(group.fromPriceCompletionMicroPerMtoken)}
              />
            </dl>
            {/* The value footer. A per-token price is not a number anyone holds
                in their head; "what does a fiver buy" is. Computed from the two
                integer micro-USD prices of the quoted listing, floored, so it
                never promises tokens a balance cannot pay for. */}
            <p className="text-muted text-xs tabular-nums">
              {formatCreditValue(
                group.fromPricePromptMicroPerMtoken,
                group.fromPriceCompletionMicroPerMtoken,
              )}
            </p>
          </div>

          {/* The callable id, and it is the QUOTED LISTING's — not the model
              name above and not `base_slug`, neither of which resolves. It sits
              here rather than in the title row because after grouping the title
              is a model name, and a card whose most prominent line is not the
              thing you paste is a card that teaches the wrong id. */}
          <div className="flex items-center gap-2">
            <code className="text-muted min-w-0 flex-1 font-mono text-xs break-all">
              {group.modelId}
            </code>
            <CopyModelId modelId={group.modelId} />
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
                    {group.modelId}
                  </Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <SnippetTabs baseUrl={baseUrl} modelId={group.modelId} />
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
            /playground/[creator]/[slug] route is deferred and owned elsewhere. */}
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
 * The outline for a category chip.
 *
 * `variant="tertiary"` on a HeroUI Chip sets `--chip-bg: transparent` and
 * nothing else, so on its own it renders as loose text rather than as a pill —
 * which is not the outline-versus-soft distinction DESIGN.md §3.2 asks for, and
 * it is that distinction doing the work here: the soft chip is a JUDGEMENT about
 * the artifact (its quality tier), the outline chips are WHAT IT IS FOR. Without
 * a border they read as one undifferentiated row of words.
 *
 * The label is deliberately NOT uppercased into `font-mono` the way §3.2 spells
 * the capability chips. These labels are the same strings as the counted tabs
 * above the grid, and the point of that is that a chip and a tab visibly refer to
 * the same thing; recasing one half breaks the correspondence to buy nothing.
 */
const CATEGORY_CHIP = "border-border border";

/**
 * How many category chips render before the overflow counter.
 *
 * Three, because the card is 1-of-3 in the grid and the chip row shares its line
 * with the quality chip: a fourth pushes to a second line at every breakpoint,
 * and a model can legitimately declare six use cases.
 */
const CATEGORY_CHIP_LIMIT = 3;

/**
 * One headline figure: mono value over a small tracked uppercase unit.
 *
 * A `<dt>`/`<dd>` pair inside the `<dl>`, so the unit and its value are a real
 * term/definition to a screen reader. The visual order is value-then-label but
 * the markup order must stay `dt` before `dd`, so `flex-col-reverse` flips the
 * paint order without a second DOM node.
 */
function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-0.5" title={hint}>
      <dt className="text-muted text-[0.625rem] font-medium tracking-[0.06em] uppercase">
        {label}
      </dt>
      {/* `text-lg`, not `text-xl`: three columns at 375px leave roughly 100px
          each, and `break-all` is what keeps a long figure wrapping inside its
          column instead of pushing the card into horizontal scroll. */}
      <dd className="font-mono text-lg leading-none font-semibold break-all tabular-nums">
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
